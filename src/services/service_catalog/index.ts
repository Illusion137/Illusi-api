import { Router } from 'express';
import { z } from 'zod';
import { HttpError, json_body, parse_body, require_user } from '../../core/http';
import { rate_limit_user } from '../../core/rate_limit';
import { logger } from '../../core/log';
import { validate_items } from './normalize';
import { write_items } from './store';

export { validate_items } from './normalize';
export type { CatalogItem } from './normalize';

const log = logger('service_catalog');

export const CATALOG_INGEST_MAX_BODY = '4mb';
export const CATALOG_INGEST_MAX_ITEMS = 500;
export const CATALOG_INGEST_RATE_LIMIT = { limit: 60, window_ms: 60_000 };

const body_schema = z.object({ items: z.array(z.unknown()).max(CATALOG_INGEST_MAX_ITEMS) });

/** Mounted after `require_auth`: `POST /ingest/service`. */
export const service_catalog_router = Router();

/**
 * Stores tracks, albums and artists exactly as a streaming service (anything but YouTube / YouTube Music) described
 * them. Global entities come from `/contribute`; this keeps the service's own view of them beside it.
 */
service_catalog_router.post(
	'/ingest/service',
	rate_limit_user('service_ingest', CATALOG_INGEST_RATE_LIMIT.limit, CATALOG_INGEST_RATE_LIMIT.window_ms),
	json_body(CATALOG_INGEST_MAX_BODY),
	async (req, res) => {
		require_user(req);
		const body = parse_body(body_schema, req.body);
		if (body.items.length > CATALOG_INGEST_MAX_ITEMS) throw new HttpError(413, 'too many items', { max_items: CATALOG_INGEST_MAX_ITEMS });
		const { valid, rejected } = validate_items(body.items);
		if (valid.length > 0) await write_items(valid).catch((error: unknown) => { log.error('service ingest failed', error); throw error; });
		res.status(200).json({ accepted: valid.length, rejected });
	}
);
