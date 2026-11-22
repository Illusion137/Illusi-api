import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Tx } from '../../db';
import {
	illusi_id_redirects_table, review_items_table, service_id_conflicts_table, service_ids_table
} from '../../db/schema';
import { write_audit } from '../../core/audit';
import { logger } from '../../core/log';
import { resolve_redirects } from '../../core/redirects';
import { add_review_item } from '../../core/review';
import type { ProposedValue } from '../../core/review';
import { SERVICE_ID_COLUMNS, UNIQUE_SERVICE_ID_COLUMNS } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';
import { merge_entity_row, plan_ref_merge, REF_TABLES } from './composite';
import type { Row } from './composite';
import { plan_signature, review_steps } from './resolve';
import type { ConflictResolution, EntityKind, GroupPlan, MergeStep, MoveStep, PlanStep, SplitStep } from './types';

const log = logger('reconcile');

export const ENTITY_TABLES: Record<Exclude<EntityKind, 'unknown'>, string> = {
	track: 'tracks_table',
	album: 'albums_table',
	artist: 'artists_table'
};

export interface ApplyContext {
	actor: 'reconcile' | 'admin';
	actor_user_id?: string | null;
	review_item_id?: number | null;
}

export interface StepResult {
	step: PlanStep;
	applied: boolean;
	skipped?: string;
	/** For splits: the new entity's id. */
	new_id?: string;
}

const id = (name: string) => sql.identifier(name);
const where_key = (key: Row) => sql.join(Object.entries(key).map(([k, v]) => sql`${id(k)} = ${v}`), sql` and `);
const set_clause = (set: Row) => sql.join(Object.entries(set).map(([k, v]) => sql`${id(k)} = ${v}`), sql`, `);

async function rows_of(tx: Tx, table: string, column: string, values: readonly unknown[]): Promise<Row[]> {
	if (values.length === 0) return [];
	return tx.execute<Row>(sql`select * from ${id(table)} where ${id(column)} in (${sql.join(values.map(v => sql`${v}`), sql`, `)})`, 'objects');
}

async function run(tx: Tx, query: SQL) {
	await tx.execute(query, 'objects');
}

async function lock_service_ids(tx: Tx, illusi_id: string) {
	const [row] = await tx.select().from(service_ids_table).where(eq(service_ids_table.illusi_id, illusi_id)).for('update');
	return row as (typeof row | undefined);
}

type IdRow = Partial<Record<ServiceIdColumn, string | number | null>>;

function id_values(row: IdRow): Partial<Record<ServiceIdColumn, string>> {
	const out: Partial<Record<ServiceIdColumn, string>> = {};
	for (const c of SERVICE_ID_COLUMNS) if (row[c] != null) out[c] = String(row[c]);
	return out;
}

/** Converts stringified ids back to column types for writing. */
function to_column_values(values: Partial<Record<ServiceIdColumn, string | null>>): Record<string, string | number | null> {
	const out: Record<string, string | number | null> = {};
	for (const [c, v] of Object.entries(values)) out[c] = v == null ? null : c === 'soundcloud_id' || c === 'genius_id' ? Number(v) : v;
	return out;
}

async function entity_kind(tx: Tx, illusi_id: string): Promise<EntityKind> {
	for (const [kind, table] of Object.entries(ENTITY_TABLES) as [Exclude<EntityKind, 'unknown'>, string][]) {
		const rows = await rows_of(tx, table, 'id', [illusi_id]);
		if (rows.length > 0) return kind;
	}
	return 'unknown';
}

/**
 * Merges `loser` into `survivor` inside the caller's transaction: repoints every
 * referencing row (merging composite-key collisions), rewrites and adds redirects, merges the
 * entity and `service_ids_table` rows, deletes the loser, and writes the audit log with undo data.
 */
export async function apply_merge(tx: Tx, step: MergeStep, ctx: ApplyContext): Promise<StepResult> {
	const resolved = await resolve_redirects(tx, [step.survivor, step.loser]);
	const survivor = resolved.get(step.survivor)!;
	const loser = resolved.get(step.loser)!;
	if (survivor === loser) return { step, applied: false, skipped: 'already_merged' };

	// Lock in a stable order to avoid deadlocks with a concurrent merge of the same pair.
	const [first, second] = [survivor, loser].sort();
	const locked = new Map([[first, await lock_service_ids(tx, first)], [second, await lock_service_ids(tx, second)]]);
	const s_ids = locked.get(survivor);
	const l_ids = locked.get(loser);
	if (!s_ids || !l_ids) return { step, applied: false, skipped: 'missing_row' };

	const kind = await entity_kind(tx, survivor);
	const loser_kind = await entity_kind(tx, loser);
	if (kind !== loser_kind) return { step, applied: false, skipped: `kind_mismatch:${kind}/${loser_kind}` };

	const dropped: Partial<Record<ServiceIdColumn, string>> = {};
	for (const c of UNIQUE_SERVICE_ID_COLUMNS) {
		if (s_ids[c] != null && l_ids[c] != null && String(s_ids[c]) !== String(l_ids[c])) dropped[c] = String(l_ids[c]);
	}
	if (Object.keys(dropped).length > 0 && ctx.actor === 'reconcile') return { step, applied: false, skipped: 'different_ids' };

	const undo_tables: Record<string, { repointed: Row[]; deleted: Row[]; updated: { key: Row; before: Row }[] }[]> = {};
	const now = new Date();
	if (kind !== 'unknown') {
		for (const spec of REF_TABLES[kind]) {
			const rows = await rows_of(tx, spec.table, spec.ref_col, [survivor, loser]);
			const plan = plan_ref_merge(spec, survivor, loser, rows);
			for (const r of plan.delete) await run(tx, sql`delete from ${id(spec.table)} where ${where_key(Object.fromEntries(spec.pk.map(c => [c, r[c]])))}`);
			for (const u of plan.update) {
				const set = spec.has_modified_at ? { ...u.set, modified_at: now } : u.set;
				await run(tx, sql`update ${id(spec.table)} set ${set_clause(set)} where ${where_key(u.key)}`);
			}
			if (plan.repoint.length > 0) {
				const set: Row = spec.has_modified_at ? { [spec.ref_col]: survivor, modified_at: now } : { [spec.ref_col]: survivor };
				await run(tx, sql`update ${id(spec.table)} set ${set_clause(set)} where ${id(spec.ref_col)} = ${loser}`);
			}
			if (plan.delete.length + plan.update.length + plan.repoint.length > 0) {
				(undo_tables[spec.table] ??= []).push({
					repointed: plan.repoint.map(r => Object.fromEntries(spec.pk.map(c => [c, r[c]]))),
					deleted: plan.delete,
					updated: plan.update.map(u => ({ key: u.key, before: Object.fromEntries(Object.keys(u.set).map(k => [k, u.before[k]])) }))
				});
			}
		}
	}

	// Conflict records follow the entity; the ones now linking the survivor to itself are settled.
	await tx.update(service_id_conflicts_table).set({ illusi_id: survivor }).where(eq(service_id_conflicts_table.illusi_id, loser));
	await tx.update(service_id_conflicts_table).set({ other_illusi_id: survivor }).where(eq(service_id_conflicts_table.other_illusi_id, loser));
	await tx.update(service_id_conflicts_table).set({ status: 'merged' }).where(and(
		eq(service_id_conflicts_table.illusi_id, survivor),
		eq(service_id_conflicts_table.other_illusi_id, survivor),
		inArray(service_id_conflicts_table.status, ['open', 'deferred'])
	));

	const rewritten = await tx.update(illusi_id_redirects_table).set({ new_id: survivor })
		.where(eq(illusi_id_redirects_table.new_id, loser)).returning({ old_id: illusi_id_redirects_table.old_id });

	let entity_before: Row | null = null;
	let loser_entity: Row | null = null;
	if (kind !== 'unknown') {
		const table = ENTITY_TABLES[kind];
		const [s_row] = await rows_of(tx, table, 'id', [survivor]);
		[loser_entity] = await rows_of(tx, table, 'id', [loser]);
		const set = merge_entity_row(s_row, loser_entity);
		entity_before = Object.fromEntries(Object.keys(set).map(k => [k, s_row[k]]));
		await run(tx, sql`update ${id(table)} set ${set_clause({ ...set, modified_at: now })} where id = ${survivor}`);
		await run(tx, sql`delete from ${id(table)} where id = ${loser}`);
	}

	const fill: Partial<Record<ServiceIdColumn, string>> = {};
	const loser_values = id_values(l_ids);
	for (const [c, v] of Object.entries(loser_values) as [ServiceIdColumn, string][]) if (s_ids[c] == null) fill[c] = v;
	await tx.delete(service_ids_table).where(eq(service_ids_table.illusi_id, loser));
	await tx.update(service_ids_table).set({ ...to_column_values(fill), modified_at: now }).where(eq(service_ids_table.illusi_id, survivor));
	await tx.insert(illusi_id_redirects_table).values({ old_id: loser, new_id: survivor })
		.onConflictDoUpdate({ target: illusi_id_redirects_table.old_id, set: { new_id: survivor } });

	const entity_table = kind === 'unknown' ? 'service_ids_table' : ENTITY_TABLES[kind];
	await write_audit(tx, {
		action: 'merge',
		actor: ctx.actor,
		actor_user_id: ctx.actor_user_id,
		entity_table,
		entity_id: survivor,
		details: { survivor, loser, kind, reasons: step.reasons, confidence: step.confidence, filled: fill, dropped, review_item_id: ctx.review_item_id ?? null },
		undo: {
			loser_service_ids: { ...l_ids, created_at: l_ids.created_at, modified_at: l_ids.modified_at },
			survivor_service_ids_filled: Object.keys(fill),
			loser_entity,
			survivor_entity_before: entity_before,
			redirects_rewritten: rewritten.map(r => r.old_id),
			redirect_added: loser,
			tables: undo_tables
		}
	});
	// A merge on hard evidence (a shared unique id) needs nobody's eyes; one only implied through others gets a look.
	if (ctx.actor === 'reconcile' && step.reasons.includes('transitive')) {
		await add_review_item(tx, {
			kind: 'AUTO_MERGE',
			entity_table,
			entity_id: survivor,
			proposed_value: { loser },
			details: { survivor, loser, reasons: step.reasons, confidence: step.confidence, filled: fill }
		});
	}
	log.info(`merged ${loser} into ${survivor}`, { kind, reasons: step.reasons, actor: ctx.actor });
	return { step, applied: true };
}

/** Still-attached planned values: a column changed since planning is left alone. */
function current_values(row: IdRow, planned: Partial<Record<ServiceIdColumn, string>>) {
	const out: Partial<Record<ServiceIdColumn, string>> = {};
	for (const [c, v] of Object.entries(planned) as [ServiceIdColumn, string][]) if (row[c] != null && String(row[c]) === v) out[c] = v;
	return out;
}

interface MovedData { thumbnails: string[]; lyrics: number; lyrics_lookup: boolean; producers: number; sample: boolean; itunes_lookup_cleared: boolean }

/** Moves the service data that belongs to a moved external id along with it. User data stays. */
async function move_service_data(tx: Tx, kind: EntityKind, from: string, to: string, source: SplitStep['facet_source'], thumbnails: readonly string[]): Promise<MovedData> {
	const moved: MovedData = { thumbnails: [], lyrics: 0, lyrics_lookup: false, producers: 0, sample: false, itunes_lookup_cleared: false };
	if (thumbnails.length > 0) {
		const rows = await tx.execute<{ url: string }>(sql`update thumbnails_table set id = ${to} where id = ${from} and url in (${sql.join(thumbnails.map(u => sql`${u}`), sql`, `)}) returning url`, 'objects');
		moved.thumbnails = rows.map(r => r.url);
	}
	if (kind !== 'track') return moved;
	const now = new Date();
	if (source === 'genius') {
		await run(tx, sql`delete from track_lyrics_table f where f.track_id = ${from} and f.service = 'GENIUS'
			and exists (select 1 from track_lyrics_table t where t.track_id = ${to} and t.content_hash = f.content_hash)`);
		const lyrics = await tx.execute<{ id: number }>(sql`update track_lyrics_table set track_id = ${to}, modified_at = ${now} where track_id = ${from} and service = 'GENIUS' returning id`, 'objects');
		moved.lyrics = lyrics.length;
		const lookup = await tx.execute<{ track_id: string }>(sql`update track_lyrics_lookups_table set track_id = ${to} where track_id = ${from} and service = 'GENIUS'
			and not exists (select 1 from track_lyrics_lookups_table t where t.track_id = ${to} and t.service = 'GENIUS') returning track_id`, 'objects');
		moved.lyrics_lookup = lookup.length > 0;
		await run(tx, sql`delete from track_lyrics_lookups_table where track_id = ${from} and service = 'GENIUS'`);
		const producers = await tx.execute<{ producer_id: string }>(sql`insert into tracks_producers_table (producer_id, track_id, created_at, modified_at)
			select producer_id, ${to}, created_at, ${now} from tracks_producers_table where track_id = ${from}
			on conflict do nothing returning producer_id`, 'objects');
		moved.producers = producers.length;
		await run(tx, sql`delete from tracks_producers_table where track_id = ${from}`);
	}
	if (source === 'itunes') {
		// The iTunes preview analysis belongs to the moved Apple Music id, unless the track's own media was analyzed.
		const lookups = await rows_of(tx, 'track_sample_lookups_table', 'track_id', [from]);
		const preview_done = lookups.some(l => l.source === 'itunes_preview' && l.status === 'DONE');
		const media_done = lookups.some(l => l.source === 'media' && l.status === 'DONE');
		const target_has_sample = (await rows_of(tx, 'track_sample_data_table', 'id', [to])).length > 0;
		if (preview_done && !media_done && !target_has_sample) {
			await run(tx, sql`update track_sample_data_table set id = ${to}, modified_at = ${now} where id = ${from}`);
			await run(tx, sql`delete from track_vectors_table where track_id = ${to}`);
			await run(tx, sql`update track_vectors_table set track_id = ${to}, modified_at = ${now} where track_id = ${from}`);
			moved.sample = true;
		}
		await run(tx, sql`update track_sample_lookups_table set track_id = ${to} where track_id = ${from} and source = 'itunes_preview'
			and not exists (select 1 from track_sample_lookups_table t where t.track_id = ${to} and t.source = 'itunes_preview')`);
		await run(tx, sql`delete from track_sample_lookups_table where track_id = ${from} and source = 'itunes_preview'`);
		// Let the iTunes queue re-resolve the original entity.
		const cleared = await tx.execute<{ illusi_id: string }>(sql`delete from itunes_lookups_table where illusi_id = ${from} returning illusi_id`, 'objects');
		moved.itunes_lookup_cleared = cleared.length > 0;
	}
	return moved;
}

async function settle_column_conflicts(tx: Tx, illusi_id: string, columns: readonly string[]) {
	if (columns.length === 0) return;
	await tx.update(service_id_conflicts_table).set({ status: 'split' }).where(and(
		eq(service_id_conflicts_table.illusi_id, illusi_id),
		inArray(service_id_conflicts_table.column, [...columns]),
		inArray(service_id_conflicts_table.status, ['open', 'deferred'])
	));
}

/**
 * A split-off track is another recording of the same song: it keeps the performers, appears on the same albums (not as
 * their primary album, and without a track number) and shares the unsynced lyrics. Synced lyrics stay, their timing
 * is the other recording's. Undoing the split deletes the new track, and these rows with it.
 */
async function inherit_track_metadata(tx: Tx, from: string, new_id: string) {
	await run(tx, sql`insert into tracks_artists_table (artist_id, track_id) select artist_id, ${new_id} from tracks_artists_table where track_id = ${from} on conflict do nothing`);
	await run(tx, sql`insert into album_tracks_table (album_id, track_id) select album_id, ${new_id} from album_tracks_table where track_id = ${from} on conflict do nothing`);
	await run(tx, sql`insert into track_lyrics_table (track_id, service, sync_type, format, raw_content, content_hash)
		select ${new_id}, service, sync_type, format, raw_content, content_hash from track_lyrics_table where track_id = ${from} and sync_type = 'NONE'
		on conflict do nothing`);
}

/** Creates a new entity for misattributed external ids and moves them (and their service data) onto it. */
export async function apply_split(tx: Tx, step: SplitStep, ctx: ApplyContext): Promise<StepResult> {
	const from = await resolve_redirects(tx, [step.from]).then(m => m.get(step.from)!);
	const row = await lock_service_ids(tx, from);
	if (!row) return { step, applied: false, skipped: 'missing_row' };
	const values = current_values(row, step.values);
	const columns = Object.keys(values) as ServiceIdColumn[];
	if (columns.length === 0) return { step, applied: false, skipped: 'ids_changed' };
	const kind = await entity_kind(tx, from);
	if (kind === 'unknown') return { step, applied: false, skipped: 'no_entity' };

	const now = new Date();
	await tx.update(service_ids_table).set({ ...to_column_values(Object.fromEntries(columns.map(c => [c, null]))), modified_at: now }).where(eq(service_ids_table.illusi_id, from));
	const [created] = await tx.insert(service_ids_table).values(to_column_values(values)).returning({ illusi_id: service_ids_table.illusi_id });
	const new_id = created.illusi_id;
	const title = step.new_entity.title;
	if (kind === 'track') {
		await run(tx, sql`insert into tracks_table (id, title, duration_ms, explicit) values (${new_id}, ${title.slice(0, 256)}, ${step.new_entity.duration_ms}, ${step.new_entity.explicit})`);
	} else {
		await run(tx, sql`insert into ${id(ENTITY_TABLES[kind])} (id, name) values (${new_id}, ${title.slice(0, 256)})`);
	}
	await run(tx, sql`update ${id(ENTITY_TABLES[kind])} set modified_at = ${now} where id = ${from}`);

	const moved = await move_service_data(tx, kind, from, new_id, step.facet_source, step.thumbnails);
	// After the move: the moved service's own lyrics are already the new track's.
	if (kind === 'track') await inherit_track_metadata(tx, from, new_id);
	await settle_column_conflicts(tx, from, columns);

	const entity_table = ENTITY_TABLES[kind];
	await write_audit(tx, {
		action: 'split',
		actor: ctx.actor,
		actor_user_id: ctx.actor_user_id,
		entity_table,
		entity_id: from,
		details: { from, new_id, values, facet_source: step.facet_source, reasons: step.reasons, new_entity: step.new_entity, review_item_id: ctx.review_item_id ?? null },
		undo: { restore_ids: { illusi_id: from, values }, delete_entity: new_id, moved }
	});
	if (ctx.actor === 'reconcile') {
		await add_review_item(tx, {
			kind: 'AUTO_SPLIT',
			entity_table,
			entity_id: from,
			proposed_value: { new_id, columns },
			details: { from, new_id, values, facet_source: step.facet_source, reasons: step.reasons }
		});
	}
	log.info(`split ${columns.join(',')} off ${from} into ${new_id}`, { reasons: step.reasons, actor: ctx.actor });
	return { step, applied: true, new_id };
}

/** Moves misattributed external ids from one existing entity to another that they match. */
export async function apply_move(tx: Tx, step: MoveStep, ctx: ApplyContext): Promise<StepResult> {
	const resolved = await resolve_redirects(tx, [step.from, step.to]);
	const from = resolved.get(step.from)!;
	const to = resolved.get(step.to)!;
	if (from === to) return { step, applied: false, skipped: 'already_merged' };
	const [first, second] = [from, to].sort();
	const locked = new Map([[first, await lock_service_ids(tx, first)], [second, await lock_service_ids(tx, second)]]);
	const from_row = locked.get(from);
	const to_row = locked.get(to);
	if (!from_row || !to_row) return { step, applied: false, skipped: 'missing_row' };
	const values = current_values(from_row, step.values);
	const columns = (Object.keys(values) as ServiceIdColumn[]).filter(c => to_row[c] == null);
	if (columns.length === 0) return { step, applied: false, skipped: 'ids_changed' };
	const kind = await entity_kind(tx, from);
	if (kind === 'unknown' || kind !== await entity_kind(tx, to)) return { step, applied: false, skipped: 'kind_mismatch' };

	const now = new Date();
	const moving = Object.fromEntries(columns.map(c => [c, values[c]])) as Partial<Record<ServiceIdColumn, string>>;
	await tx.update(service_ids_table).set({ ...to_column_values(Object.fromEntries(columns.map(c => [c, null]))), modified_at: now }).where(eq(service_ids_table.illusi_id, from));
	await tx.update(service_ids_table).set({ ...to_column_values(moving), modified_at: now }).where(eq(service_ids_table.illusi_id, to));
	await run(tx, sql`update ${id(ENTITY_TABLES[kind])} set modified_at = ${now} where id in (${from}, ${to})`);
	const moved = await move_service_data(tx, kind, from, to, step.facet_source, step.thumbnails);
	await settle_column_conflicts(tx, from, columns);

	await write_audit(tx, {
		action: 'id_move',
		actor: ctx.actor,
		actor_user_id: ctx.actor_user_id,
		entity_table: ENTITY_TABLES[kind],
		entity_id: from,
		details: { from, to, values: moving, facet_source: step.facet_source, reasons: step.reasons, review_item_id: ctx.review_item_id ?? null },
		undo: { move_back: { from: to, to: from, values: moving }, moved }
	});
	if (ctx.actor === 'reconcile') {
		await add_review_item(tx, {
			kind: 'AUTO_SPLIT',
			entity_table: ENTITY_TABLES[kind],
			entity_id: from,
			proposed_value: { moved_to: to, columns },
			details: { from, to, values: moving, facet_source: step.facet_source, reasons: step.reasons }
		});
	}
	log.info(`moved ${columns.join(',')} from ${from} to ${to}`, { reasons: step.reasons, actor: ctx.actor });
	return { step, applied: true };
}

export async function apply_step(tx: Tx, step: PlanStep, ctx: ApplyContext): Promise<StepResult> {
	switch (step.type) {
		case 'merge': return apply_merge(tx, step, ctx);
		case 'split': return apply_split(tx, step, ctx);
		case 'move': return apply_move(tx, step, ctx);
	}
}

/** Splits and moves first, so merges see the corrected ids. */
export function order_steps<T extends PlanStep>(steps: readonly T[]): T[] {
	return [...steps].sort((a, b) => Number(a.type === 'merge') - Number(b.type === 'merge'));
}

export async function set_conflict_statuses(tx: Tx, updates: readonly { id: number; status: ConflictResolution }[]) {
	const by_status = new Map<ConflictResolution, number[]>();
	for (const u of updates) by_status.set(u.status, [...by_status.get(u.status) ?? [], u.id]);
	for (const [status, ids] of by_status) {
		await tx.update(service_id_conflicts_table).set({ status })
			.where(and(inArray(service_id_conflicts_table.id, ids), inArray(service_id_conflicts_table.status, ['open', 'deferred'])));
	}
}

/** What the admin-applied plan carries. */
export interface ReviewPlan {
	group_key: string;
	kind: EntityKind;
	node_ids: string[];
	steps: PlanStep[];
	conflict_ids: number[];
}

function review_anchor(plan: GroupPlan, steps: readonly PlanStep[]): { entity_table: string; entity_id: string } {
	const first = steps[0];
	const entity_id = first.type === 'merge' ? first.survivor : first.from;
	return { entity_table: plan.kind === 'unknown' ? 'service_ids_table' : ENTITY_TABLES[plan.kind], entity_id };
}

/**
 * Raises (or refreshes) the SERVICE_ID_CONFLICT review item for a plan's non-automatic steps, with the
 * plan and the evidence attached. A plan an admin has already seen (same signature, any status) is not raised again.
 */
export async function raise_review(tx: Tx, plan: GroupPlan): Promise<number | null> {
	const steps = order_steps(review_steps(plan));
	if (steps.length === 0) return null;
	const resolved = await resolve_redirects(tx, plan.node_ids);
	const anchor = review_anchor(plan, steps);
	anchor.entity_id = resolved.get(anchor.entity_id) ?? anchor.entity_id;
	const signature = plan_signature(steps);

	const existing = await tx.select({ id: review_items_table.id, proposed_values: review_items_table.proposed_values }).from(review_items_table).where(and(
		eq(review_items_table.kind, 'SERVICE_ID_CONFLICT'),
		eq(review_items_table.entity_table, anchor.entity_table),
		eq(review_items_table.entity_id, anchor.entity_id)
	));
	const seen = existing.some(r => ((r.proposed_values ?? []) as ProposedValue[]).some(p => (p.value as { signature?: string } | null)?.signature === signature));
	if (seen) return null;

	const involved = new Set(steps.flatMap(s => s.type === 'merge' ? [s.survivor, s.loser] : s.type === 'move' ? [s.from, s.to] : [s.from]));
	const review_plan: ReviewPlan = {
		group_key: plan.key,
		kind: plan.kind,
		node_ids: plan.node_ids,
		steps,
		conflict_ids: plan.conflicts.filter(c => c.status === 'deferred').map(c => c.id)
	};
	return add_review_item(tx, {
		kind: 'SERVICE_ID_CONFLICT',
		...anchor,
		current_value: { node_ids: plan.node_ids },
		proposed_value: { signature, steps: steps.map(s => ({ type: s.type, ...(s.type === 'merge' ? { survivor: s.survivor, loser: s.loser } : s.type === 'move' ? { from: s.from, to: s.to, values: s.values } : { from: s.from, values: s.values }) })) },
		plan: review_plan,
		evidence: {
			pairs: plan.evidence.filter(e => involved.has(e.a) || involved.has(e.b)),
			disagreements: plan.disagreements.filter(d => involved.has(d.illusi_id)).map(({ facet: _facet, ...d }) => d)
		},
		details: { group: plan.node_ids }
	});
}

/**
 * Runs an admin-approved review plan: every step regardless of `auto`, then settles the
 * conflicts it covered — merged / split if a step touching them applied, dismissed otherwise.
 */
export async function apply_review_plan(tx: Tx, plan: ReviewPlan, ctx: ApplyContext): Promise<StepResult[]> {
	const results: StepResult[] = [];
	for (const step of order_steps(plan.steps)) results.push(await apply_step(tx, step, ctx));
	if (plan.conflict_ids.length === 0) return results;
	const conflicts = await tx.select().from(service_id_conflicts_table).where(inArray(service_id_conflicts_table.id, plan.conflict_ids));
	const applied = results.filter(r => r.applied).map(r => r.step);
	const updates = conflicts.map((c) => {
		const ids = [c.illusi_id, c.other_illusi_id];
		const merged = applied.some(s => s.type === 'merge' && (ids.includes(s.loser) || ids.includes(s.survivor)) && (c.other_illusi_id == null || (ids.includes(s.loser) && ids.includes(s.survivor))));
		if (merged) return { id: c.id, status: 'merged' as const };
		const split = applied.some(s => s.type !== 'merge' && ids.includes(s.from) && c.column in s.values);
		return { id: c.id, status: split ? 'split' as const : 'dismissed' as const };
	});
	await set_conflict_statuses(tx, updates);
	return results;
}
