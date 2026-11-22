import { and, asc, count, desc, eq, inArray, notInArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import type { Executor, Tx } from '../../db';
import {
	albums_table, artists_table, genius_artists_table, genius_songs_table, itunes_artists_table, itunes_collections_table,
	itunes_tracks_table, review_items_table, service_id_conflicts_table, service_ids_table, soundcloud_tracks_table, tracks_table,
	REVIEW_KINDS, REVIEW_STATUSES
} from '../../db/schema';
import { write_audit } from '../../core/audit';
import { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { resolve_redirects } from '../../core/redirects';
import type { ProposedValue } from '../../core/review';
import { apply_review_plan } from '../../worker/reconcile/apply';
import type { ReviewPlan } from '../../worker/reconcile/apply';
import { admin_update_entity, clear_backpacked_if_playable, parse_entity_patch, resolve_table } from './entities';

export const list_query_schema = z.object({
	kind: z.enum(REVIEW_KINDS).optional(),
	entity_table: z.string().max(64).optional(),
	status: z.enum(REVIEW_STATUSES).default('OPEN'),
	/** Leaves out the merges and splits reconciliation already made on its own (`AUTO_*`), which only need acknowledging. */
	hide_auto: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
	sort: z.enum(['occurrences', 'age']).default('occurrences'),
	order: z.enum(['asc', 'desc']).optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25)
});
export type ListQuery = z.infer<typeof list_query_schema>;

export const apply_body_schema = z.object({
	/** Index into `proposed_values`. Default: the most reported proposal (field items) or the latest plan (service id conflicts). */
	proposal_index: z.number().int().min(0).optional(),
	/** A value the admin typed instead of one of the proposals. */
	value: z.unknown().optional()
}).default({});

const is_uuid = (v: string) => z.uuid().safeParse(v).success;

/** Order for the review list: most occurrences first (then oldest), or by age (oldest first unless `order=desc`). */
export function review_order(sort: ListQuery['sort'], order: ListQuery['order']): SQL[] {
	if (sort === 'age') return [order === 'desc' ? desc(review_items_table.created_at) : asc(review_items_table.created_at), asc(review_items_table.id)];
	return [order === 'asc' ? asc(review_items_table.occurrences) : desc(review_items_table.occurrences), asc(review_items_table.created_at), asc(review_items_table.id)];
}

/**
 * Which proposal an apply uses when the admin doesn't pick one: for service id conflicts the
 * latest plan, otherwise the value most users proposed.
 */
export function default_proposal_index(kind: string, proposals: readonly ProposedValue[]): number {
	if (proposals.length === 0) return -1;
	if (kind === 'SERVICE_ID_CONFLICT') return proposals.length - 1;
	let best = 0;
	for (let i = 1; i < proposals.length; i++) if (proposals[i].occurrences > proposals[best].occurrences) best = i;
	return best;
}

/** The entity's current row, its service ids, and its iTunes / Genius / SoundCloud data. */
export async function entity_context(ex: Executor, entity_table: string, entity_id: string) {
	if (!is_uuid(entity_id)) return { entity_id, redirected_to: null, kind: null, entity: null, service_ids: null, links: {} };
	const current = (await resolve_redirects(ex, [entity_id])).get(entity_id)!;
	const table = resolve_table(entity_table);
	const [track] = table === 'tracks_table' || table === 'service_ids_table' ? await ex.select().from(tracks_table).where(eq(tracks_table.id, current)) : [];
	const [album] = !track && (table === 'albums_table' || table === 'service_ids_table') ? await ex.select().from(albums_table).where(eq(albums_table.id, current)) : [];
	const [artist] = !track && !album && (table === 'artists_table' || table === 'service_ids_table') ? await ex.select().from(artists_table).where(eq(artists_table.id, current)) : [];
	const kind = track ? 'track' : album ? 'album' : artist ? 'artist' : null;
	const [sids] = await ex.select().from(service_ids_table).where(eq(service_ids_table.illusi_id, current));

	const links: Record<string, unknown> = {};
	const apple = sids?.applemusic_id != null && /^\d+$/u.test(sids.applemusic_id) ? Number(sids.applemusic_id) : null;
	if (apple != null) {
		if (kind === 'track') links.itunes = (await ex.select().from(itunes_tracks_table).where(eq(itunes_tracks_table.id, apple)))[0] ?? null;
		else if (kind === 'album') links.itunes = (await ex.select().from(itunes_collections_table).where(eq(itunes_collections_table.id, apple)))[0] ?? null;
		else if (kind === 'artist') links.itunes = (await ex.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, apple)))[0] ?? null;
	}
	if (sids?.genius_id != null) {
		if (kind === 'artist') links.genius = (await ex.select().from(genius_artists_table).where(eq(genius_artists_table.id, sids.genius_id)))[0] ?? null;
		else if (kind === 'track') {
			const [song] = await ex.select({
				id: genius_songs_table.id, title: genius_songs_table.title, full_title: genius_songs_table.full_title, url: genius_songs_table.url,
				primary_artist_names: genius_songs_table.primary_artist_names, apple_music_id: genius_songs_table.apple_music_id,
				spotify_uuid: genius_songs_table.spotify_uuid, youtube_url: genius_songs_table.youtube_url, soundcloud_url: genius_songs_table.soundcloud_url,
				release_date: genius_songs_table.release_date, explicit: genius_songs_table.explicit
			}).from(genius_songs_table).where(eq(genius_songs_table.id, sids.genius_id));
			links.genius = song ?? null;
		}
	}
	if (sids?.soundcloud_id != null && kind === 'track') {
		const [sc] = await ex.select({
			id: soundcloud_tracks_table.id, title: soundcloud_tracks_table.title, permalink: soundcloud_tracks_table.permalink,
			duration: soundcloud_tracks_table.duration, full_duration: soundcloud_tracks_table.full_duration, isrc: soundcloud_tracks_table.isrc,
			publisher_artist: soundcloud_tracks_table.publisher_artist, artwork_url: soundcloud_tracks_table.artwork_url
		}).from(soundcloud_tracks_table).where(eq(soundcloud_tracks_table.id, sids.soundcloud_id));
		links.soundcloud = sc ?? null;
	}
	return { entity_id, redirected_to: current === entity_id ? null : current, kind, entity: track ?? album ?? artist ?? null, service_ids: sids ?? null, links };
}

const MAX_GROUP_CONTEXT = 10;
const AUTO_REVIEW_KINDS = REVIEW_KINDS.filter(k => k.startsWith('AUTO_'));

export async function list_review(q: ListQuery) {
	const filters = [eq(review_items_table.status, q.status)];
	if (q.kind) filters.push(eq(review_items_table.kind, q.kind));
	else if (q.hide_auto) filters.push(notInArray(review_items_table.kind, AUTO_REVIEW_KINDS));
	if (q.entity_table) filters.push(eq(review_items_table.entity_table, resolve_table(q.entity_table) ?? q.entity_table));
	const where = and(...filters);
	const [{ total }] = await db.select({ total: count() }).from(review_items_table).where(where);
	const rows = await db.select().from(review_items_table).where(where)
		.orderBy(...review_order(q.sort, q.order)).limit(q.limit).offset((q.page - 1) * q.limit);

	const items = [];
	for (const row of rows) {
		const context = await entity_context(db, row.entity_table, row.entity_id);
		let group: unknown[] | undefined;
		let conflicts: unknown[] | undefined;
		if (row.kind === 'SERVICE_ID_CONFLICT') {
			const plans = (row.proposed_values as ProposedValue[]).map(p => p.plan as ReviewPlan | undefined).filter(p => p != null);
			const node_ids = [...new Set(plans.flatMap(p => p.node_ids))].filter(id => id !== row.entity_id).slice(0, MAX_GROUP_CONTEXT);
			group = [];
			for (const id of node_ids) group.push(await entity_context(db, row.entity_table, id));
			const conflict_ids = [...new Set(plans.flatMap(p => p.conflict_ids))];
			conflicts = conflict_ids.length > 0 ? await db.select().from(service_id_conflicts_table).where(inArray(service_id_conflicts_table.id, conflict_ids)) : [];
		}
		items.push({ ...row, dedupe_key: undefined, context, group, conflicts });
	}
	return { items, total, page: q.page, limit: q.limit, has_more: q.page * q.limit < total };
}

async function lock_open_item(tx: Tx, id: number) {
	const [item] = await tx.select().from(review_items_table).where(eq(review_items_table.id, id)).for('update');
	if (!item) throw new HttpError(404, 'review item not found');
	if (item.status !== 'OPEN') throw new HttpError(409, `review item is already ${item.status}`);
	return item;
}

async function resolve_item(tx: Tx, id: number, status: 'APPLIED' | 'DISMISSED', admin_id: string) {
	await tx.update(review_items_table).set({ status, resolved_by: admin_id, resolved_at: new Date(), modified_at: new Date() }).where(eq(review_items_table.id, id));
}

/**
 * Applies a review item: a proposed value or an admin-typed one onto the entity field,
 * or, for a service id conflict, runs the attached plan through the reconciliation apply code.
 */
export async function apply_review(id: number, body: z.infer<typeof apply_body_schema>, admin_id: string) {
	const events = new PendingEvents();
	const result = await db.transaction(async (tx) => {
		const item = await lock_open_item(tx, id);
		const proposals = (item.proposed_values ?? []) as ProposedValue[];
		const index = body.proposal_index ?? default_proposal_index(item.kind, proposals);
		if (body.proposal_index != null && !proposals[index]) throw new HttpError(400, 'no such proposal');

		if (item.kind === 'SERVICE_ID_CONFLICT') {
			const plan = proposals[index]?.plan as ReviewPlan | undefined;
			if (!plan?.steps.length) throw new HttpError(400, 'review item has no plan to apply');
			const steps = await apply_review_plan(tx, plan, { actor: 'admin', actor_user_id: admin_id, review_item_id: item.id });
			for (const { step, applied } of steps) {
				if (!applied || step.type !== 'move') continue;
				const to = (await resolve_redirects(tx, [step.to])).get(step.to)!;
				await clear_backpacked_if_playable(tx, to, Object.keys(step.values));
			}
			await resolve_item(tx, item.id, 'APPLIED', admin_id);
			return { id: item.id, status: 'APPLIED', steps: steps.map(s => ({ type: s.step.type, applied: s.applied, skipped: s.skipped ?? null, new_id: s.new_id ?? null })) };
		}

		if (!item.field) throw new HttpError(400, `${item.kind} items have no field to apply; dismiss instead`);
		const table = resolve_table(item.entity_table);
		if (!table) throw new HttpError(400, `entity table ${item.entity_table} is not editable`);
		const value = body.value !== undefined ? body.value : proposals[index]?.value;
		if (value === undefined) throw new HttpError(400, 'no value to apply');
		const values = parse_entity_patch(table, { [item.field]: value });
		const entity_id = is_uuid(item.entity_id) ? (await resolve_redirects(tx, [item.entity_id])).get(item.entity_id)! : item.entity_id;
		const change = await admin_update_entity(tx, table, entity_id, values, { admin_id, review_item_id: item.id, events });
		await resolve_item(tx, item.id, 'APPLIED', admin_id);
		return { id: item.id, status: 'APPLIED', entity_table: table, entity_id, before: change.before, after: change.after };
	});
	events.flush();
	return result;
}

/** Dismisses a review item; for a service id conflict its deferred conflicts are dismissed too (existing links stay). */
export async function dismiss_review(id: number, admin_id: string) {
	return db.transaction(async (tx) => {
		const item = await lock_open_item(tx, id);
		let conflict_ids: number[] = [];
		if (item.kind === 'SERVICE_ID_CONFLICT') {
			conflict_ids = [...new Set(((item.proposed_values ?? []) as ProposedValue[]).flatMap(p => (p.plan as ReviewPlan | undefined)?.conflict_ids ?? []))];
			if (conflict_ids.length > 0) {
				await tx.update(service_id_conflicts_table).set({ status: 'dismissed' })
					.where(and(inArray(service_id_conflicts_table.id, conflict_ids), inArray(service_id_conflicts_table.status, ['open', 'deferred'])));
			}
		}
		await resolve_item(tx, item.id, 'DISMISSED', admin_id);
		await write_audit(tx, {
			action: 'admin_dismiss',
			actor: 'admin',
			actor_user_id: admin_id,
			entity_table: item.entity_table,
			entity_id: item.entity_id,
			details: { review_item_id: item.id, kind: item.kind, field: item.field, conflicts_dismissed: conflict_ids },
			undo: { review_item_id: item.id, status: 'OPEN', conflict_ids }
		});
		return { id: item.id, status: 'DISMISSED' };
	});
}
