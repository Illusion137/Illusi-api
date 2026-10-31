import type { Server } from 'node:http';
import express from 'express';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { error_handler, HttpError, json_body, parse_body, require_user, uuid_schema } from './http';

const log_error = vi.hoisted(() => vi.fn());
vi.mock('./log', () => ({ logger: () => ({ error: log_error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

describe('helpers', () => {
	it('parse_body returns parsed data', () => {
		expect(parse_body(z.object({ n: z.number() }), { n: 1 })).toEqual({ n: 1 });
	});

	it('parse_body throws 400 with issues', () => {
		try {
			parse_body(z.object({ n: z.number() }), { n: 'x' });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HttpError);
			expect((err as HttpError).status).toBe(400);
			expect((err as HttpError).body?.issues).toHaveLength(1);
		}
	});

	it('require_user returns the user or throws 401', () => {
		const user = { id: 'u', role: 'USER', sid: 's' };
		expect(require_user({ user } as unknown as Request)).toBe(user);
		expect(() => require_user({} as Request)).toThrow(expect.objectContaining({ status: 401 }));
	});

	it('uuid_schema accepts uuids only', () => {
		expect(uuid_schema.safeParse('3f2b8c1e-5a4d-4e3b-9c7a-1d2e3f4a5b6c').success).toBe(true);
		expect(uuid_schema.safeParse('nope').success).toBe(false);
	});
});

describe('error_handler over http', () => {
	let server: Server;
	let base: string;

	beforeAll(async () => {
		const app = express();
		app.post('/json', json_body('10b'), (req, res) => { res.json(req.body as object); });
		app.get('/http_4xx', () => { throw new HttpError(409, 'conflict', { code: 'X' }); });
		app.get('/http_5xx', () => { throw new HttpError(503, 'down'); });
		app.get('/status_err', () => { throw Object.assign(new Error('teapot'), { status: 418 }); });
		app.get('/status_3xx', () => { throw Object.assign(new Error('moved'), { status: 301 }); });
		app.get('/boom', (req, _res, next) => { req.request_id = 'rid-1'; next(new Error('secret detail')); });
		app.use(error_handler);
		server = app.listen(0);
		await new Promise(resolve => server.once('listening', resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	afterAll(() => { server.close(); });

	it('renders HttpError with extra body fields', async () => {
		const res = await fetch(`${base}/http_4xx`);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'conflict', code: 'X' });
		expect(log_error).not.toHaveBeenCalled();
	});

	it('logs 5xx HttpErrors', async () => {
		const res = await fetch(`${base}/http_5xx`);
		expect(res.status).toBe(503);
		expect(log_error).toHaveBeenCalledWith('down', expect.any(HttpError));
	});

	it('passes through 4xx status errors', async () => {
		const res = await fetch(`${base}/status_err`);
		expect(res.status).toBe(418);
		expect(await res.json()).toEqual({ error: 'teapot' });
	});

	it('hides unknown errors behind a 500 with the request id', async () => {
		const res = await fetch(`${base}/boom`);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'internal error', request_id: 'rid-1' });
		expect(log_error).toHaveBeenCalledWith('unhandled error', expect.any(Error));
	});

	it('treats non-4xx status errors as 500', async () => {
		const res = await fetch(`${base}/status_3xx`);
		expect(res.status).toBe(500);
	});

	it('json_body enforces its size limit with 413 and rejects bad json with 400', async () => {
		const big = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(50) }) });
		expect(big.status).toBe(413);
		const bad = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{x' });
		expect(bad.status).toBe(400);
		const ok = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
		expect(await ok.json()).toEqual({ a: 1 });
	});
});
