import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { tracks_table, user_tracks_table } from '../../db/schema';
import { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { clamp_edited_at, lww_wins } from '../sync/lww';
import { remove_artwork_files } from './artwork';

type TrackRow = typeof tracks_table.$inferSelect;

export interface TrackArtworkResult { track: Pick<TrackRow, 'id' | 'artwork_id' | 'artwork_edited_at'>; applied: boolean }

/**
 * Sets (`new_artwork_id`) or clears (null) an imported track's artwork, last-write-wins on `artwork_edited_at`. Anyone
 * with the track in their library may, since imports that match share one track. The replaced file, or the new one
 * when the change lost, is removed after commit.
 */
export async function set_track_artwork(user_id: string, track_id: string, new_artwork_id: string | null, client_edited_at: Date | null): Promise<TrackArtworkResult> {
	const now = new Date();
	const edited_at = clamp_edited_at(client_edited_at ?? now, now);
	const events = new PendingEvents();
	let orphan: string | null = null;
	const result = await db.transaction(async (tx) => {
		const [cur] = await tx.select({ id: tracks_table.id, imported: tracks_table.imported, artwork_id: tracks_table.artwork_id, artwork_edited_at: tracks_table.artwork_edited_at })
			.from(tracks_table)
			.innerJoin(user_tracks_table, and(eq(user_tracks_table.track_id, tracks_table.id), eq(user_tracks_table.user_id, user_id), eq(user_tracks_table.deleted, false)))
			.where(eq(tracks_table.id, track_id))
			.for('update', { of: tracks_table });
		if (!cur) throw new HttpError(404, 'track not found in your library');
		if (!cur.imported) throw new HttpError(409, 'only imported tracks take custom artwork', { code: 'NOT_IMPORTED' });
		const track = { id: cur.id, artwork_id: cur.artwork_id, artwork_edited_at: cur.artwork_edited_at };
		if (!lww_wins(cur.artwork_edited_at, edited_at)) {
			orphan = new_artwork_id;
			return { track, applied: false };
		}
		const [updated] = await tx.update(tracks_table)
			.set({ artwork_id: new_artwork_id, artwork_edited_at: edited_at })
			.where(eq(tracks_table.id, track_id))
			.returning({ id: tracks_table.id, artwork_id: tracks_table.artwork_id, artwork_edited_at: tracks_table.artwork_edited_at });
		orphan = cur.artwork_id;
		events.push('user_library_changed', { user_id });
		return { track: updated, applied: true };
	}).catch(async (err: unknown) => {
		await remove_artwork_files([new_artwork_id]);
		throw err;
	});
	events.flush();
	if (orphan !== null && orphan !== result.track.artwork_id) await remove_artwork_files([orphan]);
	return result;
}
