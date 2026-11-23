import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import argon2 from 'argon2';
import { and, desc, eq, ne } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { export_jobs_table, users_table } from '../../db/schema';
import { forget_user } from '../../core/auth/middleware';
import { require_disk_space } from '../../core/disk';
import { PendingEvents } from '../../core/events';
import { HttpError, json_body, parse_body, require_user, uuid_schema } from '../../core/http';
import { logger } from '../../core/log';
import { RateLimiter, rate_limit_user } from '../../core/rate_limit';
import { receive_image, send_image_file } from '../playlists';
import { AVATAR_SUBDIR, avatar_exists, avatar_path, set_avatar, store_avatar_file } from './avatar';
import { delete_account } from './delete';
import { EXPORTS_SUBDIR, export_path, job_view } from './export';
import type { ExportJob } from './export';

const log = logger('account');

/**
 * Mounted after `require_auth`: data exports (`/me/export...`), settings (`PATCH /me/settings`), the user's avatar (`PUT|DELETE /me/avatar`,
 * `GET /avatars/:avatar_id`) and account deletion (`DELETE /me`).
 */
export const account_router = Router();

const export_limit = rate_limit_user('export', 30, 60_000);

async function own_job(user_id: string, raw_id: unknown): Promise<ExportJob> {
	const id = uuid_schema.safeParse(raw_id);
	if (!id.success) throw new HttpError(400, 'invalid export id');
	const [job] = await db.select().from(export_jobs_table).where(and(eq(export_jobs_table.id, id.data), eq(export_jobs_table.user_id, user_id)));
	if (!job) throw new HttpError(404, 'export not found');
	return job;
}

/**
 * Starts an export of everything personal. One export may be pending or running per user, and a new one can be
 * requested once EXPORT_COOLDOWN_HOURS have passed since the last one that didn't fail.
 */
account_router.post('/me/export', export_limit, async (req, res) => {
	const user = require_user(req);
	const events = new PendingEvents();
	const job = await db.transaction(async (tx) => {
		// Serializes concurrent requests from one user.
		const [locked] = await tx.select({ id: users_table.id }).from(users_table).where(eq(users_table.id, user.id)).for('update');
		if (!locked) throw new HttpError(404, 'user not found');
		const [last] = await tx.select().from(export_jobs_table)
			.where(and(eq(export_jobs_table.user_id, user.id), ne(export_jobs_table.status, 'FAILED')))
			.orderBy(desc(export_jobs_table.created_at)).limit(1);
		if (last && (last.status === 'PENDING' || last.status === 'RUNNING')) {
			throw new HttpError(409, 'an export is already in progress', { export: job_view(last) });
		}
		const cooldown_ms = config.EXPORT_COOLDOWN_HOURS * 3_600_000;
		if (last && Date.now() - last.created_at.getTime() < cooldown_ms) {
			const retry_after_s = Math.ceil((last.created_at.getTime() + cooldown_ms - Date.now()) / 1000);
			res.setHeader('Retry-After', String(retry_after_s));
			throw new HttpError(429, 'an export was requested recently', { export: job_view(last), retry_after_s });
		}
		const [created] = await tx.insert(export_jobs_table).values({ user_id: user.id }).returning();
		events.push('export_requested', { id: created.id });
		return created;
	});
	events.flush();
	res.status(202).json(job_view(job));
});

/** The user's recent exports, newest first. */
account_router.get('/me/exports', export_limit, async (req, res) => {
	const user = require_user(req);
	const jobs = await db.select().from(export_jobs_table).where(eq(export_jobs_table.user_id, user.id))
		.orderBy(desc(export_jobs_table.created_at)).limit(20);
	res.json({ items: jobs.map(job_view) });
});

account_router.get('/me/export/:id', export_limit, async (req, res) => {
	const user = require_user(req);
	res.setHeader('Cache-Control', 'no-store');
	res.json(job_view(await own_job(user.id, req.params.id)));
});

account_router.get('/me/export/:id/file', export_limit, async (req, res) => {
	const user = require_user(req);
	const job = await own_job(user.id, req.params.id);
	if (job.status === 'EXPIRED' || (job.status === 'READY' && job.expires_at && job.expires_at.getTime() <= Date.now())) {
		throw new HttpError(410, 'export expired; request a new one');
	}
	if (job.status !== 'READY' || !job.file_name) throw new HttpError(409, 'export is not ready', { export: job_view(job) });
	const file = export_path(job.file_name);
	if (file === null) throw new HttpError(500, 'invalid export file name');

	const day = (job.finished_at ?? job.created_at).toISOString().slice(0, 10);
	res.setHeader('Content-Type', 'application/gzip');
	res.setHeader('Content-Disposition', `attachment; filename="illusi-export-${day}.json.gz"`);
	res.setHeader('Cache-Control', 'private, no-store');
	if (config.MEDIA_ACCEL_PREFIX) {
		res.setHeader('X-Accel-Redirect', `${config.MEDIA_ACCEL_PREFIX}${EXPORTS_SUBDIR}/${job.file_name}`);
		res.end();
		return;
	}
	let size: number;
	try {
		size = (await stat(file)).size;
	} catch {
		log.error('export file missing', { job_id: job.id });
		throw new HttpError(410, 'export expired; request a new one');
	}
	res.setHeader('Content-Length', String(size));
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	try {
		await pipeline(createReadStream(file), res);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warn('export stream failed', { job_id: job.id, err });
	}
});

// Account deletion asks for the password again even with a valid session, rate limited like login.
const delete_user_limiter = new RateLimiter(5, 15 * 60_000);
const delete_ip_limiter = new RateLimiter(30, 15 * 60_000);
const delete_schema = z.object({ password: z.string().min(1).max(1024) });

account_router.delete('/me', json_body('4kb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(delete_schema, req.body);
	if (!(await delete_user_limiter.hit(`user:${user.id}`)) || !(await delete_ip_limiter.hit(`ip:${req.ip}`))) throw new HttpError(429, 'too many attempts');
	const [row] = await db.select({ password_hash: users_table.password_hash }).from(users_table).where(eq(users_table.id, user.id));
	if (!row) throw new HttpError(404, 'user not found');
	if (!(await argon2.verify(row.password_hash, body.password))) throw new HttpError(403, 'invalid password', { code: 'WRONG_PASSWORD' });
	await delete_account(user.id);
	forget_user(user.id);
	res.status(204).end();
});

const settings_schema = z.object({ public_imports: z.boolean() }).partial().strict();

/** Account settings the user changes; returns them all */
account_router.patch('/me/settings', json_body('4kb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(settings_schema, req.body);
	const [row] = Object.keys(body).length === 0
		? await db.select({ public_imports: users_table.public_imports }).from(users_table).where(eq(users_table.id, user.id))
		: await db.update(users_table).set({ ...body, modified_at: new Date() }).where(eq(users_table.id, user.id)).returning({ public_imports: users_table.public_imports });
	if (!row) throw new HttpError(404, 'user not found');
	res.json(row);
});

const avatar_limit = rate_limit_user('avatar', 10, 60_000);

/** Multipart with a `file` part (jpeg, png or webp), re-encoded as a webp of at most AVATAR_MAX_PX a side. */
account_router.put('/me/avatar', avatar_limit, require_disk_space, async (req, res) => {
	const user = require_user(req);
	let upload;
	try {
		upload = await receive_image(req, path.join(config.MEDIA_DIR, '.incoming'), config.ARTWORK_MAX_BYTES);
	} catch (err) {
		// The body may not have been read; don't let the client keep sending it.
		res.setHeader('Connection', 'close');
		throw err;
	}
	try {
		const avatar_id = await store_avatar_file(upload.temp_path);
		const result = await set_avatar(user.id, avatar_id);
		log.info('avatar set', { user_id: user.id, avatar_id, source: upload.kind });
		res.json(result);
	} finally {
		await rm(upload.temp_path, { force: true });
	}
});

account_router.delete('/me/avatar', avatar_limit, async (req, res) => {
	res.json(await set_avatar(require_user(req).id, null));
});

/** Visible where the user is (row-level security): to themselves, and to anyone who can see one of their playlists. */
account_router.get('/avatars/:avatar_id', async (req, res) => {
	const avatar_id = req.params.avatar_id;
	const file = avatar_path(avatar_id);
	if (file === null) throw new HttpError(400, 'invalid avatar id');
	if (!(await avatar_exists(avatar_id))) throw new HttpError(404, 'avatar not found');
	await send_image_file(req, res, { id: avatar_id, file, subdir: AVATAR_SUBDIR, type: 'image/webp' });
});
