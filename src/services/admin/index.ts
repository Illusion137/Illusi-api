import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { PendingEvents } from '../../core/events';
import { HttpError, json_body, parse_body, require_user } from '../../core/http';
import { resolve_redirect } from '../../core/redirects';
import { admin_update_entity, parse_entity_patch, resolve_table } from './entities';
import { apply_body_schema, apply_review, dismiss_review, list_query_schema, list_review } from './review';

/** Mounted at `/admin` after `require_auth` and `require_admin`. */
export const admin_router = Router();
admin_router.use(json_body('256kb'));

const id_param = z.coerce.number().int().positive();

function review_id(raw: string): number {
	const r = id_param.safeParse(raw);
	if (!r.success) throw new HttpError(400, 'invalid review item id');
	return r.data;
}

admin_router.get('/review', async (req, res) => {
	const q = list_query_schema.safeParse(req.query);
	if (!q.success) throw new HttpError(400, 'invalid query', { issues: q.error.issues });
	res.json(await list_review(q.data));
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
