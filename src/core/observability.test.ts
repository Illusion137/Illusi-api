import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { current_context, run_in_context } from './context';
import { require_disk_space } from './disk';
import { FileSink, format_line } from './log';
import { request_context } from './request_id';

const dir = mkdtempSync(path.join(tmpdir(), 'illusi-obs-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function day_offset(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

describe('log files', () => {
	it('writes JSON lines to a daily file and prunes files past retention', async () => {
		const log_dir = mkdtempSync(path.join(dir, 'logs-'));
		writeFileSync(path.join(log_dir, `api-${day_offset(9)}.log`), 'old\n');
		writeFileSync(path.join(log_dir, `api-${day_offset(3)}.log`), 'recent\n');
		writeFileSync(path.join(log_dir, 'notes.txt'), 'not a log\n');
		const sink = new FileSink(log_dir, 'api', 7);
		run_in_context({ request_id: 'req-12345678', user_id: () => 'user-1' }, () => {
			sink.write(format_line('info', 'test', 'hello', { n: 1 }));
		});
		await sink.flush();

		const files = readdirSync(log_dir).sort();
		expect(files).toEqual([`api-${day_offset(3)}.log`, `api-${day_offset(0)}.log`, 'notes.txt'].sort());
		const line = JSON.parse(readFileSync(path.join(log_dir, `api-${day_offset(0)}.log`), 'utf8').trim()) as Record<string, unknown>;
		expect(line).toMatchObject({ level: 'info', scope: 'test', msg: 'hello', request_id: 'req-12345678', user_id: 'user-1', data: { n: 1 } });
	});

	it('serializes errors with their stack', () => {
		const line = JSON.parse(format_line('error', 'test', 'boom', new Error('bad'))) as { data: { message: string; stack: string } };
		expect(line.data.message).toBe('bad');
		expect(line.data.stack).toContain('Error: bad');
	});
});

function fake_res() {
	const headers = new Map<string, unknown>();
	const listeners = new Map<string, (() => void)[]>();
	return {
		statusCode: 200,
		writableFinished: true,
		setHeader: (k: string, v: unknown) => { headers.set(k.toLowerCase(), v); },
		getHeader: (k: string) => headers.get(k.toLowerCase()),
		on: (event: string, fn: () => void) => { listeners.set(event, [...listeners.get(event) ?? [], fn]); },
		setMaxListeners: () => undefined,
		headers,
		emit: (event: string) => { for (const fn of listeners.get(event) ?? []) fn(); }
	};
}

function fake_req(headers: Record<string, string> = {}) {
	return { headers, method: 'GET', path: '/api/v1/me', originalUrl: '/api/v1/me?x=1', baseUrl: '', ip: '127.0.0.1' };
}

describe('request ids', () => {
	it('keeps a well-formed incoming id and exposes it to the handler and the response', () => {
		const res = fake_res();
		const req = fake_req({ 'x-request-id': 'abcdef0123456789abcdef0123456789' });
		let seen: string | undefined;
		request_context(req as unknown as Request, res as unknown as Response, () => { seen = current_context()?.request_id; });
		expect(seen).toBe('abcdef0123456789abcdef0123456789');
		expect(res.headers.get('x-request-id')).toBe(seen);
		res.emit('finish');
	});

	it('replaces a missing or malformed id with a new one', () => {
		for (const headers of [{}, { 'x-request-id': 'bad id with spaces' }, { 'x-request-id': 'x'.repeat(500) }] as Record<string, string>[]) {
			const res = fake_res();
			request_context(fake_req(headers) as unknown as Request, res as unknown as Response, () => undefined);
			expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/u);
		}
	});
});

describe('require_disk_space', () => {
	const original = { dir: config.MEDIA_DIR, min: config.DISK_MIN_FREE_GB };
	afterEach(() => {
		config.MEDIA_DIR = original.dir;
		config.DISK_MIN_FREE_GB = original.min;
	});

	async function run_guard(): Promise<{ called: boolean; status: number | null; res: ReturnType<typeof fake_res> }> {
		const res = fake_res();
		let called = false;
		let status: number | null = null;
		const response = Object.assign(res, {
			status: (code: number) => { status = code; return response; },
			json: () => response
		});
		const next: NextFunction = () => { called = true; };
		await require_disk_space({} as Request, response as unknown as Response, next);
		return { called, status, res };
	}

	it('lets uploads through while enough space is free', async () => {
		config.MEDIA_DIR = dir;
		config.DISK_MIN_FREE_GB = 0;
		const { called, status } = await run_guard();
		expect(called).toBe(true);
		expect(status).toBeNull();
	});

	it('refuses with 507 and closes the connection below the minimum', async () => {
		config.MEDIA_DIR = dir;
		config.DISK_MIN_FREE_GB = 1e9;
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { called, status, res } = await run_guard();
		expect(called).toBe(false);
		expect(status).toBe(507);
		expect(res.headers.get('connection')).toBe('close');
	});
});
