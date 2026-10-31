import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { config } from '../../config';
import { db } from '../../db';
import { read_versions_table, user_read_versions_table } from '../../db/schema';

/** How long a client may reuse a catalog response without asking again. */
const MAX_AGE_S = 60;

export interface ValidatorParts {
	/** The view carries the caller's library overlay. */
	user_id?: string;
	/** The response is ordered by play totals. */
	plays?: boolean;
}

/** Hex fingerprint of everything a response depends on; pure so it can be tested. */
export function validator_tag(url: string, versions: { catalog: number; plays: number | null; user: number | null }, user_id: string | null): string {
	const key = [config.APP_VERSION, url, versions.catalog, versions.plays ?? '-', user_id ?? '-', versions.user ?? '-'].join('|');
	return `W/"${createHash('sha1').update(key).digest('base64url').slice(0, 22)}"`;
}

/**
 * Weak comparison against an If-None-Match header. `req.fresh` isn't used: it treats a request's
 * `Cache-Control: no-cache` as "never fresh", but that directive is for caches, and fetch implementations add it to
 * every conditional request; the origin may still answer 304.
 */
export function matches_if_none_match(header: string | undefined, tag: string): boolean {
	if (!header) return false;
	const opaque = (t: string) => t.trim().replace(/^W\//u, '');
	const wanted = opaque(tag);
	return header.split(',').some(t => t.trim() === '*' || opaque(t) === wanted);
}

/**
 * Sets the ETag and Cache-Control of a catalog read from the database's change counters, read *before* the
 * response is built (so a write committing meanwhile can only cost a later 304, never cache stale data). Returns
 * true after answering 304 when the client's copy is current; the handler then stops.
 */
export async function answer_not_modified(req: Request, res: Response, parts: ValidatorParts = {}): Promise<boolean> {
	const [row] = await db.select({
		catalog: sql<number>`coalesce((select ${read_versions_table.version} from ${read_versions_table} where ${read_versions_table.key} = 'catalog'), 0)`.mapWith(Number),
		plays: parts.plays
			? sql<number>`coalesce((select ${read_versions_table.version} from ${read_versions_table} where ${read_versions_table.key} = 'plays'), 0)`.mapWith(Number)
			: sql<null>`null`,
		user: parts.user_id
			? sql<number>`coalesce((select ${user_read_versions_table.version} from ${user_read_versions_table} where ${user_read_versions_table.user_id} = ${parts.user_id}), 0)`.mapWith(Number)
			: sql<null>`null`
	}).from(sql`(select 1) one`);
	const tag = validator_tag(req.originalUrl, { catalog: row.catalog, plays: row.plays, user: row.user }, parts.user_id ?? null);
	res.setHeader('ETag', tag);
	res.setHeader('Cache-Control', `private, max-age=${MAX_AGE_S}`);
	if (matches_if_none_match(req.headers['if-none-match'], tag)) {
		res.status(304).end();
		return true;
	}
	return false;
}
