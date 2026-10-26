import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { media_table, tracks_table } from '../../db/schema';
import { issue_actions } from '../../core/actions';
import type { ActionType } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { HttpError, parse_body, require_user, uuid_schema } from '../../core/http';
import { logger } from '../../core/log';
import { resolve_redirect } from '../../core/redirects';
import { parse_range } from './range';
import { resource_ext, resource_path } from './resource_id';
import { MIME_BY_EXT } from './sniff';
import { backpacked_upload_track_ids, pending_upload_track_ids, store_upload, user_can_access_tracks } from './store';
import { receive_upload } from './upload';

export { parse_range } from './range';
export { is_valid_resource_id } from './resource_id';
export { sniff_audio } from './sniff';

const log = logger('media');

/** Mounted after `require_auth`: `POST /tracks/:id/media`, `GET /media/requests`, `GET /media/:resource_id`. */
export const media_router = Router();

const upload_fields_schema = z.object({
	quality: z.string().trim().min(1).max(32).optional(),
	token: z.string().min(1).max(4096).optional()
});

media_router.post('/tracks/:id/media', async (req, res) => {
	const user = require_user(req);
	const requested = uuid_schema.safeParse(req.params.id);
	if (!requested.success) throw new HttpError(400, 'invalid track id');
	const track_id = await resolve_redirect(db, requested.data);
	const [track] = await db.select({ id: tracks_table.id }).from(tracks_table).where(eq(tracks_table.id, track_id));
	if (!track) {
		res.setHeader('Connection', 'close');
		throw new HttpError(404, 'track not found');
	}

	let upload;
	try {
		upload = await receive_upload(req, path.join(config.MEDIA_DIR, '.incoming'), config.MEDIA_MAX_BYTES);
	} catch (err) {
		res.setHeader('Connection', 'close');
		throw err;
	}
	try {
		const fields = parse_body(upload_fields_schema, upload.fields);
		const result = await store_upload({
			user,
			requested_id: requested.data,
			track_id,
			upload,
			quality: fields.quality ?? null,
			token: fields.token ?? null
		});
		if (!result.duplicate) log.info('media stored', { track_id, resource_id: result.media.resource_id, bytes: upload.size, user_id: user.id });
		res.status(result.duplicate ? 200 : 201).json(result);
	} finally {
		// Gone already if it was moved into place.
		await rm(upload.temp_path, { force: true });
	}
});

const requests_query_schema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.uuid().optional()
});

async function upload_actions(user: AuthUser, track_ids: readonly string[]): Promise<ActionType[]> {
	return issue_actions(user, track_ids.map(track_id => ({ type: 'UPLOAD_MEDIA' as const, track_id })));
}

/** Pending UPLOAD_MEDIA actions for this user, at most `limit`, backpacked tracks first. */
export async function pending_upload_actions(user: AuthUser, limit: number): Promise<ActionType[]> {
	if (limit <= 0) return [];
	const backpacked = await backpacked_upload_track_ids(db, user.id, limit);
	const rest = backpacked.length < limit ? await pending_upload_track_ids(db, user.id, limit) : [];
	const ids = [...new Set([...backpacked, ...rest])].slice(0, limit);
	return upload_actions(user, ids);
}

// Must be registered before `/media/:resource_id`.
media_router.get('/media/requests', async (req, res) => {
	const user = require_user(req);
	const query = requests_query_schema.safeParse(req.query);
	if (!query.success) throw new HttpError(400, 'invalid query', { issues: query.error.issues });
	const { limit, cursor } = query.data;
	const track_ids = await pending_upload_track_ids(db, user.id, limit, cursor);
	res.json({
		actions: await upload_actions(user, track_ids),
		next_cursor: track_ids.length === limit ? track_ids[track_ids.length - 1] : null
	});
});

media_router.get('/media/:resource_id', async (req, res) => {
	const user = require_user(req);
	const resource_id = req.params.resource_id;
	const ext = resource_ext(resource_id);
	const file_path = resource_path(config.MEDIA_DIR, resource_id);
	if (ext === null || file_path === null) throw new HttpError(400, 'invalid resource id');

	const rows = await db.select({ track_id: media_table.track_id }).from(media_table).where(eq(media_table.resource_id, resource_id));
	if (rows.length === 0) throw new HttpError(404, 'media not found');
	if (!(await user_can_access_tracks(db, user.id, rows.map(r => r.track_id)))) throw new HttpError(403, 'track is not in your library');

	let size: number;
	try {
		size = (await stat(file_path)).size;
	} catch {
		log.error('media file missing', { resource_id });
		throw new HttpError(404, 'media file not found');
	}

	// Stored media never changes, so the resource id is a strong validator.
	const etag = `"${resource_id}"`;
	const if_range = req.headers['if-range'];
	const range = if_range === undefined || if_range === etag ? parse_range(req.headers.range, size) : { type: 'full' as const };

	res.setHeader('Accept-Ranges', 'bytes');
	res.setHeader('ETag', etag);
	res.setHeader('Content-Type', MIME_BY_EXT[ext]);
	res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

	if (range.type === 'unsatisfiable') {
		res.setHeader('Content-Range', `bytes */${size}`);
		res.status(416).end();
		return;
	}
	const start = range.type === 'partial' ? range.start : 0;
	const end = range.type === 'partial' ? range.end : size - 1;
	if (range.type === 'partial') {
		res.status(206);
		res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
	}
	res.setHeader('Content-Length', String(size === 0 ? 0 : end - start + 1));
	if (req.method === 'HEAD' || size === 0) {
		res.end();
		return;
	}
	try {
		await pipeline(createReadStream(file_path, { start, end }), res);
	} catch (err) {
		// Client disconnects mid-stream are normal; anything else after headers were sent can only be logged.
		if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warn('media stream failed', { resource_id, err });
	}
});
