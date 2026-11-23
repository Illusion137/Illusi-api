import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { PendingEvents } from '../../core/events';
import { HttpError, json_body, parse_body, require_user } from '../../core/http';
import { resolve_redirect } from '../../core/redirects';
import { audit_query_schema, backpack_overview, backpack_query_schema, list_audit, remove_media, search_tracks, track_detail, tracks_query_schema } from './catalog';
import { credits_body_schema, entity_search_schema, search_albums, search_artists, update_track_credits } from './credits';
import { admin_update_entity, parse_entity_patch, resolve_table } from './entities';
import { list_log_files, logs_query_schema, read_logs } from './logs';
import { apply_body_schema, apply_review, dismiss_review, list_query_schema, list_review } from './review';
import { system_status } from './status';
import { delete_row, get_row, insert_row, list_rows, list_tables, preview_delete, preview_row, row_insert_schema, row_patch_schema, rows_query_schema, update_row } from './tables';
import { admin_delete_user, list_users, revoke_user_sessions, update_user, user_patch_schema, users_query_schema } from './users';

/**
 * The dashboard's static files, public like any login page: every call it makes goes through `/api/v1/admin`.
 * Scripts only from this origin, nothing can frame it, and responses are revalidated so a deploy shows up at once.
 */
export function admin_ui() {
	const ui = Router();
	ui.use((_req, res, next) => {
		res.set({
			'Content-Security-Policy': 'default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\'; img-src \'self\' data:; form-action \'self\'; base-uri \'none\'; frame-ancestors \'none\'',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
			'Cache-Control': 'no-cache'
		});
		next();
	});
	ui.use(express.static(path.join(__dirname, 'ui'), { index: 'index.html', cacheControl: false }));
	return ui;
}

/** Mounted at `/admin` after `require_auth` and `require_admin`. */
export const admin_router = Router();
admin_router.use(json_body('256kb'));

const id_param = z.coerce.number().int().positive();

function review_id(raw: string): number {
	const r = id_param.safeParse(raw);
	if (!r.success) throw new HttpError(400, 'invalid review item id');
	return r.data;
}

function parse_query<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
	const q = schema.safeParse(query);
	if (!q.success) throw new HttpError(400, 'invalid query', { issues: q.error.issues });
	return q.data;
}

function user_id(raw: string): string {
	if (!z.uuid().safeParse(raw).success) throw new HttpError(400, 'invalid user id');
	return raw;
}

admin_router.get('/status', async (_req, res) => {
	res.set('Cache-Control', 'no-store').json(await system_status());
});

admin_router.get('/logs/files', async (_req, res) => {
	res.json({ files: await list_log_files() });
});

admin_router.get('/logs', async (req, res) => {
	res.set('Cache-Control', 'no-store').json(await read_logs(parse_query(logs_query_schema, req.query)));
});

admin_router.get('/review', async (req, res) => {
	res.json(await list_review(parse_query(list_query_schema, req.query)));
});

admin_router.post('/review/:id/apply', async (req, res) => {
	const admin = require_user(req);
	const body = parse_body(apply_body_schema, req.body ?? {});
	res.json(await apply_review(review_id(req.params.id), body, admin.id));
});

admin_router.post('/review/:id/dismiss', async (req, res) => {
	const admin = require_user(req);
	res.json(await dismiss_review(review_id(req.params.id), admin.id));
});

admin_router.patch('/entities/:table/:id', async (req, res) => {
	const admin = require_user(req);
	const table = resolve_table(req.params.table);
	if (!table) throw new HttpError(404, 'unknown or non-editable table');
	if (!z.uuid().safeParse(req.params.id).success) throw new HttpError(400, 'invalid id');
	const values = parse_entity_patch(table, req.body);
	const events = new PendingEvents();
	const result = await db.transaction(async (tx) => {
		const entity_id = await resolve_redirect(tx, req.params.id);
		const change = await admin_update_entity(tx, table, entity_id, values, { admin_id: admin.id, events });
		return { table, id: entity_id, redirected_from: entity_id === req.params.id ? null : req.params.id, ...change };
	});
	events.flush();
	res.json(result);
});

admin_router.get('/users', async (req, res) => {
	res.json(await list_users(parse_query(users_query_schema, req.query)));
});

admin_router.patch('/users/:id', async (req, res) => {
	const admin = require_user(req);
	res.json(await update_user(user_id(req.params.id), parse_body(user_patch_schema, req.body), admin.id));
});

admin_router.post('/users/:id/revoke_sessions', async (req, res) => {
	const admin = require_user(req);
	await revoke_user_sessions(user_id(req.params.id), admin.id);
	res.status(204).end();
});

admin_router.delete('/users/:id', async (req, res) => {
	const admin = require_user(req);
	await admin_delete_user(user_id(req.params.id), admin.id);
	res.status(204).end();
});

admin_router.get('/tracks', async (req, res) => {
	res.json(await search_tracks(parse_query(tracks_query_schema, req.query)));
});

admin_router.get('/tracks/:id', async (req, res) => {
	res.json(await track_detail(req.params.id));
});

admin_router.put('/tracks/:id/credits', async (req, res) => {
	const admin = require_user(req);
	res.json(await update_track_credits(req.params.id, parse_body(credits_body_schema, req.body), admin.id));
});

admin_router.get('/search/artists', async (req, res) => {
	res.json(await search_artists(parse_query(entity_search_schema, req.query)));
});

admin_router.get('/search/albums', async (req, res) => {
	res.json(await search_albums(parse_query(entity_search_schema, req.query)));
});

admin_router.delete('/media/:id', async (req, res) => {
	const admin = require_user(req);
	const id = id_param.safeParse(req.params.id);
	if (!id.success) throw new HttpError(400, 'invalid media id');
	res.json(await remove_media(id.data, admin.id));
});

admin_router.get('/backpack', async (req, res) => {
	res.json(await backpack_overview(parse_query(backpack_query_schema, req.query)));
});

admin_router.get('/tables', async (_req, res) => {
	res.json(await list_tables());
});

admin_router.get('/tables/:table/rows', async (req, res) => {
	res.set('Cache-Control', 'no-store').json(await list_rows(req.params.table, parse_query(rows_query_schema, req.query)));
});

// POST: a composite key doesn't fit a path, and a query string would put key values in access logs.
admin_router.post('/tables/:table/row', async (req, res) => {
	res.set('Cache-Control', 'no-store').json(await get_row(req.params.table, (req.body as { key?: unknown } | undefined)?.key));
});

admin_router.post('/tables/:table/preview', async (req, res) => {
	res.set('Cache-Control', 'no-store').json(await preview_row(req.params.table, (req.body as { key?: unknown } | undefined)?.key));
});

admin_router.patch('/tables/:table/rows', async (req, res) => {
	const admin = require_user(req);
	res.json(await update_row(req.params.table, parse_body(row_patch_schema, req.body), admin.id));
});

admin_router.post('/tables/:table/rows', async (req, res) => {
	const admin = require_user(req);
	res.status(201).json(await insert_row(req.params.table, parse_body(row_insert_schema, req.body), admin.id));
});

admin_router.post('/tables/:table/delete_preview', async (req, res) => {
	res.set('Cache-Control', 'no-store').json(await preview_delete(req.params.table, (req.body as { key?: unknown } | undefined)?.key));
});

admin_router.delete('/tables/:table/rows', async (req, res) => {
	const admin = require_user(req);
	await delete_row(req.params.table, (req.body as { key?: unknown } | undefined)?.key, admin.id);
	res.status(204).end();
});

admin_router.get('/audit', async (req, res) => {
	res.json(await list_audit(parse_query(audit_query_schema, req.query)));
});
