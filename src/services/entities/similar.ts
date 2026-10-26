/**
 * Similar artists: pairs are stored exactly as submitted (one row or both directions), the server
 * never adds the reverse row, and queries look in both directions so both forms mean the same thing.
 */
import { sql } from 'drizzle-orm';
import type { Executor } from '../../db';
import { similar_artists_table } from '../../db/schema';

export interface SimilarPair { artist_id: string; similar_artist_id: string }

/** Drops self pairs (refs can resolve to the same id) and exact duplicates; keeps each pair's direction. */
export function prepare_similar_pairs(pairs: readonly SimilarPair[]): SimilarPair[] {
	const seen = new Set<string>();
	const out: SimilarPair[] = [];
	for (const p of pairs) {
		if (p.artist_id === p.similar_artist_id) continue;
		const key = `${p.artist_id}:${p.similar_artist_id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(p);
	}
	return out;
}

/** The other artist of every row touching `artist_id`, in either direction, without duplicates. */
export function other_artists(rows: readonly SimilarPair[], artist_id: string): string[] {
	const out = new Set<string>();
	for (const r of rows) {
		if (r.artist_id === artist_id && r.similar_artist_id !== artist_id) out.add(r.similar_artist_id);
		else if (r.similar_artist_id === artist_id && r.artist_id !== artist_id) out.add(r.artist_id);
	}
	return [...out];
}

/** `WHERE artist_id = $1 OR similar_artist_id = $1`, returning the other artist, `DISTINCT` (uses both indexes). */
export async function similar_artist_ids(ex: Executor, artist_id: string): Promise<string[]> {
	const t = similar_artists_table;
	const rows = await ex.execute<{ id: string }>(sql`
		select ${t.similar_artist_id} as id from ${t} where ${t.artist_id} = ${artist_id}
		union
		select ${t.artist_id} as id from ${t} where ${t.similar_artist_id} = ${artist_id}
	`, 'objects');
	return rows.map(r => r.id);
}
