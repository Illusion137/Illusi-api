import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../db';
import { service_ids_table, track_youtube_ids_table, tracks_table } from '../db/schema';

/**
 * The other YouTube uploads of a track (`track_youtube_ids_table`): kept when merges and contributions bring a second
 * id, consulted when the current one stops playing.
 */

/** Keeps `youtube_ids` as uploads of `track_id`. An id already kept for another track stays with that one. */
export async function keep_youtube_ids(ex: Executor, track_id: string, youtube_ids: readonly string[]) {
	const ids = [...new Set(youtube_ids)];
	if (ids.length === 0) return;
	await ex.insert(track_youtube_ids_table).values(ids.map(youtube_id => ({ track_id, youtube_id }))).onConflictDoNothing();
}

/** Marks an id unplayable, keeping it for the track if it wasn't yet. */
export async function mark_youtube_id_unavailable(ex: Executor, track_id: string, youtube_id: string, now: Date) {
	await ex.insert(track_youtube_ids_table).values({ track_id, youtube_id, unavailable_at: now })
		.onConflictDoUpdate({
			target: track_youtube_ids_table.youtube_id,
			set: { unavailable_at: sql`coalesce(${track_youtube_ids_table.unavailable_at}, ${now})`, modified_at: now },
			where: eq(track_youtube_ids_table.track_id, track_id)
		});
}

/** Which of these ids were found unplayable. */
export async function unavailable_youtube_ids(ex: Executor, youtube_ids: readonly string[]): Promise<Set<string>> {
	if (youtube_ids.length === 0) return new Set();
	const rows = await ex.select({ youtube_id: track_youtube_ids_table.youtube_id }).from(track_youtube_ids_table)
		.where(and(inArray(track_youtube_ids_table.youtube_id, [...new Set(youtube_ids)]), isNotNull(track_youtube_ids_table.unavailable_at)));
	return new Set(rows.map(r => r.youtube_id));
}

/** The track keeping `youtube_id` as another upload, if one does. */
export async function track_of_kept_youtube_id(ex: Executor, youtube_id: string): Promise<string | null> {
	const [row] = await ex.select({ track_id: track_youtube_ids_table.track_id }).from(track_youtube_ids_table)
		.innerJoin(tracks_table, eq(tracks_table.id, track_youtube_ids_table.track_id))
		.where(eq(track_youtube_ids_table.youtube_id, youtube_id)).limit(1);
	return row?.track_id ?? null;
}

/** A kept upload of the track still believed to play, newest first; never `current`. */
export async function live_youtube_alternate(ex: Executor, track_id: string, current: string | null): Promise<string | null> {
	const conditions = [eq(track_youtube_ids_table.track_id, track_id), isNull(track_youtube_ids_table.unavailable_at)];
	if (current) conditions.push(ne(track_youtube_ids_table.youtube_id, current));
	// An id another entity now holds can't become this one's.
	conditions.push(sql`not exists (select 1 from ${service_ids_table} s where s.youtube_id = ${track_youtube_ids_table.youtube_id})`);
	const [row] = await ex.select({ youtube_id: track_youtube_ids_table.youtube_id }).from(track_youtube_ids_table)
		.where(and(...conditions))
		.orderBy(desc(track_youtube_ids_table.created_at), track_youtube_ids_table.youtube_id)
		.limit(1);
	return row?.youtube_id ?? null;
}

/**
 * Points the track at another of its uploads when it still has `from`; `from` is kept (as unplayable when it was
 * reported so). Returns whether the id changed.
 */
export async function switch_youtube_id(tx: Tx, track_id: string, from: string | null, to: string, now: Date): Promise<boolean> {
	const updated = await tx.update(service_ids_table)
		.set({ youtube_id: to, modified_at: now })
		.where(and(eq(service_ids_table.illusi_id, track_id), from === null ? isNull(service_ids_table.youtube_id) : eq(service_ids_table.youtube_id, from)))
		.returning({ illusi_id: service_ids_table.illusi_id });
	if (updated.length === 0) return false;
	if (from) await keep_youtube_ids(tx, track_id, [from]);
	return true;
}

/** Whether the entity is a track (YouTube ids of artists are channels and albums have playlists; only tracks keep uploads). */
export async function is_track(ex: Executor, illusi_id: string): Promise<boolean> {
	const [row] = await ex.select({ id: tracks_table.id }).from(tracks_table).where(eq(tracks_table.id, illusi_id)).limit(1);
	return row !== undefined;
}
