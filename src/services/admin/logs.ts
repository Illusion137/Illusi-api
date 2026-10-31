import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { config } from '../../config';
import { HttpError } from '../../core/http';

const FILE_RE = /^([a-z0-9_-]+)-(\d{4}-\d{2}-\d{2})\.log$/iu;
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export const logs_query_schema = z.object({
	service: z.string().regex(/^[a-z0-9_-]{1,64}$/iu),
	day: z.iso.date(),
	/** Lowest level shown. */
	level: z.enum(LEVELS).default('debug'),
	access: z.stringbool().default(true),
	scope: z.string().max(64).optional(),
	request_id: z.string().max(128).optional(),
	user_id: z.string().max(64).optional(),
	/** Case-insensitive substring of the raw line. */
	q: z.string().max(256).optional(),
	/** Line numbers (1-based, exclusive): `before` pages back to older lines, `after` polls for newer ones. */
	before: z.coerce.number().int().min(1).optional(),
	after: z.coerce.number().int().min(0).optional(),
	limit: z.coerce.number().int().min(1).max(1000).default(200)
});
export type LogsQuery = z.infer<typeof logs_query_schema>;

export interface LogLine { line: number; entry: Record<string, unknown> }

function log_dir(): string {
	if (!config.LOG_DIR) throw new HttpError(404, 'file logging is disabled (LOG_DIR is empty)');
	return config.LOG_DIR;
}

export async function list_log_files(dir = log_dir()) {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
	const files = [];
	for (const name of names) {
		const match = FILE_RE.exec(name);
		if (!match) continue;
		const { size, mtime } = await stat(path.join(dir, name));
		files.push({ service: match[1], day: match[2], size, modified_at: mtime });
	}
	return files.sort((a, b) => b.day.localeCompare(a.day) || a.service.localeCompare(b.service));
}

export function matches(entry: Record<string, unknown>, raw: string, q: LogsQuery): boolean {
	const is_access = entry.scope === 'access';
	if (is_access && !q.access) return false;
	const level = LEVELS.indexOf(entry.level as typeof LEVELS[number]);
	if (level !== -1 && level < LEVELS.indexOf(q.level)) return false;
	if (q.scope && entry.scope !== q.scope) return false;
	if (q.request_id && entry.request_id !== q.request_id) return false;
	if (q.user_id && entry.user_id !== q.user_id) return false;
	if (q.q && !raw.toLowerCase().includes(q.q.toLowerCase())) return false;
	return true;
}

/**
 * Matching lines of one day's file, newest first. Without `after`, at most `limit` lines older than `before`;
 * with `after`, the newest `limit` lines past it. The whole file is scanned: daily files stay small enough.
 */
export async function read_logs(q: LogsQuery, dir = log_dir()) {
	const file = path.join(dir, `${q.service}-${q.day}.log`);
	const found: LogLine[] = [];
	let line = 0;
	let older = false;
	try {
		const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
		for await (const raw of lines) {
			line++;
			if (q.before !== undefined && line >= q.before) break;
			if (q.after !== undefined && line <= q.after) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				entry = { level: 'info', msg: raw, unparsed: true };
			}
			if (!matches(entry, raw, q)) continue;
			found.push({ line, entry });
			if (found.length > q.limit) {
				found.shift();
				older = true;
			}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'no log file for that service and day');
		throw err;
	}
	return { lines: found.reverse(), has_more: older, last_line: q.before === undefined ? line : null };
}
