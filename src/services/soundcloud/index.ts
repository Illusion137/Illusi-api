import { Router } from 'express';
import { z } from 'zod';
import { HttpError, json_body, parse_body, require_user } from '../../core/http';
import { rate_limit_user } from '../../core/rate_limit';
import { enqueue_batch } from './ingest';
import { flatten_items, unwrap_items } from './normalize';

export { is_transcoding_stale, write_batch } from './ingest';
export { flatten_items, unwrap_items } from './normalize';
export type { Batch } from './normalize';

/** Request limits. Items are counted after unwrapping `collection` arrays and wrappers. */
export const SC_INGEST_MAX_BODY = '4mb';
export const SC_INGEST_MAX_ITEMS = 500;
export const SC_INGEST_RATE_LIMIT = { limit: 60, window_ms: 60_000 };

const body_schema = z.object({ items: z.array(z.unknown()).max(SC_INGEST_MAX_ITEMS) });

/** Mounted after `require_auth`: `POST /ingest/soundcloud`. */
export const soundcloud_router = Router();

soundcloud_router.post(
	'/ingest/soundcloud',
	rate_limit_user('soundcloud_ingest', SC_INGEST_RATE_LIMIT.limit, SC_INGEST_RATE_LIMIT.window_ms),
	json_body(SC_INGEST_MAX_BODY),
	(req, res) => {
		const user = require_user(req);
		const body = parse_body(body_schema, req.body);
		const items = unwrap_items(body.items);
		if (items.length > SC_INGEST_MAX_ITEMS) throw new HttpError(413, 'too many items', { max_items: SC_INGEST_MAX_ITEMS });
		const { batch, accepted, rejected } = flatten_items(items);
		if (accepted > 0) enqueue_batch(user.id, batch);
		res.status(202).json({ accepted, rejected });
	}
);
