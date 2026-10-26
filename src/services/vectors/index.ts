import { and, desc, eq, getColumns, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Executor, Tx } from '../../db';
import { db } from '../../db';
import { track_plays_table, track_sample_data_table, track_vectors_table, user_tracks_table } from '../../db/schema';
import { logger } from '../../core/log';
import { CURRENT_VECTOR_VERSION, encode_sample } from './encoding';

export { CURRENT_VECTOR_VERSION, encode_sample, VECTOR_DIMENSIONS } from './encoding';

const log = logger('vectors');

export interface SimilarTrack { track_id: string; distance: number }

type SampleRow = typeof track_sample_data_table.$inferSelect;

async function upsert_vectors(ex: Executor, rows: SampleRow[]) {
	if (rows.length === 0) return;
	await ex.insert(track_vectors_table)
		.values(rows.map(row => ({ track_id: row.id, embedding: encode_sample(row), version: CURRENT_VECTOR_VERSION })))
		.onConflictDoUpdate({
			target: track_vectors_table.track_id,
			set: { embedding: sql`excluded.embedding`, version: sql`excluded.version`, modified_at: sql`now()` }
		});
}

/** Writes the vector for one sample row in the caller's transaction. No-op if the row doesn't exist. */
export async function write_vector(tx: Tx, track_id: string): Promise<void> {
	const rows = await tx.select().from(track_sample_data_table).where(eq(track_sample_data_table.id, track_id));
	await upsert_vectors(tx, rows);
}

/**
 * Rebuilds vectors for every sample row with no vector or an older encoding version.
 * Uses only Postgres data, never audio. Returns the number of vectors written.
 */
export async function rebuild_stale_vectors(batch_size = 500): Promise<number> {
	let total = 0;
	for (;;) {
		const rows = await db.select(getColumns(track_sample_data_table))
			.from(track_sample_data_table)
			.leftJoin(track_vectors_table, eq(track_vectors_table.track_id, track_sample_data_table.id))
			.where(or(isNull(track_vectors_table.track_id), lt(track_vectors_table.version, CURRENT_VECTOR_VERSION)))
			.limit(batch_size);
		if (rows.length === 0) break;
		await upsert_vectors(db, rows);
		total += rows.length;
		if (rows.length < batch_size) break;
	}
	if (total > 0) log.info(`rebuilt ${total} track vectors (version ${CURRENT_VECTOR_VERSION})`);
	return total;
}

const vector_literal = (v: readonly number[]) => sql`${`[${v.join(',')}]`}::vector`;

export interface VectorSearchOptions {
	/** Tracks never returned. */
	exclude_track_ids?: readonly string[];
	/** Excludes tracks this user deleted from their library. */
	user_id?: string;
	/** Also excludes everything in this user's (non-deleted) library. */
	exclude_library_of?: string;
	/** Any extra relational condition on `track_vectors_table.track_id` (explicit, artist, ...). */
	where?: SQL;
}

/** k nearest neighbours of an embedding by cosine distance (`<=>`), uses the HNSW index. */
export async function search_by_vector(embedding: readonly number[], k: number, options: VectorSearchOptions = {}): Promise<SimilarTrack[]> {
	const distance = sql<number>`${track_vectors_table.embedding} <=> ${vector_literal(embedding)}`.mapWith(Number);
	const conditions: (SQL | undefined)[] = [options.where];
	if (options.exclude_track_ids?.length) conditions.push(notInArray(track_vectors_table.track_id, [...options.exclude_track_ids]));
	if (options.user_id) {
		conditions.push(sql`not exists (select 1 from ${user_tracks_table} where ${user_tracks_table.user_id} = ${options.user_id} and ${user_tracks_table.track_id} = ${track_vectors_table.track_id} and ${user_tracks_table.deleted})`);
	}
	if (options.exclude_library_of) {
		conditions.push(sql`not exists (select 1 from ${user_tracks_table} where ${user_tracks_table.user_id} = ${options.exclude_library_of} and ${user_tracks_table.track_id} = ${track_vectors_table.track_id} and not ${user_tracks_table.deleted})`);
	}
	const rows = await db.select({ track_id: track_vectors_table.track_id, distance })
		.from(track_vectors_table)
		.where(and(...conditions))
		.orderBy(distance)
		.limit(k);
	return rows.map(r => ({ track_id: r.track_id, distance: r.distance }));
}

/** k nearest neighbours of a track, excluding itself and the user's deleted tracks. */
export async function similar_tracks(track_id: string, k: number, user_id?: string): Promise<SimilarTrack[]> {
	const [row] = await db.select({ embedding: track_vectors_table.embedding })
		.from(track_vectors_table)
		.where(eq(track_vectors_table.track_id, track_id));
	if (!row) return [];
	return search_by_vector(row.embedding, k, { exclude_track_ids: [track_id], user_id });
}

/** Mean of the stored vectors of a set of tracks (pgvector `avg`), or null if none has a vector. */
export async function mean_vector(track_ids: readonly string[]): Promise<number[] | null> {
	if (track_ids.length === 0) return null;
	const [row] = await db.select({ mean: sql<string | null>`avg(${track_vectors_table.embedding})::text` })
		.from(track_vectors_table)
		.where(inArray(track_vectors_table.track_id, [...track_ids]));
	return row?.mean ? JSON.parse(row.mean) as number[] : null;
}

/**
 * Taste search: the mean vector of a set of tracks (a playlist, recent plays, a library),
 * searched against all vectors. The input tracks are excluded unless `exclude_track_ids` is given.
 */
export async function taste_search(track_ids: readonly string[], k: number, exclude_track_ids?: readonly string[], options: Omit<VectorSearchOptions, 'exclude_track_ids'> = {}): Promise<SimilarTrack[]> {
	const mean = await mean_vector(track_ids);
	if (!mean) return [];
	return search_by_vector(mean, k, { ...options, exclude_track_ids: exclude_track_ids ?? track_ids });
}

/** Track ids in a user's non-deleted library, a taste-vector source. */
export async function user_library_track_ids(user_id: string): Promise<string[]> {
	const rows = await db.select({ track_id: user_tracks_table.track_id })
		.from(user_tracks_table)
		.where(and(eq(user_tracks_table.user_id, user_id), eq(user_tracks_table.deleted, false)));
	return rows.map(r => r.track_id);
}

/** Distinct track ids from a user's most recent plays, a taste-vector source. */
export async function recent_play_track_ids(user_id: string, limit = 200): Promise<string[]> {
	const rows = await db.select({ track_id: track_plays_table.track_id })
		.from(track_plays_table)
		.where(eq(track_plays_table.user_id, user_id))
		.orderBy(desc(track_plays_table.created_at))
		.limit(limit);
	return [...new Set(rows.map(r => r.track_id))];
}
