import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => {
	const scope = { setTag: vi.fn(), setUser: vi.fn(), setExtra: vi.fn() };
	return {
		scope,
		logger: { error: vi.fn() },
		withScope: vi.fn((fn: (s: typeof scope) => void) => { fn(scope); }),
		captureException: vi.fn(),
		captureMessage: vi.fn()
	};
});
vi.mock('@sentry/node', () => sentry);

import { run_in_context } from './context';
import { access_log, FileSink, format_line, logger } from './log';

const dir = mkdtempSync(path.join(tmpdir(), 'illusi-log-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const err_spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
const out_spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

beforeEach(() => { vi.clearAllMocks(); });

describe('logger', () => {
	const log = logger('scope');

	it('info goes to stdout with scope and request id, not to Sentry', () => {
		run_in_context({ request_id: 'req-123456', user_id: () => 'u1' }, () => { log.info('hello', { a: 1 }); });
		expect(out_spy).toHaveBeenCalledWith(expect.stringMatching(/INFO \[scope\] \(req-123456\) hello$/u), { a: 1 });
		expect(sentry.withScope).not.toHaveBeenCalled();
	});

	it('omits data and request id when absent', () => {
		log.info('plain');
		expect(out_spy).toHaveBeenCalledWith(expect.stringMatching(/INFO \[scope\] plain$/u));
	});

	it('warn goes to stderr but not Sentry', () => {
		log.warn('careful');
		expect(err_spy).toHaveBeenCalled();
		expect(sentry.captureMessage).not.toHaveBeenCalled();
	});

	it('debug is silent unless DEBUG is set', () => {
		log.debug('hidden');
		expect(out_spy).not.toHaveBeenCalled();
		vi.stubEnv('DEBUG', '1');
		log.debug('shown');
		vi.unstubAllEnvs();
		expect(out_spy).toHaveBeenCalledOnce();
	});

	it('error with an Error reports an exception with request and user tags', () => {
		const error = new Error('boom');
		run_in_context({ request_id: 'req-123456', user_id: () => 'u1' }, () => { log.error('failed', error); });
		expect(sentry.captureException).toHaveBeenCalledWith(error);
		expect(sentry.scope.setTag).toHaveBeenCalledWith('request_id', 'req-123456');
		expect(sentry.scope.setUser).toHaveBeenCalledWith({ id: 'u1' });
		expect(sentry.scope.setExtra).toHaveBeenCalledWith('message', 'failed');
		expect(sentry.logger.error).toHaveBeenCalledWith('[scope] failed', expect.objectContaining({ error: 'boom', request_id: 'req-123456' }));
	});

	it('error with data or nothing reports a message', () => {
		log.error('with data', { k: 1 });
		expect(sentry.captureMessage).toHaveBeenCalledWith('[scope] with data', 'error');
		expect(sentry.scope.setExtra).toHaveBeenCalledWith('data', { k: 1 });
		log.error('bare');
		expect(sentry.captureMessage).toHaveBeenCalledWith('[scope] bare', 'error');
		expect(sentry.scope.setUser).not.toHaveBeenCalled();
	});
});

describe('format_line', () => {
	it('survives circular data and stringifies bigint', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(JSON.parse(format_line('info', 's', 'm', circular))).toHaveProperty('unserializable');
		expect(JSON.parse(format_line('info', 's', 'm', { n: 5n })).data).toEqual({ n: '5' });
	});

	it('keeps an error\'s code and cause', () => {
		const pg = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
		const data = JSON.parse(format_line('error', 's', 'm', new Error('Failed query: select 1', { cause: pg }))).data;
		expect(data).toMatchObject({ message: 'Failed query: select 1', cause: { message: 'canceling statement due to statement timeout', code: '57014' } });
		expect(data).not.toHaveProperty('code');
	});

	it('lets extra fields override', () => {
		expect(JSON.parse(format_line('access', 's', undefined, undefined, { status: 200 })).status).toBe(200);
	});
});

describe('FileSink', () => {
	it('is inert without a directory', () => {
		expect(() => new FileSink('', 'x', 7).write('line')).not.toThrow();
	});

	it('disables itself when the directory cannot be created', () => {
		const blocker = path.join(dir, 'blocker');
		writeFileSync(blocker, 'file');
		const sink = new FileSink(path.join(blocker, 'sub'), 'x', 7);
		sink.write('one');
		sink.write('two');
		expect(err_spy).toHaveBeenCalledTimes(1);
		expect(err_spy).toHaveBeenCalledWith(expect.stringContaining('log file disabled'));
	});

	it('disables itself when the log file cannot be opened', async () => {
		const blocked = path.join(dir, 'blocked');
		mkdirSync(path.join(blocked, `y-${new Date().toISOString().slice(0, 10)}.log`), { recursive: true });
		const sink = new FileSink(blocked, 'y', 7);
		sink.write('one');
		await vi.waitFor(() => { expect(err_spy).toHaveBeenCalledWith(expect.stringContaining('log file disabled')); });
		sink.write('two');
	});

	it('sanitizes the service name and floors retention at one day', () => {
		const sink = new FileSink(dir, '../evil name', 0) as unknown as { service: string; retention_days: number };
		expect(sink.service).toBe('___evil_name');
		expect(sink.retention_days).toBe(7);
		expect((new FileSink(dir, 'a', -3) as unknown as { retention_days: number }).retention_days).toBe(1);
	});
});

describe('access_log', () => {
	it('does not throw without a log dir', () => {
		expect(() => { access_log({ status: 200 }); }).not.toThrow();
	});
});
