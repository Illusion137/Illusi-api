import { createHash } from 'node:crypto';
import { and, asc, eq, getColumns, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { SQL, Table } from 'drizzle-orm';
import { db } from '../../db';
import type { Executor, Tx } from '../../db';
import { albums_table, artists_table, genius_songs_table, service_ids_table, track_lyrics_lookups_table, track_lyrics_table, tracks_artists_table, tracks_table } from '../../db/schema';
import { logger } from '../../core/log';
import { add_review_item } from '../../core/review';
import { PARSER_VERSION, try_parse_lyrics } from './parse';
import { pick_consensus, rank_lyrics } from './rank';
import { compute_retry_after, next_attempts } from './schedule';
import type { LookupLike, LookupStatus, LyricsService, LyricsVersion, ParsedLyrics, SyncType } from './types';

const log = logger('lyrics');

export const content_hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

const CHUNK = 1000;
function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * `ON CONFLICT DO UPDATE` set that never nulls out: `coalesce(excluded.col, existing.col)` for
 * every column except the key and `created_at`.
 */
export function coalesce_set(table: Table, key_columns: readonly string[] = ['id']): Record<string, SQL> {
	const set: Record<string, SQL> = {};
	for (const [key, column] of Object.entries(getColumns(table) as Record<string, { name: string }>)) {
		if (key_columns.includes(key) || key === 'created_at') continue;
		set[key] = key === 'modified_at' ? sql`now()` : sql`coalesce(excluded.${sql.identifier(column.name)}, ${column as never})`;
	}
	return set;
}

export interface TrackContext {
	id: string;
	title: string;
	duration_ms: number | null;
	album: string | null;
	/** Artists in link order; the first is treated as primary. */
	artists: { id: string; name: string }[];
	service_ids: typeof service_ids_table.$inferSelect | null;
}

export async function load_track_context(ex: Executor, track_id: string): Promise<TrackContext | null> {
	const [track] = await ex.select({ id: tracks_table.id, title: tracks_table.title, duration_ms: tracks_table.duration_ms, album: albums_table.name })
		.from(tracks_table)
		.leftJoin(albums_table, eq(albums_table.id, tracks_table.album_id))
		.where(eq(tracks_table.id, track_id));
	if (!track) return null;
	const artists = await ex.select({ id: artists_table.id, name: artists_table.name })
		.from(tracks_artists_table)
		.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
		.where(eq(tracks_artists_table.track_id, track_id))
		.orderBy(asc(tracks_artists_table.created_at), asc(artists_table.name));
	const [ids] = await ex.select().from(service_ids_table).where(eq(service_ids_table.illusi_id, track_id));
	return { ...track, artists, service_ids: ids ?? null };
}

/** `<artist> <title>` search query for client actions. */
export function search_query(ctx: Pick<TrackContext, 'title' | 'artists'>): string {
	return [ctx.artists[0]?.name, ctx.title].filter(Boolean).join(' ');
}

export type LookupMap = Map<LyricsService, LookupLike>;

export async function load_lookups(ex: Executor, track_ids: readonly string[]): Promise<Map<string, LookupMap>> {
	const out = new Map<string, LookupMap>();
	for (const part of chunks([...new Set(track_ids)])) {
		const rows = await ex.select().from(track_lyrics_lookups_table).where(inArray(track_lyrics_lookups_table.track_id, part));
		for (const r of rows) {
			let map = out.get(r.track_id);
			if (!map) out.set(r.track_id, map = new Map());
			map.set(r.service, { status: r.status, attempts: r.attempts, attempted_at: r.attempted_at, retry_after: r.retry_after });
		}
	}
	return out;
}

export interface LookupWrite {
	service: LyricsService;
	status: LookupStatus;
	cooldown_until?: Date | null;
	source_user_id?: string | null;
}

/** Upserts one lookup record per service. */
export async function write_lookups(tx: Tx, track_id: string, writes: readonly LookupWrite[], previous: LookupMap, now = new Date()) {
	if (writes.length === 0) return;
	const rows = writes.map((w) => {
		const attempts = next_attempts(previous.get(w.service), w.status);
		return {
			track_id,
			service: w.service,
			status: w.status,
			attempts,
			attempted_at: now,
			retry_after: compute_retry_after(w.status, attempts, now, undefined, w.cooldown_until),
			source_user_id: w.source_user_id ?? null
		};
	});
	await tx.insert(track_lyrics_lookups_table).values(rows).onConflictDoUpdate({
		target: [track_lyrics_lookups_table.track_id, track_lyrics_lookups_table.service],
		set: {
			status: sql`excluded.status`,
			attempts: sql`excluded.attempts`,
			attempted_at: sql`excluded.attempted_at`,
			retry_after: sql`excluded.retry_after`,
			source_user_id: sql`excluded.source_user_id`
		}
	});
}

/** Stores every version; identical content for the same track is a no-op. Returns the new row ids. */
export async function insert_versions(tx: Tx, track_id: string, service: LyricsService, versions: readonly LyricsVersion[], source?: { user_id: string; token_jti: string | null }): Promise<number[]> {
	const unique = new Map(versions.map(v => [content_hash(v.raw_content), v]));
	if (unique.size === 0) return [];
	const rows = await tx.insert(track_lyrics_table).values([...unique].map(([hash, v]) => ({
		track_id,
		service,
		sync_type: v.sync_type,
		format: v.format,
		raw_content: v.raw_content,
		content_hash: hash,
		source_user_id: source?.user_id ?? null,
		source_token_jti: source?.token_jti ?? null
	}))).onConflictDoNothing({ target: [track_lyrics_table.track_id, track_lyrics_table.content_hash] })
		.returning({ id: track_lyrics_table.id });
	return rows.map(r => r.id);
}

export async function has_lyrics_rows(ex: Executor, track_ids: readonly string[]): Promise<Set<string>> {
	const out = new Set<string>();
	for (const part of chunks([...new Set(track_ids)])) {
		const rows = await ex.selectDistinct({ track_id: track_lyrics_table.track_id }).from(track_lyrics_table).where(inArray(track_lyrics_table.track_id, part));
		for (const r of rows) out.add(r.track_id);
	}
	return out;
}

/** Tracks whose linked Genius song (via `service_ids.genius_id`) is marked instrumental. */
export async function genius_instrumental_tracks(ex: Executor, track_ids: readonly string[]): Promise<Set<string>> {
	const out = new Set<string>();
	for (const part of chunks([...new Set(track_ids)])) {
		const rows = await ex.select({ id: service_ids_table.illusi_id })
			.from(service_ids_table)
			.innerJoin(genius_songs_table, eq(genius_songs_table.id, service_ids_table.genius_id))
			.where(and(inArray(service_ids_table.illusi_id, part), eq(genius_songs_table.instrumental, true)));
		for (const r of rows) out.add(r.id);
	}
	return out;
}

export interface BestRow {
	id: number;
	service: LyricsService;
	sync_type: SyncType;
	parsed: ParsedLyrics;
}

/** Remembers parse results without bumping `modified_at`. */
function save_parse_result(id: number, parsed: ParsedLyrics) {
	db.update(track_lyrics_table)
		.set({ parsed_cache: parsed, parser_version: PARSER_VERSION, modified_at: sql`${track_lyrics_table.modified_at}` })
		.where(eq(track_lyrics_table.id, id))
		.then(() => undefined, (err: unknown) => { log.warn(`failed to cache parse of lyrics ${id}`, err); });
}

/**
 * A row that doesn't parse is kept; the failure is logged and a review item is added once per row
 * and parser version (`parser_version` = current with an empty cache marks a known failure).
 */
function record_parse_failure(row: { id: number; track_id: string; service: LyricsService; format: string }, error: string) {
	log.warn(`lyrics ${row.id} failed to parse`, { service: row.service, format: row.format, track_id: row.track_id, error });
	db.transaction(async (tx) => {
		const marked = await tx.update(track_lyrics_table)
			.set({ parsed_cache: null, parser_version: PARSER_VERSION, modified_at: sql`${track_lyrics_table.modified_at}` })
			.where(and(eq(track_lyrics_table.id, row.id), or(sql`${track_lyrics_table.parser_version} is null`, ne(track_lyrics_table.parser_version, PARSER_VERSION))))
			.returning({ id: track_lyrics_table.id });
		if (marked.length === 0) return;
		await add_review_item(tx, {
			kind: 'LYRICS_PARSE_FAILURE',
			entity_table: 'track_lyrics_table',
			entity_id: String(row.id),
			current_value: { track_id: row.track_id, service: row.service, format: row.format },
			proposed_value: PARSER_VERSION,
			details: { error, parser_version: PARSER_VERSION }
		});
	}).catch((err: unknown) => { log.warn(`failed to record parse failure of lyrics ${row.id}`, err); });
}

/**
 * Best parsed row per track: rank on metadata, then walk each track's order a sync level at a time. Of the rows
 * at the first level with any row that parses, the one whose text most agrees with the others wins
 * (`pick_consensus`). Raw content is only loaded for the levels actually tried.
 */
export async function resolve_best_rows(ex: Executor, track_ids: readonly string[]): Promise<Map<string, BestRow>> {
	const queues = new Map<string, { id: number; service: LyricsService; sync_type: SyncType; created_at: Date }[]>();
	for (const part of chunks([...new Set(track_ids)])) {
		const metas = await ex.select({
			id: track_lyrics_table.id,
			track_id: track_lyrics_table.track_id,
			service: track_lyrics_table.service,
			sync_type: track_lyrics_table.sync_type,
			created_at: track_lyrics_table.created_at
		}).from(track_lyrics_table).where(inArray(track_lyrics_table.track_id, part));
		const grouped = new Map<string, typeof metas>();
		for (const m of metas) grouped.set(m.track_id, [...(grouped.get(m.track_id) ?? []), m]);
		for (const [track_id, rows] of grouped) queues.set(track_id, rank_lyrics(rows));
	}

	const best = new Map<string, BestRow>();
	while (queues.size > 0) {
		// Row id → its track and place in the rank order, for every row at the head's sync level.
		const next = new Map<number, { track_id: string; order: number }>();
		for (const [track_id, queue] of queues) {
			if (queue.length === 0) {
				queues.delete(track_id);
				continue;
			}
			let n = 1;
			while (n < queue.length && queue[n].sync_type === queue[0].sync_type) n++;
			queue.splice(0, n).forEach((c, order) => next.set(c.id, { track_id, order }));
		}
		if (next.size === 0) break;
		const parsed_rows = new Map<string, (BestRow & { order: number })[]>();
		for (const part of chunks([...next.keys()])) {
			const rows = await ex.select({
				id: track_lyrics_table.id,
				track_id: track_lyrics_table.track_id,
				service: track_lyrics_table.service,
				sync_type: track_lyrics_table.sync_type,
				format: track_lyrics_table.format,
				raw_content: track_lyrics_table.raw_content,
				parsed_cache: track_lyrics_table.parsed_cache,
				parser_version: track_lyrics_table.parser_version
			}).from(track_lyrics_table).where(inArray(track_lyrics_table.id, part));
			for (const row of rows) {
				let parsed: ParsedLyrics | null = null;
				if (row.parser_version === PARSER_VERSION) {
					parsed = row.parsed_cache as ParsedLyrics | null;
				} else {
					const result = try_parse_lyrics(row.format, row.sync_type, row.raw_content);
					if (result.ok) {
						parsed = result.parsed;
						save_parse_result(row.id, parsed);
					} else {
						record_parse_failure(row, result.error);
					}
				}
				if (parsed) {
					const tried = { id: row.id, service: row.service, sync_type: row.sync_type, parsed, order: next.get(row.id)!.order };
					parsed_rows.set(row.track_id, [...(parsed_rows.get(row.track_id) ?? []), tried]);
				}
			}
		}
		for (const [track_id, rows] of parsed_rows) {
			const { order: _, ...chosen } = pick_consensus(rows.sort((a, b) => a.order - b.order))!;
			best.set(track_id, chosen);
			queues.delete(track_id);
		}
	}
	return best;
}

/** Tracks that have never had any lookup. */
export async function never_looked_up(ex: Executor, track_ids: readonly string[]): Promise<string[]> {
	const seen = new Set<string>();
	const existing = new Set<string>();
	for (const part of chunks([...new Set(track_ids)])) {
		const tracks = await ex.select({ id: tracks_table.id }).from(tracks_table).where(inArray(tracks_table.id, part));
		for (const t of tracks) existing.add(t.id);
		const rows = await ex.selectDistinct({ track_id: track_lyrics_lookups_table.track_id }).from(track_lyrics_lookups_table)
			.where(and(inArray(track_lyrics_lookups_table.track_id, part), isNotNull(track_lyrics_lookups_table.service)));
		for (const r of rows) seen.add(r.track_id);
	}
	return [...existing].filter(id => !seen.has(id));
}
