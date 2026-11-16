import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { playlists_table } from '../../db/schema';
import { require_disk_space } from '../../core/disk';
import { PendingEvents } from '../../core/events';
import { HttpError, parse_body, require_user, uuid_schema } from '../../core/http';
import { logger } from '../../core/log';
import { rate_limit_user } from '../../core/rate_limit';
import { matches_if_none_match } from '../catalog/validators';
import { ARTWORK_SUBDIR, artwork_path, owned_playlist, receive_image, set_artwork, store_artwork_file } from './artwork';
import { copy_playlist } from './copy';
import { remote_media_url } from '../media/remote';

export { assert_inheritance_allowed, creates_cycle } from './inheritance';
export { invalidate_user_cache, resolve_playlist, resolve_playlist_track_ids } from './resolve';
export { remove_artwork_files } from './artwork';

const log = logger('playlists');

/**
 * Mounted after `require_auth`: `POST /playlists/:id/copy`, `PUT|DELETE /playlists/:id/artwork`,
 * `GET /artwork/:artwork_id`.
 */
export const playlists_router = Router();

playlists_router.post('/playlists/:id/copy', async (req, res) => {
	const user = require_user(req);
	const id = uuid_schema.safeParse(req.params.id);
	if (!id.success) throw new HttpError(400, 'invalid playlist id');
	const events = new PendingEvents();
	const result = await db.transaction(async (tx) => {
		const copied = await copy_playlist(tx, user.id, id.data);
		events.push('user_library_changed', { user_id: user.id });
		return copied;
	});
	events.flush();
	res.status(201).json(result);
});

const edited_at_schema = z.object({ edited_at: z.iso.datetime({ offset: true }).optional() });
const artwork_limit = rate_limit_user('playlist_artwork', 30, 60_000);

function playlist_id(raw: unknown): string {
	const id = uuid_schema.safeParse(raw);
	if (!id.success) throw new HttpError(400, 'invalid playlist id');
	return id.data;
}

playlists_router.put('/playlists/:id/artwork', artwork_limit, require_disk_space, async (req, res) => {
	const user = require_user(req);
	let id: string;
	let upload;
	try {
		id = playlist_id(req.params.id);
		await owned_playlist(user.id, id);
		upload = await receive_image(req, path.join(config.MEDIA_DIR, '.incoming'), config.ARTWORK_MAX_BYTES);
	} catch (err) {
		// The body may not have been read; don't let the client keep sending it.
		res.setHeader('Connection', 'close');
		throw err;
	}
	try {
		const fields = parse_body(edited_at_schema, upload.fields);
		const artwork_id = await store_artwork_file(upload.temp_path);
		const result = await set_artwork(user.id, id, artwork_id, fields.edited_at ? new Date(fields.edited_at) : null);
		if (result.applied) log.info('playlist artwork set', { playlist_id: id, artwork_id, source: upload.kind });
		res.json(result);
	} finally {
		await rm(upload.temp_path, { force: true });
	}
});

playlists_router.delete('/playlists/:id/artwork', artwork_limit, async (req, res) => {
	const user = require_user(req);
	const id = playlist_id(req.params.id);
	const query = edited_at_schema.safeParse(req.query);
	if (!query.success) throw new HttpError(400, 'invalid query', { issues: query.error.issues });
	res.json(await set_artwork(user.id, id, null, query.data.edited_at ? new Date(query.data.edited_at) : null));
});

/** The owner, or anyone while the playlist is public and not deleted. Otherwise 404. */
playlists_router.get('/artwork/:artwork_id', async (req, res) => {
	const user = require_user(req);
	const artwork_id = req.params.artwork_id;
	const file = artwork_path(artwork_id);
	if (file === null) throw new HttpError(400, 'invalid artwork id');
	const [playlist] = await db.select({ user_id: playlists_table.user_id, public: playlists_table.public, deleted: playlists_table.deleted })
		.from(playlists_table).where(eq(playlists_table.artwork_id, artwork_id)).limit(1);
	if (!playlist || (playlist.user_id !== user.id && (!playlist.public || playlist.deleted))) throw new HttpError(404, 'artwork not found');

	// A new upload always gets a new id, so the id is a strong validator and the file can be cached forever.
	const etag = `"${artwork_id}"`;
	res.setHeader('ETag', etag);
	res.setHeader('Content-Type', 'image/jpeg');
	res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
	if (matches_if_none_match(req.headers['if-none-match'], etag)) {
		res.status(304).end();
		return;
	}
	let size: number;
	try {
		size = (await stat(file)).size;
	} catch {
		// Moved to the media bucket by scripts/backup-media.sh: the bucket serves it publicly.
		const remote = remote_media_url(`${ARTWORK_SUBDIR}/${artwork_id}`);
		if (remote) {
			res.redirect(302, remote);
			return;
		}
		log.error('artwork file missing', { artwork_id });
		throw new HttpError(404, 'artwork file not found');
	}
	if (config.MEDIA_ACCEL_PREFIX) {
		res.setHeader('X-Accel-Redirect', `${config.MEDIA_ACCEL_PREFIX}${ARTWORK_SUBDIR}/${artwork_id}`);
		res.end();
		return;
	}
	res.setHeader('Content-Length', String(size));
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	try {
		await pipeline(createReadStream(file), res);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warn('artwork stream failed', { artwork_id, err });
	}
});
