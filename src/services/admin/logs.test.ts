import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../core/http';
import { list_log_files, logs_query_schema, read_logs } from './logs';

const dir = mkdtempSync(path.join(tmpdir(), 'illusi-admin-logs-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const line = (entry: Record<string, unknown>) => JSON.stringify({ time: '2026-10-30T12:00:00.000Z', host: 'h', ...entry });
writeFileSync(path.join(dir, 'api-2026-10-30.log'), [
	line({ level: 'info', scope: 'server', msg: 'listening' }),
	line({ level: 'info', scope: 'access', method: 'GET', path: '/api/v1/me', status: 200, request_id: 'req-1', user_id: 'u1' }),
	line({ level: 'warn', scope: 'db', msg: 'slow query', request_id: 'req-1' }),
	'not json at all',
	line({ level: 'error', scope: 'http', msg: 'Boom happened', request_id: 'req-2', user_id: 'u2' }),
	line({ level: 'debug', scope: 'db', msg: 'detail' })
].join('\n') + '\n');
writeFileSync(path.join(dir, 'worker-2026-10-29.log'), `${line({ level: 'info', scope: 'reconcile', msg: 'done' })}\n`);
writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

const query = (q: Record<string, string>) => logs_query_schema.parse({ service: 'api', day: '2026-10-30', ...q });
const lines = async (q: Record<string, string>) => (await read_logs(query(q), dir)).lines.map(l => l.line);

describe('list_log_files', () => {
	it('lists daily files newest first and skips anything else', async () => {
		const files = await list_log_files(dir);
		expect(files.map(f => `${f.service}/${f.day}`)).toEqual(['api/2026-10-30', 'worker/2026-10-29']);
		expect(files[0].size).toBeGreaterThan(0);
	});

	it('is empty for a missing directory', async () => {
		expect(await list_log_files(path.join(dir, 'missing'))).toEqual([]);
	});
});

describe('read_logs', () => {
	it('returns every line newest first, keeping unparseable ones', async () => {
		const res = await read_logs(query({}), dir);
		expect(res.lines.map(l => l.line)).toEqual([6, 5, 4, 3, 2, 1]);
		expect(res.lines[2].entry).toMatchObject({ msg: 'not json at all', unparsed: true });
		expect(res).toMatchObject({ has_more: false, last_line: 6 });
	});

	it('filters by minimum level, access lines, scope, request, user and text', async () => {
		expect(await lines({ level: 'warn' })).toEqual([5, 3]);
		expect(await lines({ access: 'false' })).toEqual([6, 5, 4, 3, 1]);
		expect(await lines({ scope: 'db' })).toEqual([6, 3]);
		expect(await lines({ request_id: 'req-1' })).toEqual([3, 2]);
		expect(await lines({ user_id: 'u2' })).toEqual([5]);
		expect(await lines({ q: 'boom' })).toEqual([5]);
	});

	it('pages back with before and polls forward with after', async () => {
		const first = await read_logs(query({ limit: '2' }), dir);
		expect(first.lines.map(l => l.line)).toEqual([6, 5]);
		expect(first.has_more).toBe(true);
		const older = await read_logs(query({ limit: '2', before: '5' }), dir);
		expect(older.lines.map(l => l.line)).toEqual([4, 3]);
		expect(older.last_line).toBeNull();
		expect(await lines({ after: '4' })).toEqual([6, 5]);
		expect(await lines({ after: '6' })).toEqual([]);
	});

	it('404s for a day without a file', async () => {
		await expect(read_logs(query({ day: '2026-01-01' }), dir)).rejects.toSatisfy(e => e instanceof HttpError && e.status === 404);
	});

	it('only accepts plain service names', () => {
		expect(logs_query_schema.safeParse({ service: '../etc/passwd', day: '2026-10-30' }).success).toBe(false);
		expect(logs_query_schema.safeParse({ service: 'api', day: '2026-10-30/../../x' }).success).toBe(false);
	});
});
