import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { media_table, tracks_table } from '../../db/schema';
import { check_action_token, issue_actions } from '../../core/actions';
import type { ActionType } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { require_disk_space } from '../../core/disk';
import { HttpError, parse_body, require_user, uuid_schema } from '../../core/http';
import { logger } from '../../core/log';
import { rate_limit_user } from '../../core/rate_limit';
import { resolve_redirect } from '../../core/redirects';
import { parse_range } from './range';
import { remote_media_url } from './remote';
import { resource_ext, resource_path } from './resource_id';
import { MIME_BY_EXT } from './sniff';
import { backpacked_upload_track_ids, imported_upload_track_ids, lyrics_upload_track_ids, pending_upload_track_ids, soundcloud_upload_track_ids, store_upload, token_target, user_can_access_tracks } from './store';
import { M4A_KIND, transcode_to_m4a } from './transcode';
import { receive_upload } from './upload';

export { parse_range } from './range';
export { is_valid_resource_id } from './resource_id';
export { sniff_audio } from './sniff';

const log = logger('media');

/** Mounted after `require_auth`: `POST /tracks/:id/media`, `GET /media/requests`. */
export const media_router = Router();

/** Mounted before `require_auth`: `GET /media/:resource_id`, public to anyone holding the resource id. */
export const public_media_router = Router();

const upload_fields_schema = z.object({
	quality: z.string().trim().min(1).max(32).optional(),
	token: z.string().min(1).max(4096).optional()
});

const upload_limit = rate_limit_user('media_upload', config.MEDIA_UPLOADS_PER_HOUR, 60 * 60_000);

/** The track's first media (the one served), if any. */
async function existing_media(track_id: string) {
	const [row] = await db.select().from(media_table).where(eq(media_table.track_id, track_id)).orderBy(asc(media_table.created_at), asc(media_table.id)).limit(1);
	return row;
}

/**
 * Everything that can refuse an upload is checked before its body is read, so a client never sends 200 MB for
 * nothing: an UPLOAD_MEDIA token in `X-Action-Token` is checked (not used up), an unsolicited upload must be for a
 * track in the user's library, and a track that already has media takes no more (the first upload sticks).
 */
media_router.post('/tracks/:id/media', require_disk_space, upload_limit, async (req, res) => {
	const started = new Date();
	const user = require_user(req);
	const requested = uuid_schema.safeParse(req.params.id);
	if (!requested.success) throw new HttpError(400, 'invalid track id');
	const refuse = (err: HttpError): never => {
		res.setHeader('Connection', 'close');
		throw err;
	};
	const track_id = await resolve_redirect(db, requested.data);
	const [track] = await db.select({ id: tracks_table.id }).from(tracks_table).where(eq(tracks_table.id, track_id));
	if (!track) refuse(new HttpError(404, 'track not found'));

	const header_token = typeof req.headers['x-action-token'] === 'string' ? req.headers['x-action-token'] : undefined;
	try {
		if (header_token !== undefined) await check_action_token(user, header_token, 'UPLOAD_MEDIA', token_target(header_token, requested.data, track_id), started);
		else if (!(await user_can_access_tracks(db, user.id, [track_id]))) throw new HttpError(403, 'track is not in your library', { code: 'NOT_IN_LIBRARY' });
	} catch (err) {
		if (err instanceof HttpError) refuse(err);
		throw err;
	}
	const current = await existing_media(track_id);
	if (current) refuse(new HttpError(409, 'track already has media', { code: 'TRACK_HAS_MEDIA', media: current }));

	const incoming_dir = path.join(config.MEDIA_DIR, '.incoming');
	let upload;
	try {
		upload = await receive_upload(req, incoming_dir, config.MEDIA_MAX_BYTES);
	} catch (err) {
		res.setHeader('Connection', 'close');
		throw err;
	}
	let encoded: string | undefined;
	try {
		const fields = parse_body(upload_fields_schema, upload.fields);
		// Older clients send the token as a form field after the file; it's checked when stored.
		const token = header_token ?? fields.token ?? null;
		// A retry of an upload that already went through (same bytes) answers at once, without encoding or a token.
		const duplicate = await find_duplicate(track_id, upload.sha256);
		if (duplicate) {
			res.status(200).json({ media: duplicate, duplicate: true });
			return;
		}
		encoded = await transcode_to_m4a(upload.temp_path, incoming_dir);
		// Dedupe stays keyed on the uploaded bytes: the encoder output isn't byte-stable across ffmpeg versions.
		const result = await store_upload({
			user,
			requested_id: requested.data,
			track_id,
			upload: { ...upload, temp_path: encoded, kind: M4A_KIND },
			quality: fields.quality ?? null,
			token,
			started
		});
		if (!result.duplicate) {
			log.info('media stored', { track_id, resource_id: result.media.resource_id, uploaded_bytes: upload.size, source: upload.kind.ext, user_id: user.id });
		}
		res.status(result.duplicate ? 200 : 201).json(result);
	} finally {
		// The encoded file is gone already if it was moved into place.
		await rm(upload.temp_path, { force: true });
		if (encoded !== undefined) await rm(encoded, { force: true });
	}
});

const requests_query_schema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.uuid().optional()
});

async function upload_actions(user: AuthUser, track_ids: readonly string[]): Promise<ActionType[]> {
	return issue_actions(user, track_ids.map(track_id => ({ type: 'UPLOAD_MEDIA' as const, track_id })));
}

/**
 * Pending UPLOAD_MEDIA actions for this user, at most `limit`, most wanted first: backpacked, imported, only on
 * SoundCloud, lyrics not word synced, then every other downloaded track without media.
 */
export async function pending_upload_actions(user: AuthUser, limit: number): Promise<ActionType[]> {
	if (limit <= 0) return [];
	const ids: string[] = [];
	for (const next of [backpacked_upload_track_ids, imported_upload_track_ids, soundcloud_upload_track_ids, lyrics_upload_track_ids, pending_upload_track_ids]) {
		if (ids.length >= limit) break;
		for (const id of await next(db, user, limit)) if (!ids.includes(id)) ids.push(id);
	}
	return upload_actions(user, ids.slice(0, limit));
}

// Must be registered before `/media/:resource_id`.
media_router.get('/media/requests', async (req, res) => {
	const user = require_user(req);
	const query = requests_query_schema.safeParse(req.query);
	if (!query.success) throw new HttpError(400, 'invalid query', { issues: query.error.issues });
	const { limit, cursor } = query.data;
	const track_ids = await pending_upload_track_ids(db, user, limit, cursor);
	res.json({
		actions: await upload_actions(user, track_ids),
		next_cursor: track_ids.length === limit ? track_ids[track_ids.length - 1] : null
	});
});

/**
 * Streams a media file. Resource ids are random and never reused, so the id itself is the capability: no session is
 * needed, and native players can stream (and seek, long after any access token would have expired) with no headers.
 * Ids that aren't resource ids fall through to the authenticated routes (`/media/requests`).
 */
public_media_router.get('/media/:resource_id', async (req, res, next) => {
	const resource_id = req.params.resource_id;
	const ext = resource_ext(resource_id);
	const file_path = resource_path(config.MEDIA_DIR, resource_id);
	if (ext === null || file_path === null) {
		// The authenticated GET /media/requests
		if (resource_id === 'requests') {
			next();
			return;
		}
		throw new HttpError(400, 'invalid resource id');
	}

	let size: number;
	try {
		size = (await stat(file_path)).size;
	} catch {
		// Moved to the media bucket by scripts/backup-media.sh: the bucket serves it publicly.
		const remote = remote_media_url(resource_id);
		if (remote) {
			res.redirect(302, remote);
			return;
		}
		throw new HttpError(404, 'media not found');
	}

	// Stored media never changes, so the resource id is a strong validator.
	const etag = `"${resource_id}"`;
	res.setHeader('ETag', etag);
	res.setHeader('Content-Type', MIME_BY_EXT[ext]);
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

	if (config.MEDIA_ACCEL_PREFIX) {
		// nginx serves the file itself (ranges, If-Range against this ETag, sendfile); Node is done.
		res.setHeader('X-Accel-Redirect', `${config.MEDIA_ACCEL_PREFIX}${resource_id}`);
		res.end();
		return;
	}

	const if_range = req.headers['if-range'];
	const range = if_range === undefined || if_range === etag ? parse_range(req.headers.range, size) : { type: 'full' as const };
	res.setHeader('Accept-Ranges', 'bytes');

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

async function find_duplicate(track_id: string, sha256: string) {
	const [row] = await db.select().from(media_table).where(and(eq(media_table.track_id, track_id), eq(media_table.content_hash, sha256)));
	return row;
}
