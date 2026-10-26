/**
 * The shared contribution engine: matches every entity of a graph, creates the missing ones,
 * applies shared-data write rules and adds relations. `/contribute` and `/sync/push` both run it inside
 * their own transaction; it never commits and never emits events itself (see `flush_engine_events`).
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db';
import { album_tracks_table, artist_albums_table, service_ids_table, similar_artists_table, tracks_artists_table } from '../../db/schema';
import { enrich_service_ids } from '../../core/enrich';
import { PendingEvents } from '../../core/events';
import { logger } from '../../core/log';
import type { ProvenanceLog, TouchedEntity } from '../../core/provenance';
import { add_review_item } from '../../core/review';
import { upsert_thumbnails } from '../../core/thumbnails';
import { truncate_to_columns } from '../../core/truncate';
import { resolve_shared_fields } from './fields';
import type { FieldSpec } from './fields';
import { ENTITY_TABLE_NAMES, ENTITY_TABLES, match_by_service_ids, match_entity, record_link_conflict, record_service_id_others, resolve_existing_ref } from './match';
import type { MatchInput } from './match';
import type { IdCandidate } from './matching';
import { service_ids_of, thumbnails_of } from './payload';
import type { AlbumInput, ArtistInput, EntityType, Graph, Rejection, RelationKind, TrackInput } from './payload';
import { prepare_similar_pairs } from './similar';
import { pg_error_code, PG_ERRORS } from '../../core/pg_errors';

const log = logger('entities');

export interface EngineContext {
	user_id: string;
	source: 'contribute' | 'sync_push';
	provenance: ProvenanceLog;
}

export interface EntityOutcome { ref: string; type: EntityType; illusi_id: string }
export interface MatchedOutcome extends EntityOutcome { by: 'ref' | 'service_id' | 'metadata' }

export type ConflictReport = EntityOutcome & (
	| { kind: 'service_id_multiple'; others: IdCandidate[] }
	| { kind: 'metadata_multiple'; others: string[] }
	| { kind: 'metadata_unclear'; candidates: string[] }
	| { kind: 'service_id'; column: string; conflict: 'different_value' | 'taken'; existing_value: string | null; incoming_value: string; other_illusi_id: string | null }
	| { kind: 'field'; field: string; current: unknown; proposed: unknown }
);

export interface EngineResult {
	/** Every payload ref that was applied → its `illusi_id`. */
	refs: Record<string, string>;
	created: EntityOutcome[];
	matched: MatchedOutcome[];
	conflicts: ConflictReport[];
	rejected: Rejection[];
	/** Relation rows added. */
	relations_added: number;
	/** One per applied entity; flush every one of them after commit. */
	events: PendingEvents[];
}

export function flush_engine_events(result: Pick<EngineResult, 'events'>) {
	for (const events of result.events) events.flush();
}

/** Thrown inside a creation savepoint when another request created the same entity first. */
class LostCreateRace extends Error {}

const FIELD_SPECS = {
	artist: { name: 'name', description: 'text', primary_genre_name: 'text' } satisfies FieldSpec<Record<string, unknown>>,
	album: { name: 'name', artist_id: 'id', album_type: 'enum', release_date: 'date', track_count: 'number', explicit: 'bool' } satisfies FieldSpec<Record<string, unknown>>,
	track: { title: 'name', album_id: 'id', duration_ms: 'duration', explicit: 'bool' } satisfies FieldSpec<Record<string, unknown>>
};

const MAX_METADATA_CONFLICTS = 5;
const BATCH = 500;

type AnyInput = ArtistInput | AlbumInput | TrackInput;
const label_of = (input: AnyInput) => ('title' in input ? input.title : input.name);

/** Payload links used as matching hints (an artist's works, a track's artists, ...). */
interface Links {
	albums_of_artist: Map<string, string[]>;
	tracks_of_artist: Map<string, string[]>;
	artists_of_album: Map<string, string[]>;
	artists_of_track: Map<string, string[]>;
	albums_of_track: Map<string, string[]>;
}

function push_link(map: Map<string, string[]>, key: string, value: string) {
	const list = map.get(key);
	if (!list) map.set(key, [value]);
	else if (!list.includes(value)) list.push(value);
}

export function graph_links(graph: Graph): Links {
	const links: Links = { albums_of_artist: new Map(), tracks_of_artist: new Map(), artists_of_album: new Map(), artists_of_track: new Map(), albums_of_track: new Map() };
	for (const a of graph.albums) {
		if (a.artist_ref) {
			push_link(links.artists_of_album, a.ref, a.artist_ref);
			push_link(links.albums_of_artist, a.artist_ref, a.ref);
		}
	}
	for (const r of graph.relations.artist_albums) {
		push_link(links.artists_of_album, r.album_ref, r.artist_ref);
		push_link(links.albums_of_artist, r.artist_ref, r.album_ref);
	}
	for (const t of graph.tracks) if (t.album_ref) push_link(links.albums_of_track, t.ref, t.album_ref);
	for (const r of graph.relations.album_tracks) push_link(links.albums_of_track, r.track_ref, r.album_ref);
	for (const r of graph.relations.tracks_artists) {
		push_link(links.artists_of_track, r.track_ref, r.artist_ref);
		push_link(links.tracks_of_artist, r.artist_ref, r.track_ref);
	}
	return links;
}

class Engine {
	readonly result: EngineResult = { refs: {}, created: [], matched: [], conflicts: [], rejected: [], relations_added: 0, events: [] };
	private readonly payload_refs = new Map<string, AnyInput>();
	private readonly external = new Map<string, string | null>();
	private readonly prematched = new Map<string, string | null>();
	private readonly links: Links;

	constructor(private tx: Tx, private graph: Graph, private ctx: EngineContext) {
		for (const e of [...graph.artists, ...graph.albums, ...graph.tracks]) this.payload_refs.set(e.ref, e);
		this.links = graph_links(graph);
	}

	/** A ref's `illusi_id`: an applied payload entity, or an existing id not defined in the payload. */
	async resolve(ref: string, type: EntityType): Promise<string | null> {
		const applied = this.result.refs[ref] as string | undefined;
		if (applied) return applied;
		if (this.payload_refs.has(ref)) return null;
		const key = `${type}:${ref}`;
		if (!this.external.has(key)) this.external.set(key, await resolve_existing_ref(this.tx, type, ref));
		return this.external.get(key) ?? null;
	}

	private async resolve_all(refs: readonly string[] | undefined, type: EntityType): Promise<string[]> {
		const out: string[] = [];
		for (const ref of refs ?? []) {
			const id = await this.resolve(ref, type);
			if (id && !out.includes(id)) out.push(id);
		}
		return out;
	}

	/** A cheap pre-match (existing ref or service ids) of a payload work, used as an artist hint before works are applied. */
	private async prematch(ref: string, type: EntityType): Promise<string | null> {
		const resolved = await this.resolve(ref, type);
		if (resolved) return resolved;
		const entity = this.payload_refs.get(ref);
		if (!entity) return null;
		if (!this.prematched.has(ref)) {
			const by_ref = await resolve_existing_ref(this.tx, type, ref);
			this.prematched.set(ref, by_ref ?? (await match_by_service_ids(this.tx, type, service_ids_of(entity)))?.illusi_id ?? null);
		}
		return this.prematched.get(ref) ?? null;
	}

	private async match_input(type: EntityType, input: AnyInput): Promise<MatchInput> {
		const base = { ref: input.ref, service_ids: service_ids_of(input) };
		if (type === 'artist') {
			const album_refs = this.links.albums_of_artist.get(input.ref) ?? [];
			const track_refs = this.links.tracks_of_artist.get(input.ref) ?? [];
			const work_ids: string[] = [];
			for (const r of album_refs) { const id = await this.prematch(r, 'album'); if (id) work_ids.push(id); }
			for (const r of track_refs) { const id = await this.prematch(r, 'track'); if (id) work_ids.push(id); }
			const name_of = (r: string) => { const e = this.payload_refs.get(r); return e ? label_of(e) : null; };
			return {
				...base,
				artist: {
					name: label_of(input),
					work_ids,
					album_names: album_refs.map(name_of).filter((n): n is string => n != null),
					track_titles: track_refs.map(name_of).filter((n): n is string => n != null)
				}
			};
		}
		if (type === 'album') {
			const artist_ids = await this.resolve_all(this.links.artists_of_album.get(input.ref), 'artist');
			return { ...base, album: { name: label_of(input), artist_id: artist_ids[0] ?? null, artist_ids } };
		}
		const track = input as TrackInput;
		const artist_ids = await this.resolve_all(this.links.artists_of_track.get(input.ref), 'artist');
		const album_ids = await this.resolve_all(this.links.albums_of_track.get(input.ref), 'album');
		return { ...base, track: { title: track.title, duration_ms: track.duration_ms, artist_ids, album_id: album_ids[0] ?? null, album_ids } };
	}

	/** Column values of the entity row, with refs resolved. Missing values are left out (never null out). */
	private async row_values(type: EntityType, input: AnyInput): Promise<Record<string, unknown>> {
		if (type === 'artist') {
			const a = input as ArtistInput;
			return { name: a.name, description: a.description, primary_genre_name: a.primary_genre_name };
		}
		if (type === 'album') {
			const a = input as AlbumInput;
			return { name: a.name, artist_id: a.artist_ref ? await this.resolve(a.artist_ref, 'artist') : undefined, album_type: a.album_type, release_date: a.release_date, track_count: a.track_count, explicit: a.explicit };
		}
		const t = input as TrackInput;
		return { title: t.title, album_id: t.album_ref ? await this.resolve(t.album_ref, 'album') : undefined, duration_ms: t.duration_ms, explicit: t.explicit };
	}

	/**
	 * Concurrent requests can both miss in matching and both create the same new entity; the loser
	 * then finds its service ids (or a unique key) taken by the winner's committed row. Its savepoint
	 * is rolled back and it matches again once, which now finds the winner.
	 */
	async apply_entity(type: EntityType, input: AnyInput, index: number) {
		for (let attempt = 0; ; attempt++) {
			if (!(await this.try_apply_entity(type, input, index, attempt === 0))) return;
		}
	}

	/** Returns true when the entity lost a creation race and should be matched again. */
	private async try_apply_entity(type: EntityType, input: AnyInput, index: number, may_retry: boolean): Promise<boolean> {
		const conflicts: ConflictReport[] = [];
		const touched: TouchedEntity[] = [];
		const events = new PendingEvents();
		const table = ENTITY_TABLES[type];
		const table_name = ENTITY_TABLE_NAMES[type];
		const conflict_ctx = { source: this.ctx.source, user_id: this.ctx.user_id };
		try {
			const outcome = await this.tx.transaction(async (sp) => {
				const match = await match_entity(sp, type, await this.match_input(type, input));
				const values = truncate_to_columns(table, await this.row_values(type, input), `${table_name} ${input.ref}`);
				let id: string;
				let created = false;
				if (match.kind === 'match') {
					id = match.illusi_id;
					const [current] = await sp.select().from(table).where(eq(table.id, id)).for('update');
					const { fill, conflicts: differing } = resolve_shared_fields(FIELD_SPECS[type], current as Record<string, unknown>, values);
					if (Object.keys(fill).length > 0) {
						await sp.update(table).set(fill).where(eq(table.id, id));
						touched.push({ table: table_name, id, filled: Object.keys(fill) });
					}
					for (const c of differing) {
						await add_review_item(sp, { kind: 'FIELD_CONFLICT', entity_table: table_name, entity_id: id, field: c.field, current_value: c.current, proposed_value: c.proposed, source_user_id: this.ctx.user_id, details: { source: this.ctx.source } });
						conflicts.push({ kind: 'field', ref: input.ref, type, illusi_id: id, field: c.field, current: c.current, proposed: c.proposed });
					}
					if (match.service_id_others?.length) {
						await record_service_id_others(sp, id, service_ids_of(input), match.service_id_others, conflict_ctx);
						conflicts.push({ kind: 'service_id_multiple', ref: input.ref, type, illusi_id: id, others: match.service_id_others });
					}
					if (match.metadata_others?.length) {
						for (const other of match.metadata_others.slice(0, MAX_METADATA_CONFLICTS)) await record_link_conflict(sp, id, other, 'metadata', `${type} ${label_of(input)}`, conflict_ctx);
						conflicts.push({ kind: 'metadata_multiple', ref: input.ref, type, illusi_id: id, others: match.metadata_others });
					}
				} else {
					id = randomUUID();
					created = true;
					await sp.insert(service_ids_table).values({ illusi_id: id });
					const insert = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null));
					if (type === 'track') insert.imported = (input as TrackInput).imported ?? false;
					await sp.insert(table).values({ ...insert, id } as typeof table.$inferInsert);
					touched.push({ table: table_name, id, filled: ['*'] });
					if (match.kind === 'unclear') {
						for (const other of match.candidates.slice(0, MAX_METADATA_CONFLICTS)) await record_link_conflict(sp, id, other, 'metadata', `${type} ${label_of(input)}`, conflict_ctx);
						conflicts.push({ kind: 'metadata_unclear', ref: input.ref, type, illusi_id: id, candidates: match.candidates });
					}
					events.push('entity_created', { illusi_id: id, entity_type: type, imported: type === 'track' && ((input as TrackInput).imported ?? false) });
				}

				const enriched = await enrich_service_ids(sp, id, service_ids_of(input), { source: this.ctx.source, user_id: this.ctx.user_id, events });
				if (created && may_retry && enriched.conflicts.some(c => c.kind === 'taken')) throw new LostCreateRace();
				if (enriched.filled.length > 0) touched.push({ table: 'service_ids_table', id, filled: enriched.filled });
				for (const c of enriched.conflicts) {
					conflicts.push({ kind: 'service_id', ref: input.ref, type, illusi_id: id, column: c.column, conflict: c.kind, existing_value: c.existing_value, incoming_value: c.incoming_value, other_illusi_id: c.other_illusi_id });
				}
				await upsert_thumbnails(sp, id, thumbnails_of(input));
				return { id, created, by: match.kind === 'match' ? match.by : null };
			});

			this.result.refs[input.ref] = outcome.id;
			if (outcome.created) this.result.created.push({ ref: input.ref, type, illusi_id: outcome.id });
			else this.result.matched.push({ ref: input.ref, type, illusi_id: outcome.id, by: outcome.by! });
			this.result.conflicts.push(...conflicts);
			this.result.events.push(events);
			for (const t of touched) this.ctx.provenance.touch(t.table, t.id, t.filled);
		} catch (err) {
			if (may_retry && (err instanceof LostCreateRace || pg_error_code(err) === PG_ERRORS.unique_violation)) return true;
			log.warn(`rejected ${type} ${input.ref}`, err);
			this.result.rejected.push({ kind: type, index, ref: input.ref, reason: 'could not be applied' });
		}
		return false;
	}

	/** Inserts rows in a savepoint; if the batch fails, retries row by row so only the bad rows are rejected. */
	private async insert_rows<R>(kind: RelationKind, rows: { row: R; index: number }[], insert: (tx: Tx, rows: R[]) => Promise<{ key: string; inserted: boolean }[]>, filled_on_update: string) {
		const record = (written: { key: string; inserted: boolean }[]) => {
			for (const w of written) this.ctx.provenance.touch(`${kind}_table`, w.key, w.inserted ? ['*'] : [filled_on_update]);
			this.result.relations_added += written.filter(w => w.inserted).length;
		};
		for (let i = 0; i < rows.length; i += BATCH) {
			const chunk = rows.slice(i, i + BATCH);
			try {
				record(await this.tx.transaction(sp => insert(sp, chunk.map(c => c.row))));
			} catch {
				for (const c of chunk) {
					try {
						record(await this.tx.transaction(sp => insert(sp, [c.row])));
					} catch (err) {
						log.warn(`rejected ${kind} relation`, err);
						this.result.rejected.push({ kind, index: c.index, reason: 'could not be applied' });
					}
				}
			}
		}
	}

	/** Resolves both endpoints of every relation; unresolved ones (their entity failed) are rejected. */
	private async endpoints<T>(kind: RelationKind, items: readonly T[], spec: [keyof T, EntityType][]) {
		const out: { item: T; ids: string[]; index: number }[] = [];
		const seen = new Set<string>();
		for (const [index, item] of items.entries()) {
			const ids: string[] = [];
			for (const [field, type] of spec) {
				const id = await this.resolve(item[field] as string, type);
				if (!id) break;
				ids.push(id);
			}
			if (ids.length < spec.length) {
				this.result.rejected.push({ kind, index, reason: 'references an entity that was not applied' });
				continue;
			}
			const key = ids.join(':');
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ item, ids, index });
		}
		return out;
	}

	async apply_relations() {
		const r = this.graph.relations;
		const inserted_flag = sql<boolean>`(xmax = 0)`;

		const ta = await this.endpoints('tracks_artists', r.tracks_artists, [['track_ref', 'track'], ['artist_ref', 'artist']]);
		await this.insert_rows('tracks_artists', ta.map(x => ({ row: { track_id: x.ids[0], artist_id: x.ids[1] }, index: x.index })), async (tx, rows) => {
			const written = await tx.insert(tracks_artists_table).values(rows).onConflictDoNothing()
				.returning({ track_id: tracks_artists_table.track_id, artist_id: tracks_artists_table.artist_id });
			return written.map(w => ({ key: `${w.track_id}:${w.artist_id}`, inserted: true }));
		}, '*');

		const at = await this.endpoints('album_tracks', r.album_tracks, [['album_ref', 'album'], ['track_ref', 'track']]);
		await this.insert_rows('album_tracks', at.map(x => ({ row: { album_id: x.ids[0], track_id: x.ids[1], track_number: x.item.track_number ?? null }, index: x.index })), async (tx, rows) => {
			const written = await tx.insert(album_tracks_table).values(rows).onConflictDoUpdate({
				target: [album_tracks_table.album_id, album_tracks_table.track_id],
				set: { track_number: sql`excluded.track_number` },
				setWhere: sql`${album_tracks_table.track_number} is null and excluded.track_number is not null`
			}).returning({ album_id: album_tracks_table.album_id, track_id: album_tracks_table.track_id, inserted: inserted_flag });
			return written.map(w => ({ key: `${w.album_id}:${w.track_id}`, inserted: w.inserted }));
		}, 'track_number');

		const aa = await this.endpoints('artist_albums', r.artist_albums, [['artist_ref', 'artist'], ['album_ref', 'album']]);
		await this.insert_rows('artist_albums', aa.map(x => ({ row: { artist_id: x.ids[0], album_id: x.ids[1], position: x.item.position ?? null }, index: x.index })), async (tx, rows) => {
			const written = await tx.insert(artist_albums_table).values(rows).onConflictDoUpdate({
				target: [artist_albums_table.artist_id, artist_albums_table.album_id],
				set: { position: sql`excluded.position` },
				setWhere: sql`${artist_albums_table.position} is null and excluded.position is not null`
			}).returning({ artist_id: artist_albums_table.artist_id, album_id: artist_albums_table.album_id, inserted: inserted_flag });
			return written.map(w => ({ key: `${w.artist_id}:${w.album_id}`, inserted: w.inserted }));
		}, 'position');

		const sa = await this.endpoints('similar_artists', r.similar_artists, [['artist_ref', 'artist'], ['similar_artist_ref', 'artist']]);
		const pairs = prepare_similar_pairs(sa.map(x => ({ artist_id: x.ids[0], similar_artist_id: x.ids[1] })));
		for (const x of sa) {
			if (x.ids[0] === x.ids[1]) this.result.rejected.push({ kind: 'similar_artists', index: x.index, reason: 'artist cannot be similar to itself' });
		}
		const index_of = new Map(sa.map(x => [`${x.ids[0]}:${x.ids[1]}`, x.index]));
		await this.insert_rows('similar_artists', pairs.map(p => ({ row: p, index: index_of.get(`${p.artist_id}:${p.similar_artist_id}`) ?? -1 })), async (tx, rows) => {
			const written = await tx.insert(similar_artists_table).values(rows).onConflictDoNothing()
				.returning({ artist_id: similar_artists_table.artist_id, similar_artist_id: similar_artists_table.similar_artist_id });
			return written.map(w => ({ key: `${w.artist_id}:${w.similar_artist_id}`, inserted: true }));
		}, '*');
	}
}

/**
 * Applies a validated graph inside `tx` in foreign-key order: artists → albums → tracks (each with its
 * service-id enrichment and thumbnails) → relations. A failing entity is rejected on its own (savepoint)
 * and the relations that need it are rejected with it.
 */
export async function apply_graph(tx: Tx, graph: Graph, ctx: EngineContext): Promise<EngineResult> {
	const engine = new Engine(tx, graph, ctx);
	for (const [index, a] of graph.artists.entries()) await engine.apply_entity('artist', a, index);
	for (const [index, a] of graph.albums.entries()) await engine.apply_entity('album', a, index);
	for (const [index, t] of graph.tracks.entries()) await engine.apply_entity('track', t, index);
	await engine.apply_relations();
	return engine.result;
}
