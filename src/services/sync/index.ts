import { Router } from 'express';
import { HttpError, json_body, parse_body, require_user } from '../../core/http';
import { rate_limit_user } from '../../core/rate_limit';
import { decode_cursor } from './cursor';
import { pull } from './pull';
import { push } from './push';
import { pull_body_schema, push_body_schema } from './types';

export type { SyncPullResponse, SyncPushResponse, SyncRows } from './types';

/** Mounted after `require_auth`: `POST /sync/pull`, `POST /sync/push`. */
export const sync_router = Router();

sync_router.post('/sync/pull', rate_limit_user('sync_pull', 240, 60_000), json_body('16kb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(pull_body_schema, req.body ?? {});
	const cursor = body.cursor ? decode_cursor(body.cursor) : null;
	if (body.cursor && !cursor) throw new HttpError(400, 'invalid cursor');
	res.json(await pull(user, cursor));
});

sync_router.post('/sync/push', rate_limit_user('sync_push', 120, 60_000), json_body('16mb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(push_body_schema, req.body);
	if (body.base_cursor && !decode_cursor(body.base_cursor)) throw new HttpError(400, 'invalid base_cursor');
	res.json(await push(user, body));
});
