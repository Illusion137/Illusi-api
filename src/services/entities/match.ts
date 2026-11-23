/** Matching against the database: one implementation for `/contribute`, `/sync/push` and the read-only `/resolve`. */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../../db';
import { albums_table, artists_table, service_id_conflicts_table, tracks_table } from '../../db/schema';
import { find_illusi_ids_by_service_ids } from '../../core/enrich';
import { resolve_redirect, resolve_redirects } from '../../core/redirects';
import { normalize_service_ids } from '../../core/service_ids';
import type { ServiceIds } from '../../core/service_ids';
import { album_candidates, artist_candidates, artist_ids_by_name, track_candidates } from './candidates';
import { decide_metadata, decide_service_id_match, evaluate_album, evaluate_artist, evaluate_track } from './matching';
import type { AlbumQuery, ArtistQuery, IdCandidate, TrackQuery } from './matching';
import type { EntityType } from './payload';
import { is_uuid } from './payload';

export const ENTITY_TABLES = { artist: artists_table, album: albums_table, track: tracks_table } as const;
export const ENTITY_TABLE_NAMES = { artist: 'artists_table', album: 'albums_table', track: 'tracks_table' } as const;

export type MatchOutcome
	= | { kind: 'match'; illusi_id: string; by: 'ref' | 'service_id' | 'metadata'; service_id_others?: IdCandidate[]; metadata_others?: string[] }
		| { kind: 'unclear'; candidates: string[] }
		| { kind: 'none' };

export interface MatchInput {
	ref?: string;
	service_ids: ServiceIds;
	/** Exactly the one matching `type`. Track/album queries may carry extra candidate ids for the fetch. */
	track?: TrackQuery & { album_ids?: readonly string[] };
	album?: AlbumQuery & { artist_ids?: readonly string[] };
	artist?: ArtistQuery;
}

/** The subset of `ids` that exist as entities of `type`. */
export async function existing_ids(ex: Executor, type: EntityType, ids: readonly string[]): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const table = ENTITY_TABLES[type];
	const rows = await ex.select({ id: table.id }).from(table).where(inArray(table.id, [...new Set(ids)]));
	return new Set(rows.map(r => r.id));
}

/** An existing `illusi_id` ref of `type`, following redirects; null if it isn't one. */
export async function resolve_existing_ref(ex: Executor, type: EntityType, ref: string): Promise<string | null> {
	if (!is_uuid(ref)) return null;
	const id = await resolve_redirect(ex, ref.toLowerCase());
	return (await existing_ids(ex, type, [id])).has(id) ? id : null;
}

/** Only: the best entity of `type` holding any of the ids, plus the others that hold one. */
export async function match_by_service_ids(tx: Tx, type: EntityType, ids: ServiceIds): Promise<{ illusi_id: string; others: IdCandidate[] } | null> {
	const found = await find_illusi_ids_by_service_ids(tx, ids);
	if (found.length === 0) return null;
	const redirects = await resolve_redirects(tx, found.map(f => f.illusi_id));
	const merged = new Map<string, IdCandidate>();
	for (const f of found) {
		const id = redirects.get(f.illusi_id) ?? f.illusi_id;
		const prev = merged.get(id);
		merged.set(id, { illusi_id: id, columns: [...new Set([...(prev?.columns ?? []), ...f.columns])] });
	}
	const of_type = await existing_ids(tx, type, [...merged.keys()]);
	const decision = decide_service_id_match([...merged.values()].filter(c => of_type.has(c.illusi_id)));
	return decision.kind === 'match' ? { illusi_id: decision.illusi_id, others: decision.others } : null;
}

async function match_by_metadata(ex: Executor, type: EntityType, input: MatchInput): Promise<MatchOutcome> {
	let decision;
	if (type === 'track' && input.track) {
		const q = input.track;
		let artist_ids = [...(q.artist_ids ?? [])];
		if (artist_ids.length === 0 && q.artist_name) artist_ids = await artist_ids_by_name(ex, q.artist_name);
		const album_ids = [...new Set([...(q.album_id ? [q.album_id] : []), ...(q.album_ids ?? [])])];
		const candidates = await track_candidates(ex, q.title, artist_ids, album_ids);
		decision = decide_metadata(candidates.map(c => evaluate_track(q, c)));
	} else if (type === 'album' && input.album) {
		const q = input.album;
		const artist_ids = [...new Set([...(q.artist_id ? [q.artist_id] : []), ...(q.artist_ids ?? [])])];
		if (artist_ids.length === 0 && q.artist_name) artist_ids.push(...await artist_ids_by_name(ex, q.artist_name));
		const candidates = await album_candidates(ex, q.name, artist_ids);
		decision = decide_metadata(candidates.map(c => evaluate_album(q, c)));
	} else if (type === 'artist' && input.artist) {
		const q = input.artist;
		const candidates = await artist_candidates(ex, q.name, q.work_ids ?? []);
		decision = decide_metadata(candidates.map(c => evaluate_artist(q, c)));
	} else {
		return { kind: 'none' };
	}
	if (decision.kind === 'match') return { kind: 'match', illusi_id: decision.illusi_id, by: 'metadata', metadata_others: decision.others };
	return decision;
}

/** Existing ref (following redirects) → service ids → strong metadata → unclear / none. */
export async function match_entity(tx: Tx, type: EntityType, input: MatchInput): Promise<MatchOutcome> {
	if (input.ref) {
		const id = await resolve_existing_ref(tx, type, input.ref);
		if (id) return { kind: 'match', illusi_id: id, by: 'ref' };
	}
	const by_ids = await match_by_service_ids(tx, type, input.service_ids);
	if (by_ids) return { kind: 'match', illusi_id: by_ids.illusi_id, by: 'service_id', service_id_others: by_ids.others };
	return match_by_metadata(tx, type, input);
}

export interface ConflictSource { source: string; user_id: string | null }

/**
 * Records a possible duplicate (`other_illusi_id`) for the reconciliation job: a conflict record
 * links the two ids into one group. `column` is a service id column, or `metadata` for metadata matches.
 */
export async function record_link_conflict(tx: Tx, illusi_id: string, other_illusi_id: string, column: string, incoming_value: string, ctx: ConflictSource) {
	const value = Array.from(incoming_value).slice(0, 512).join('');
	const [existing] = await tx.select({ id: service_id_conflicts_table.id }).from(service_id_conflicts_table).where(and(
		eq(service_id_conflicts_table.illusi_id, illusi_id),
		eq(service_id_conflicts_table.column, column),
		eq(service_id_conflicts_table.incoming_value, value),
		eq(service_id_conflicts_table.other_illusi_id, other_illusi_id),
		sql`${service_id_conflicts_table.status} in ('open', 'deferred')`
	)).limit(1);
	if (existing) return;
	await tx.insert(service_id_conflicts_table).values({
		illusi_id,
		column,
		existing_value: null,
		incoming_value: value,
		other_illusi_id,
		source: ctx.source,
		source_user_id: ctx.user_id
	});
}

/** One conflict per other entity holding one of the incoming unique ids. */
export async function record_service_id_others(tx: Tx, illusi_id: string, ids: ServiceIds, others: readonly IdCandidate[], ctx: ConflictSource) {
	const normalized = normalize_service_ids(ids).ids;
	for (const other of others) {
		const column = other.columns.find(c => c !== 'isrc');
		const value = column ? normalized[column] : undefined;
		if (!column || value == null) continue;
		await record_link_conflict(tx, illusi_id, other.illusi_id, column, String(value), ctx);
	}
}
