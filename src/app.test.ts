import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted((): { ex: unknown } => ({ ex: null }));
vi.mock('./db', async original => ({
	...await original<Record<string, unknown>>(),
	db: new Proxy({}, { get: (_t, p) => (h.ex as Record<string, unknown>)[p as string] })
}));
vi.mock('./core/log', async (original) => {
	const real = await original<Record<string, unknown>>();
	return { ...real, logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
});

import { config } from './config';
import { sign_access_token } from './core/auth/tokens';
import { API_PREFIX, create_app, parse_trust_proxy } from './app';

type Step = [string, unknown[]];
interface Call { op: string; steps: Step[] }

/** Chainable drizzle stand-in: each awaited query resolves to the next queued result (an Error rejects). */
function make_ex(results: unknown[]) {
	const calls: Call[] = [];
	const start = (op: string) => {
		const call: Call = { op, steps: [] };
		calls.push(call);
		const chain: unknown = new Proxy({}, {
			get(_target, prop: string) {
				if (prop === 'then') {
					return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => {
						const r = results.shift();
						return (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)).then(ok, fail);
					};
				}
				return (...args: unknown[]) => { call.steps.push([prop, args]); return chain; };
			}
		});
		return chain;
	};
	const ex = {
		select: () => start('select'),
		insert: () => start('insert'),
		update: () => start('update'),
		delete: () => start('delete'),
		execute: () => start('execute'),
		transaction: async (fn: (tx: unknown) => unknown) => await fn(ex)
	};
	const arg = (call: Call, step: string) => call.steps.find(s => s[0] === step)?.[1][0];
	return { ex, calls, arg };
}

let t: ReturnType<typeof make_ex>;
const setup = (results: unknown[]) => { t = make_ex(results); h.ex = t.ex; };

let server: Server;
let base: string;
beforeAll(async () => {
	server = create_app().listen(0);
	await new Promise(resolve => server.once('listening', resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { setup([]); });

const bearer = async (role: 'USER' | 'ADMIN' = 'USER') => ({ authorization: `Bearer ${await sign_access_token({ id: 'user-app', role, sid: 'sid' })}` });
let n = 0;
const unique_bearer = async () => ({ authorization: `Bearer ${await sign_access_token({ id: `user-app-${++n}`, role: 'USER', sid: 'sid' })}` });

describe('parse_trust_proxy', () => {
	it('parses hop counts, booleans and subnet lists', () => {
		expect(parse_trust_proxy('1')).toBe(1);
		expect(parse_trust_proxy('true')).toBe(true);
		expect(parse_trust_proxy('false')).toBe(false);
		expect(parse_trust_proxy('loopback, uniquelocal')).toBe('loopback, uniquelocal');
		expect(parse_trust_proxy('10.0.0.0/8')).toBe('10.0.0.0/8');
	});
});

describe('create_app', () => {
	it('applies TRUST_PROXY to express', () => {
		const original = config.TRUST_PROXY;
		config.TRUST_PROXY = '2';
		try {
			expect(create_app().get('trust proxy')).toBe(2);
		} finally {
			config.TRUST_PROXY = original;
		}
	});

	it('answers unknown root paths with a JSON 404 and hides the framework', async () => {
		const res = await fetch(`${base}/nope`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not found' });
		expect(res.headers.get('x-powered-by')).toBeNull();
		expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/u);
	});

	it('echoes a well-formed request id', async () => {
		const res = await fetch(`${base}/health/live`, { headers: { 'x-request-id': 'my-request-id-1' } });
		expect(res.headers.get('x-request-id')).toBe('my-request-id-1');
		expect(await res.json()).toEqual({ ok: true });
	});

	it('exposes health outside the api prefix, not under it', async () => {
		expect(API_PREFIX).toBe('/api/v1');
		expect((await fetch(`${base}/api/v1/health/live`)).status).toBe(401);
	});

	it('serves the admin dashboard under a strict content security policy', async () => {
		const redirect = await fetch(`${base}/admin`, { redirect: 'manual' });
		expect(redirect.status).toBe(301);
		const page = await fetch(`${base}/admin/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('<script src="app.js"');
		expect(page.headers.get('content-security-policy')).toContain('script-src \'self\';');
		expect(page.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'');
		expect((await fetch(`${base}/admin/app.js`)).headers.get('content-type')).toMatch(/javascript/u);
		expect((await fetch(`${base}/admin/missing.js`)).status).toBe(404);
	});
});

describe('cors', () => {
	it('allows the configured domain and answers its preflights', async () => {
		const res = await fetch(`${base}/health/live`, { headers: { origin: 'https://app.sumii.me' } });
		expect(res.headers.get('access-control-allow-origin')).toBe('https://app.sumii.me');
		const pre = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { 'origin': 'https://sumii.me', 'access-control-request-method': 'GET' } });
		expect(pre.status).toBe(204);
		expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization');
	});

	it('gives other origins nothing and refuses their preflight', async () => {
		const res = await fetch(`${base}/health/live`, { headers: { origin: 'https://evil.example' } });
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
		const pre = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { 'origin': 'https://evil.example', 'access-control-request-method': 'GET' } });
		expect(pre.status).toBe(403);
	});
});

describe('auth gating', () => {
	it('keeps /auth open to anonymous callers', async () => {
		const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(res.status).toBe(400);
		const bad_json = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
		expect(bad_json.status).toBe(400);
	});

	it.each(['/api/v1/me', '/api/v1/admin/review', '/api/v1/anything/at/all'])('rejects anonymous %s with 401', async (path) => {
		const res = await fetch(`${base}${path}`);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'missing access token' });
	});

	it('rejects an unverified account outside /auth with 403 EMAIL_NOT_VERIFIED', async () => {
		setup([[{ verified: false }]]);
		const res = await fetch(`${base}/api/v1/me/exports`, { headers: await unique_bearer() });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'email not verified', code: 'EMAIL_NOT_VERIFIED' });
	});

	it('lets a deleted account know its token is dead', async () => {
		setup([[]]);
		const res = await fetch(`${base}/api/v1/me/exports`, { headers: await unique_bearer() });
		expect(res.status).toBe(401);
	});

	it('refuses non-admins on /admin even when the token claims ADMIN', async () => {
		setup([[{ verified: true }], [{ role: 'USER' }]]);
		const res = await fetch(`${base}/api/v1/admin/review`, { headers: await bearer('ADMIN') });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'admin only' });
	});

	it('returns a JSON 404 for unknown routes of a verified user', async () => {
		setup([[{ verified: true }]]);
		const res = await fetch(`${base}/api/v1/definitely/not/here`, { headers: await unique_bearer() });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not found' });
	});
});
