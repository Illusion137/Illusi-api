import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../../db';
import { playlist_tracks_table, playlists_table } from '../../db/schema';
import { HttpError } from '../../core/http';

/** Who may copy a playlist. */
export function can_copy(source: { user_id: string; public: boolean; deleted: boolean }, user_id: string): boolean {
	return source.user_id === user_id || (source.public && !source.deleted);
}

/**
 * Snapshot-copies `source_id` into a new playlist owned by `user_id`: title, description, sort_mode and the source's
 * own non-deleted tracks only. Nothing inherited and nothing about the source is kept. Throws 404 if the source is
 * missing or not copyable (a private playlist's existence isn't revealed).
 */
export async function copy_playlist(tx: Tx, user_id: string, source_id: string) {
	const [source] = await tx.select().from(playlists_table).where(eq(playlists_table.id, source_id));
	if (!source || !can_copy(source, user_id)) throw new HttpError(404, 'playlist not found');

	const now = new Date();
	const [playlist] = await tx.insert(playlists_table).values({
		user_id,
		title: source.title,
		description: source.description,
		sort_mode: source.sort_mode,
		public: false,
		pinned: false,
		archived: false,
		edited_at: now
	}).returning();

	const source_tracks = await tx.select({ track_id: playlist_tracks_table.track_id })
		.from(playlist_tracks_table)
		.where(and(eq(playlist_tracks_table.playlist_id, source_id), eq(playlist_tracks_table.deleted, false)))
		.orderBy(asc(playlist_tracks_table.created_at), asc(playlist_tracks_table.track_id));
	// Distinct created_at per row keeps the source's order, which `OLDEST` sorting relies on.
	const tracks = source_tracks.length === 0
		? []
		: await tx.insert(playlist_tracks_table).values(source_tracks.map((t, i) => ({
				playlist_id: playlist.id,
				track_id: t.track_id,
				edited_at: now,
				created_at: new Date(now.getTime() + i)
			}))).returning();
	return { playlist, tracks };
}
