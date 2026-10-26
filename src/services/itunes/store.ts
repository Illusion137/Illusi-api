import { and, asc, eq, gt, inArray, isNull, lte, ne, not, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { ITunesArtist, ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { config } from '../../config';
import { db } from '../../db';
import type { Executor, Tx } from '../../db';
import {
	albums_table, artists_table, itunes_artists_table, itunes_collections_table, itunes_lookups_table, itunes_tracks_table,
	service_ids_table, tracks_artists_table, tracks_table
} from '../../db/schema';
import { enrich_service_ids } from '../../core/enrich';
import type { PendingEvents } from '../../core/events';
import { names_match } from '../../core/normalize';
import { itunes_thumbnails, upsert_thumbnails } from '../../core/thumbnails';
import { truncate_to_columns } from '../../core/truncate';
import { derive_artist, derive_collection, map_artist, map_collection, map_track } from './mapping';
import type { ITunesArtistRow, ITunesCollectionRow, ITunesTrackRow } from './mapping';
import type { LookupRequest } from './matching';
import { retry_after_for } from './records';
import type { LookupStatus } from './records';
import { pg_error_code, PG_ERRORS } from '../../core/pg_errors';

export type EntityType = 'track' | 'album' | 'artist';

/** A local entity that may be queued: an `applemusic_id` to look up directly, or names to search with. */
export interface Candidate {
	illusi_id: string;
	entity_type: EntityType;
	applemusic_id: string | null;
	request: LookupRequest | null;
}

const ITUNES_TABLE = { track: itunes_tracks_table, album: itunes_collections_table, artist: itunes_artists_table } as const;

/** `applemusic_id` as bigint, or null when it isn't a plain number (avoids cast errors). */
const applemusic_bigint = sql`case when ${service_ids_table.applemusic_id} ~ '^[0-9]{1,18}$' then ${service_ids_table.applemusic_id}::bigint end`;

const linked = (type: EntityType) => sql`exists (select 1 from ${ITUNES_TABLE[type]} where ${ITUNES_TABLE[type].id} = ${applemusic_bigint})`;

/** No lookup record, or one that isn't FOUND and whose `retry_after` has passed. */
const lookup_due = or(
	isNull(itunes_lookups_table.illusi_id),
	and(ne(itunes_lookups_table.status, 'FOUND'), or(isNull(itunes_lookups_table.retry_after), lte(itunes_lookups_table.retry_after, sql`now()`)))
);

const primary_track_artist = sql<string | null>`(select ${artists_table.name} from ${tracks_artists_table} join ${artists_table} on ${artists_table.id} = ${tracks_artists_table.artist_id} where ${tracks_artists_table.track_id} = ${tracks_table.id} order by ${tracks_artists_table.created_at}, ${artists_table.id} limit 1)`;

export interface ScanOptions { ids?: readonly string[]; after?: string; limit: number }

/**
 * Local entities with no linked iTunes row whose lookup is due (startup backfill, `enqueue_if_needed`).
 * Imported tracks are never returned. Ordered by id so the backfill can page with `after`.
 */
export async function scan_candidates(type: EntityType, opts: ScanOptions): Promise<Candidate[]> {
	if (opts.ids?.length === 0) return [];
	switch (type) {
		case 'track': {
			const rows = await db.select({
				id: tracks_table.id, title: tracks_table.title, duration_ms: tracks_table.duration_ms,
				album_name: albums_table.name, artist_name: primary_track_artist, applemusic_id: service_ids_table.applemusic_id
			}).from(tracks_table)
				.innerJoin(service_ids_table, eq(service_ids_table.illusi_id, tracks_table.id))
				.leftJoin(albums_table, eq(albums_table.id, tracks_table.album_id))
				.leftJoin(itunes_lookups_table, eq(itunes_lookups_table.illusi_id, tracks_table.id))
				.where(and(eq(tracks_table.imported, false), not(linked('track')), lookup_due, ...page_filters(tracks_table.id, opts)))
				.orderBy(asc(tracks_table.id)).limit(opts.limit);
			return rows.map(r => ({
				illusi_id: r.id, entity_type: 'track', applemusic_id: r.applemusic_id,
				request: r.artist_name ? { type: 'track', artist_name: r.artist_name, album_name: r.album_name, track_name: r.title, duration_ms: r.duration_ms } : null
			}));
		}
		case 'album': {
			const rows = await db.select({
				id: albums_table.id, name: albums_table.name, track_count: albums_table.track_count,
				artist_name: artists_table.name, applemusic_id: service_ids_table.applemusic_id
			}).from(albums_table)
				.innerJoin(service_ids_table, eq(service_ids_table.illusi_id, albums_table.id))
				.leftJoin(artists_table, eq(artists_table.id, albums_table.artist_id))
				.leftJoin(itunes_lookups_table, eq(itunes_lookups_table.illusi_id, albums_table.id))
				.where(and(not(linked('album')), lookup_due, ...page_filters(albums_table.id, opts)))
				.orderBy(asc(albums_table.id)).limit(opts.limit);
			return rows.map(r => ({
				illusi_id: r.id, entity_type: 'album', applemusic_id: r.applemusic_id,
				request: r.artist_name ? { type: 'album', artist_name: r.artist_name, album_name: r.name, track_count: r.track_count } : null
			}));
		}
		case 'artist': {
			const rows = await db.select({ id: artists_table.id, name: artists_table.name, applemusic_id: service_ids_table.applemusic_id }).from(artists_table)
				.innerJoin(service_ids_table, eq(service_ids_table.illusi_id, artists_table.id))
				.leftJoin(itunes_lookups_table, eq(itunes_lookups_table.illusi_id, artists_table.id))
				.where(and(not(linked('artist')), lookup_due, ...page_filters(artists_table.id, opts)))
				.orderBy(asc(artists_table.id)).limit(opts.limit);
			return rows.map(r => ({ illusi_id: r.id, entity_type: 'artist', applemusic_id: r.applemusic_id, request: { type: 'artist', artist_name: r.name } }));
		}
	}
}

function page_filters(id_column: typeof tracks_table.id | typeof albums_table.id | typeof artists_table.id, opts: ScanOptions): SQL[] {
	const out: SQL[] = [];
	if (opts.ids) out.push(inArray(id_column, [...opts.ids]));
	if (opts.after) out.push(gt(id_column, opts.after));
	return out;
}

/** Which local table holds this id, and whether it's an imported track. */
export async function find_entity(illusi_id: string): Promise<{ entity_type: EntityType; imported: boolean } | null> {
	const [track] = await db.select({ imported: tracks_table.imported }).from(tracks_table).where(eq(tracks_table.id, illusi_id)).limit(1);
	if (track) return { entity_type: 'track', imported: track.imported };
	const [album] = await db.select({ id: albums_table.id }).from(albums_table).where(eq(albums_table.id, illusi_id)).limit(1);
	if (album) return { entity_type: 'album', imported: false };
	const [artist] = await db.select({ id: artists_table.id }).from(artists_table).where(eq(artists_table.id, illusi_id)).limit(1);
	if (artist) return { entity_type: 'artist', imported: false };
	return null;
}

export interface LinkState { applemusic_id: string | null; linked: boolean }

/** Re-checked right before processing, since another writer may have linked or filled an id meanwhile. */
export async function link_states(type: EntityType, illusi_ids: readonly string[]): Promise<Map<string, LinkState>> {
	if (illusi_ids.length === 0) return new Map();
	const rows = await db.select({
		illusi_id: service_ids_table.illusi_id,
		applemusic_id: service_ids_table.applemusic_id,
		linked: sql<boolean>`${linked(type)}`
	}).from(service_ids_table).where(inArray(service_ids_table.illusi_id, [...illusi_ids]));
	return new Map(rows.map(r => [r.illusi_id, { applemusic_id: r.applemusic_id, linked: r.linked }]));
}

// ---- reuse of stored iTunes rows ----

/** Stored iTunes artists whose name matches. */
export async function stored_artists(artist_name: string, threshold: number): Promise<(typeof itunes_artists_table.$inferSelect)[]> {
	const rows = await db.select().from(itunes_artists_table).where(sql`lower(${itunes_artists_table.name}) = lower(${artist_name})`).limit(10);
	return rows.filter(r => names_match(artist_name, r.name, threshold));
}

/** Stored collections of these artists, shaped like lookup results so the same matcher applies. */
export async function stored_collections(artist_ids: readonly number[]): Promise<ITunesCollection[]> {
	if (artist_ids.length === 0) return [];
	const rows = await db.select().from(itunes_collections_table).where(inArray(itunes_collections_table.artist_id, [...artist_ids])).limit(1000);
	return rows.map(r => ({
		wrapperType: 'collection', collectionId: r.id, collectionName: r.name, collectionCensoredName: r.censored_name ?? undefined,
		collectionExplicitness: r.explicitness ?? undefined, trackCount: r.track_count ?? undefined, artistId: r.artist_id ?? undefined
	}));
}

/** Stored songs of these artists, shaped like lookup results. */
export async function stored_tracks(artist_ids: readonly number[]): Promise<ITunesTrack[]> {
	if (artist_ids.length === 0) return [];
	const rows = await db.select({ t: itunes_tracks_table, collection_name: itunes_collections_table.name, collection_censored_name: itunes_collections_table.censored_name })
		.from(itunes_tracks_table)
		.leftJoin(itunes_collections_table, eq(itunes_collections_table.id, itunes_tracks_table.collection_id))
		.where(inArray(itunes_tracks_table.artist_id, [...artist_ids])).limit(3000);
	return rows.map(({ t, collection_name, collection_censored_name }) => ({
		wrapperType: 'track', kind: 'song', trackId: t.id, trackName: t.name, trackCensoredName: t.censored_name ?? undefined,
		trackTimeMillis: t.track_time_millis ?? undefined, trackExplicitness: t.explicitness ?? undefined,
		collectionId: t.collection_id ?? undefined, collectionName: collection_name ?? undefined,
		collectionCensoredName: collection_censored_name ?? undefined, artistId: t.artist_id ?? undefined
	}));
}

export async function stored_track_row(id: number) {
	const [row] = await db.select().from(itunes_tracks_table).where(eq(itunes_tracks_table.id, id)).limit(1);
	return row ?? null;
}

export async function stored_collection_row(id: number) {
	const [row] = await db.select().from(itunes_collections_table).where(eq(itunes_collections_table.id, id)).limit(1);
	return row ?? null;
}

// ---- persistence ----

const strip_keys = <T extends Record<string, unknown>>(row: T) => {
	const { id: _id, ...rest } = row;
	return rest;
};

async function upsert_artist_row(tx: Tx, row: ITunesArtistRow, full: boolean) {
	const values = truncate_to_columns(itunes_artists_table, row, `itunes artist ${row.id}`);
	const q = tx.insert(itunes_artists_table).values(values);
	await (full ? q.onConflictDoUpdate({ target: itunes_artists_table.id, set: strip_keys(values) }) : q.onConflictDoNothing({ target: itunes_artists_table.id }));
}

async function upsert_collection_row(tx: Tx, row: ITunesCollectionRow, full: boolean) {
	const values = truncate_to_columns(itunes_collections_table, row, `itunes collection ${row.id}`);
	const q = tx.insert(itunes_collections_table).values(values);
	await (full ? q.onConflictDoUpdate({ target: itunes_collections_table.id, set: strip_keys(values) }) : q.onConflictDoNothing({ target: itunes_collections_table.id }));
}

async function upsert_track_row(tx: Tx, row: ITunesTrackRow) {
	const values = truncate_to_columns(itunes_tracks_table, row, `itunes track ${row.id}`);
	await tx.insert(itunes_tracks_table).values(values).onConflictDoUpdate({ target: itunes_tracks_table.id, set: strip_keys(values) });
}

/**
 * Makes sure every artist id referenced by the rows exists: the full artist row when we have it,
 * otherwise a minimal one derived from the result (never overwriting a stored row).
 * Returns the artist ids that are now safe to reference.
 */
async function ensure_artists(tx: Tx, full: ITunesArtist | null | undefined, derived_from: readonly (ITunesTrack | ITunesCollection | null | undefined)[]): Promise<Set<number>> {
	const ok = new Set<number>();
	if (full?.artistId != null && full.artistName) {
		await upsert_artist_row(tx, map_artist(full), true);
		ok.add(full.artistId);
	}
	for (const r of derived_from) {
		if (r?.artistId == null || ok.has(r.artistId)) continue;
		const row = derive_artist(r);
		if (!row) continue;
		await upsert_artist_row(tx, row, false);
		ok.add(r.artistId);
	}
	return ok;
}

const fk = (id: number | null | undefined, ok: Set<number>) => (id != null && ok.has(id) ? id : null);

/** Artist → collection → track, so the foreign keys hold. Returns the stored track row values. */
export async function persist_track(tx: Tx, data: { artist?: ITunesArtist | null; collection?: ITunesCollection | null; track: ITunesTrack }): Promise<ITunesTrackRow> {
	const artists = await ensure_artists(tx, data.artist, [data.collection, data.track]);
	let collection_ok = false;
	if (data.collection?.collectionId != null && data.collection.collectionId === data.track.collectionId) {
		const row = map_collection(data.collection);
		await upsert_collection_row(tx, { ...row, artist_id: fk(row.artist_id, artists) }, true);
		collection_ok = true;
	} else {
		const row = derive_collection(data.track);
		if (row) {
			await upsert_collection_row(tx, { ...row, artist_id: fk(row.artist_id, artists) }, false);
			collection_ok = true;
		}
	}
	const row = map_track(data.track);
	const track_row = { ...row, artist_id: fk(row.artist_id, artists), collection_id: collection_ok ? row.collection_id : null };
	await upsert_track_row(tx, track_row);
	return track_row;
}

export async function persist_collection(tx: Tx, data: { artist?: ITunesArtist | null; collection: ITunesCollection }): Promise<ITunesCollectionRow> {
	const artists = await ensure_artists(tx, data.artist, [data.collection]);
	const row = map_collection(data.collection);
	const collection_row = { ...row, artist_id: fk(row.artist_id, artists) };
	await upsert_collection_row(tx, collection_row, true);
	return collection_row;
}

export async function persist_artist(tx: Tx, artist: ITunesArtist): Promise<void> {
	await upsert_artist_row(tx, map_artist(artist), true);
}

/**
 * Sets `applemusic_id` on each local entity through the enrichment rules and, for those it now points at
 * this iTunes row, attaches the artwork and queues `itunes_track_linked`. Returns the linked ids.
 */
export async function link_entities(tx: Tx, illusi_ids: readonly string[], type: EntityType, itunes_id: number, artwork: Parameters<typeof itunes_thumbnails>[0] | null, preview_url: string | null, events: PendingEvents): Promise<string[]> {
	const out: string[] = [];
	for (const illusi_id of illusi_ids) {
		await enrich_service_ids(tx, illusi_id, { applemusic_id: String(itunes_id) }, { source: 'itunes', events });
		const [row] = await tx.select({ applemusic_id: service_ids_table.applemusic_id }).from(service_ids_table).where(eq(service_ids_table.illusi_id, illusi_id)).limit(1);
		if (row?.applemusic_id !== String(itunes_id)) continue;
		out.push(illusi_id);
		if (artwork) await upsert_thumbnails(tx, illusi_id, itunes_thumbnails(artwork));
		if (type === 'track' && preview_url) events.push('itunes_track_linked', { track_id: illusi_id, itunes_track_id: itunes_id, preview_url });
	}
	return out;
}

// ---- lookup records ----

export async function record_lookup(ex: Executor, illusi_ids: readonly string[], type: EntityType, status: LookupStatus): Promise<void> {
	if (illusi_ids.length === 0) return;
	const now = new Date();
	const existing = await ex.select({ illusi_id: itunes_lookups_table.illusi_id, attempts: itunes_lookups_table.attempts })
		.from(itunes_lookups_table).where(inArray(itunes_lookups_table.illusi_id, [...illusi_ids]));
	const attempts_by_id = new Map(existing.map(r => [r.illusi_id, r.attempts]));
	for (const illusi_id of illusi_ids) {
		const attempts = (attempts_by_id.get(illusi_id) ?? 0) + 1;
		const retry_after = retry_after_for(status, attempts, now, {
			not_found_retry_days: config.ITUNES_NOT_FOUND_RETRY_DAYS,
			error_retry_minutes: config.ITUNES_ERROR_RETRY_MINUTES,
			max_error_doublings: 6
		});
		const values = { illusi_id, entity_type: type, status, attempts, attempted_at: now, retry_after };
		// The entity may have been deleted or merged away meanwhile; the FK then rejects the row, which is fine.
		await ex.insert(itunes_lookups_table).values(values)
			.onConflictDoUpdate({ target: itunes_lookups_table.illusi_id, set: { entity_type: type, status, attempts, attempted_at: now, retry_after } })
			.catch((err: unknown) => {
				if (pg_error_code(err) !== PG_ERRORS.foreign_key_violation) throw err;
			});
	}
}
