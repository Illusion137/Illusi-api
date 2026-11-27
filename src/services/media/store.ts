import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { config } from '../../config';
import { db } from '../../db';
import type { Executor } from '../../db';
import {
	media_table, playlist_tracks_table, playlists_table, service_ids_table, track_downloads_table, track_lyrics_table, tracks_table, user_tracks_table
} from '../../db/schema';
import { consume_action_token } from '../../core/actions';
import { HttpError } from '../../core/http';
import type { AuthUser } from '../../core/auth/tokens';
import { PendingEvents } from '../../core/events';
import { ProvenanceLog } from '../../core/provenance';
import { clear_backpacked } from '../backpack';
import type { ReceivedUpload } from './upload';

export type MediaRow = typeof media_table.$inferSelect;

/**
 * Which id the action token was issued for. It may name the pre-merge id the client still holds; consuming with
 * that id keeps the target check exact. Anything unparseable falls through to the resolved id (and then fails).
 */
export function token_target(token: string, requested_id: string, resolved_id: string): string {
	try {
		return decodeJwt(token).tgt === requested_id ? requested_id : resolved_id;
	} catch {
		return resolved_id;
	}
}

export interface StoreUploadInput {
	user: AuthUser;
	requested_id: string;
	track_id: string;
	upload: ReceivedUpload;
	quality: string | null;
	token: string | null;
	/** When the upload request arrived: an action token valid then is accepted, however long the upload took. */
	started?: Date;
}

/**
 * Dedupes on (track_id, content_hash). Otherwise, if the track has no media yet (the first upload sticks; a later one
 * is refused with 409), moves the temp file to `MEDIA_DIR/<uuid>.<ext>` and inserts the row with provenance;
 * `media_inserted` is emitted after commit. A file moved into place is removed again only if its row never committed
 * (it was never stored media).
 */
export async function store_upload({ user, requested_id, track_id, upload, quality, token, started }: StoreUploadInput): Promise<{ media: MediaRow; duplicate: boolean }> {
	const events = new PendingEvents();
	let moved_to: string | undefined;
	let keep_file = false;
	try {
		const result = await db.transaction(async (tx) => {
			// Serializes uploads for the track, so two first uploads can't both stick.
			await tx.select({ id: tracks_table.id }).from(tracks_table).where(eq(tracks_table.id, track_id)).for('update');
			const find_existing = async () => (await tx.select().from(media_table)
				.where(and(eq(media_table.track_id, track_id), eq(media_table.content_hash, upload.sha256))))[0];
			const existing = await find_existing();
			// A retried upload: answered without using the token (the first attempt may already have used it).
			if (existing) return { media: existing, duplicate: true };
			const [other] = await tx.select().from(media_table).where(eq(media_table.track_id, track_id)).orderBy(asc(media_table.created_at), asc(media_table.id)).limit(1);
			if (other) throw new HttpError(409, 'track already has media', { code: 'TRACK_HAS_MEDIA', media: other });

			const jti = token === null
				? null
				: (await consume_action_token(tx, user, token, 'UPLOAD_MEDIA', token_target(token, requested_id, track_id), started)).jti;

			const resource_id = `${randomUUID()}.${upload.kind.ext}`;
			moved_to = path.join(config.MEDIA_DIR, resource_id);
			await rename(upload.temp_path, moved_to);

			const [row] = await tx.insert(media_table)
				.values({ track_id, resource_id, quality, content_hash: upload.sha256, uploaded_by: user.id })
				.onConflictDoNothing()
				.returning();
			if (!row) {
				// A concurrent upload of the same file won the unique index.
				const winner = await find_existing();
				if (!winner) throw new Error('media insert conflicted but no row found');
				return { media: winner, duplicate: true };
			}

			const provenance = new ProvenanceLog('media', user.id, jti);
			provenance.touch('media_table', row.id, ['*']);
			await provenance.write(tx);
			await clear_backpacked(tx, track_id);
			events.push('media_inserted', { track_id, resource_id });
			return { media: row, duplicate: false };
		});
		keep_file = !result.duplicate;
		events.flush();
		return result;
	} finally {
		if (moved_to !== undefined && !keep_file) await rm(moved_to, { force: true });
	}
}

/** The user has the track in their non-deleted library or in one of their non-deleted playlists. */
export async function user_can_access_tracks(ex: Executor, user_id: string, track_ids: readonly string[]): Promise<boolean> {
	if (track_ids.length === 0) return false;
	const [library] = await ex.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
		.where(and(eq(user_tracks_table.user_id, user_id), inArray(user_tracks_table.track_id, [...track_ids]), eq(user_tracks_table.deleted, false)))
		.limit(1);
	if (library) return true;
	const [playlist] = await ex.select({ track_id: playlist_tracks_table.track_id }).from(playlist_tracks_table)
		.innerJoin(playlists_table, eq(playlists_table.id, playlist_tracks_table.playlist_id))
		.where(and(
			eq(playlists_table.user_id, user_id),
			eq(playlists_table.deleted, false),
			eq(playlist_tracks_table.deleted, false),
			inArray(playlist_tracks_table.track_id, [...track_ids])
		))
		.limit(1);
	return playlist !== undefined;
}

/** The library row's track is downloaded on this device. */
function downloaded_on(ex: Executor, session_family_id: string) {
	return exists(ex.select({ one: sql`1` }).from(track_downloads_table).where(and(
		eq(track_downloads_table.session_family_id, session_family_id),
		eq(track_downloads_table.track_id, user_tracks_table.track_id)
	)));
}

/**
 * The track has lyrics, none of them word or syllable synced: vocal detection can help sync them. Correlated on
 * `user_tracks_table.track_id`.
 */
function lacks_word_synced_lyrics(ex: Executor) {
	const lyrics = (word_synced: boolean) => ex.select({ one: sql`1` }).from(track_lyrics_table).where(and(
		eq(track_lyrics_table.track_id, user_tracks_table.track_id),
		word_synced ? inArray(track_lyrics_table.sync_type, ['WORD', 'SYLLABLE']) : undefined
	));
	return and(exists(lyrics(false)), notExists(lyrics(true)));
}

/**
 * The track is on SoundCloud and no other streaming service. SoundCloud uploads are taken down without warning, which
 * would leave the device's file the only copy. Correlated on `user_tracks_table.track_id`.
 */
function only_on_soundcloud(ex: Executor) {
	const ids = service_ids_table;
	return exists(ex.select({ one: sql`1` }).from(ids).where(and(
		eq(ids.illusi_id, user_tracks_table.track_id),
		or(isNotNull(ids.soundcloud_id), isNotNull(ids.soundcloud_permalink)),
		...[ids.youtube_id, ids.spotify_id, ids.amazonmusic_id, ids.applemusic_id, ids.bandlab_id, ids.audiomack_id, ids.deezer_id,
			ids.pandora_id, ids.tidal_id].map(c => isNull(c))
	)));
}

/**
 * Track ids that need an UPLOAD_MEDIA request for this device (`user.sid`): every track downloaded on it without
 * media. Ordered by id for cursor paging; `pending_upload_actions` orders them by how badly each copy is wanted.
 */
export async function pending_upload_track_ids(ex: Executor, user: Pick<AuthUser, 'id' | 'sid'>, limit: number, after?: string): Promise<string[]> {
	const rows = await ex.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
		.where(and(
			eq(user_tracks_table.user_id, user.id),
			eq(user_tracks_table.deleted, false),
			downloaded_on(ex, user.sid),
			after === undefined ? undefined : gt(user_tracks_table.track_id, after),
			notExists(ex.select({ one: media_table.id }).from(media_table).where(eq(media_table.track_id, user_tracks_table.track_id)))
		))
		.orderBy(asc(user_tracks_table.track_id))
		.limit(limit);
	return rows.map(r => r.track_id);
}

/**
 * Like `pending_upload_track_ids`, limited to backpacked tracks, longest-unavailable first. Any user who downloaded the
 * track is asked, on each device that has it, without waiting on research: the device's file plays now.
 */
export async function backpacked_upload_track_ids(ex: Executor, user: Pick<AuthUser, 'id' | 'sid'>, limit: number): Promise<string[]> {
	const rows = await ex.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
		.innerJoin(tracks_table, eq(tracks_table.id, user_tracks_table.track_id))
		.where(and(
			eq(user_tracks_table.user_id, user.id),
			eq(user_tracks_table.deleted, false),
			downloaded_on(ex, user.sid),
			eq(tracks_table.backpacked, true),
			notExists(ex.select({ one: media_table.id }).from(media_table).where(eq(media_table.track_id, user_tracks_table.track_id)))
		))
		.orderBy(asc(tracks_table.backpacked_at), asc(user_tracks_table.track_id))
		.limit(limit);
	return rows.map(r => r.track_id);
}

/**
 * Like `pending_upload_track_ids`, limited to imported tracks: the device's file is the only copy anywhere, so these
 * go ahead of tracks wanted only for lyrics syncing.
 */
export async function imported_upload_track_ids(ex: Executor, user: Pick<AuthUser, 'id' | 'sid'>, limit: number): Promise<string[]> {
	const rows = await ex.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
		.innerJoin(tracks_table, eq(tracks_table.id, user_tracks_table.track_id))
		.where(and(
			eq(user_tracks_table.user_id, user.id),
			eq(user_tracks_table.deleted, false),
			downloaded_on(ex, user.sid),
			eq(tracks_table.imported, true),
			notExists(ex.select({ one: media_table.id }).from(media_table).where(eq(media_table.track_id, user_tracks_table.track_id)))
		))
		.orderBy(asc(user_tracks_table.track_id))
		.limit(limit);
	return rows.map(r => r.track_id);
}

/** Like `pending_upload_track_ids`, limited to tracks only on SoundCloud: the next takedown may leave the device's file the only copy. */
export async function soundcloud_upload_track_ids(ex: Executor, user: Pick<AuthUser, 'id' | 'sid'>, limit: number): Promise<string[]> {
	const rows = await ex.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
		.where(and(
			eq(user_tracks_table.user_id, user.id),
			eq(user_tracks_table.deleted, false),
			downloaded_on(ex, user.sid),
			only_on_soundcloud(ex),
			notExists(ex.select({ one: media_table.id }).from(media_table).where(eq(media_table.track_id, user_tracks_table.track_id)))
		))
		.orderBy(asc(user_tracks_table.track_id))
		.limit(limit);
	return rows.map(r => r.track_id);
}

/** Like `pending_upload_track_ids`, limited to tracks whose lyrics aren't word synced: vocal detection can help sync them. */
export async function lyrics_upload_track_ids(ex: Executor, user: Pick<AuthUser, 'id' | 'sid'>, limit: number): Promise<string[]> {
	const rows = await ex.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
		.where(and(
			eq(user_tracks_table.user_id, user.id),
			eq(user_tracks_table.deleted, false),
			downloaded_on(ex, user.sid),
			lacks_word_synced_lyrics(ex),
			notExists(ex.select({ one: media_table.id }).from(media_table).where(eq(media_table.track_id, user_tracks_table.track_id)))
		))
		.orderBy(asc(user_tracks_table.track_id))
		.limit(limit);
	return rows.map(r => r.track_id);
}
