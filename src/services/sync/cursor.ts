/**
 * Pull cursors. Opaque to clients: base64url JSON holding database times as Postgres text
 * (microsecond precision, compared as `timestamptz` server side) plus the paging position.
 */
import { z } from 'zod';

export interface Cursor {
	v: 1;
	/** Lower bound (exclusive): rows changed after this were not yet sent. Null on a full pull. */
	since: string | null;
	/** Upper bound (inclusive) of the sweep in progress: the snapshot watermark taken on its first page. */
	upper?: string;
	/** Paging position inside the sweep: phase index and the last key sent in that phase. */
	phase?: number;
	key?: string | null;
}

const PG_TIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/u;
const pg_time = z.string().max(40).regex(PG_TIME_RE);

const cursor_schema = z.object({
	v: z.literal(1),
	since: pg_time.nullable(),
	upper: pg_time.optional(),
	phase: z.number().int().min(0).max(1_000).optional(),
	key: z.string().max(512).nullish()
}).refine(c => (c.phase == null) === (c.upper == null), 'phase and upper go together');

export function encode_cursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Null if the string isn't a cursor this server issued (wrong shape, tampered, other version). */
export function decode_cursor(value: string): Cursor | null {
	if (value.length > 2048) return null;
	try {
		const parsed = cursor_schema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** True while a sweep is between pages (`upper` fixed on its first page). */
export const in_progress = (c: Cursor): c is Cursor & { upper: string; phase: number } => c.upper != null && c.phase != null;

/** The cursor after a page: the next position of this sweep, or, when it's done, a fresh cursor starting at its watermark. */
export function next_cursor(since: string | null, upper: string, position: { phase: number; key: string | null } | null): Cursor {
	return position ? { v: 1, since, upper, phase: position.phase, key: position.key } : { v: 1, since: upper };
}
