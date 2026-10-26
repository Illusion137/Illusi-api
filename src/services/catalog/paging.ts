import type { Request } from 'express';
import { z } from 'zod';
import { HttpError } from '../../core/http';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Page<T> { items: T[]; next_cursor: string | null }

/** `?limit&cursor`. The cursor is an opaque offset. */
export const page_query_shape = {
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
	cursor: z.string().max(256).optional()
};

/** `true` / `false` / `1` / `0` query flags. */
export const bool_query = z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1');

export function parse_query<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
	const result = schema.safeParse(req.query);
	if (!result.success) throw new HttpError(400, 'invalid query', { issues: result.error.issues });
	return result.data;
}

export function encode_cursor(offset: number): string {
	return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

/** Offset encoded in `cursor`, 0 without one. Throws 400 for a cursor this server didn't issue. */
export function decode_cursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	try {
		const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o?: unknown };
		if (typeof o === 'number' && Number.isSafeInteger(o) && o >= 0) return o;
	} catch { /* falls through */ }
	throw new HttpError(400, 'invalid cursor');
}

/**
 * One page from rows fetched with `limit + 1` starting at `offset`: the extra row only signals that
 * there is a next page.
 */
export function page_from<T>(rows: readonly T[], offset: number, limit: number): Page<T> {
	return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? encode_cursor(offset + limit) : null };
}

/** One page of an already complete, ordered list. */
export function slice_page<T>(all: readonly T[], offset: number, limit: number): Page<T> {
	return { items: all.slice(offset, offset + limit), next_cursor: offset + limit < all.length ? encode_cursor(offset + limit) : null };
}
