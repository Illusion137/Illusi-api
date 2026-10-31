import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../db', () => ({ db: { execute: h.execute } }));

import { health_router, is_draining, set_draining } from './health';

let server: Server;
let base: string;
beforeAll(async () => {
	const app = express();
	app.use(health_router);
	server = app.listen(0);
	await new Promise(resolve => server.once('listening', resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); });

describe('health', () => {
	it('/health/live never touches the database', async () => {
		const res = await fetch(`${base}/health/live`);
		expect(await res.json()).toEqual({ ok: true });
		expect(h.execute).not.toHaveBeenCalled();
	});

	it('/health is 200 when the database answers', async () => {
		h.execute.mockResolvedValue([]);
		const res = await fetch(`${base}/health`);
		const body = await res.json() as { ok: boolean; status: string; version: string; checks: { database: { ok: boolean } } };
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(body).toMatchObject({ ok: true, status: 'ok', version: 'dev', checks: { database: { ok: true } } });
	});

	it('/health is 503 degraded with the database error', async () => {
		h.execute.mockRejectedValue(new Error('refused'));
		const res = await fetch(`${base}/health`);
		const body = await res.json() as { status: string; checks: { database: { error: string } } };
		expect(res.status).toBe(503);
		expect(body.status).toBe('degraded');
		expect(body.checks.database.error).toBe('refused');
	});

	it('/health times out a hanging database after 2s', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			h.execute.mockReturnValue(new Promise(() => undefined));
			const pending = fetch(`${base}/health`);
			await vi.waitFor(() => { expect(h.execute).toHaveBeenCalledTimes(3); });
			await vi.advanceTimersByTimeAsync(2_000);
			const res = await pending;
			expect(res.status).toBe(503);
			expect(((await res.json()) as { checks: { database: { error: string } } }).checks.database.error).toBe('timeout');
		} finally {
			vi.useRealTimers();
		}
	});

	it('turns 503 draining after set_draining even if the database is fine', async () => {
		h.execute.mockResolvedValue([]);
		expect(is_draining()).toBe(false);
		set_draining();
		expect(is_draining()).toBe(true);
		const res = await fetch(`${base}/health`);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { status: string }).status).toBe('draining');
		expect((await fetch(`${base}/health/live`)).status).toBe(200);
	});
});
