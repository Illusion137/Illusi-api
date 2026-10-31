import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted((): { ex: unknown; handlers: Record<string, (p: unknown) => void> } => ({ ex: null, handlers: {} }));
vi.mock('../../db', () => ({ db: new Proxy({}, { get: (_t, p) => (h.ex as Record<string, unknown>)[p as string] }) }));
vi.mock('../events', () => ({ on: (name: string, fn: (p: unknown) => void) => { h.handlers[name] = fn; } }));

import { run_in_context } from '../context';
import type { RequestContext } from '../context';
import { forget_user, require_admin, require_auth, require_verified } from './middleware';
import { sign_access_token } from './tokens';

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

const req_with = (header?: string) => ({ headers: { authorization: header } }) as unknown as Request & { user?: { id: string; role: string }; email_verified?: boolean };
const call = async (req: Request) => { const next = vi.fn(); await require_auth(req, {} as never, next); return next; };
let n = 0;
const token_for = async (role: 'USER' | 'ADMIN' = 'USER') => sign_access_token({ id: `user-${++n}`, role, sid: 'sid' });

beforeEach(() => { setup([]); h.handlers.ids_redirected(undefined); });

describe('require_auth', () => {
	it('rejects a missing or non-bearer header', async () => {
		await expect(call(req_with())).rejects.toMatchObject({ status: 401, message: 'missing access token' });
		await expect(call(req_with('Basic abc'))).rejects.toMatchObject({ status: 401 });
		await expect(call(req_with('Bearer   '))).rejects.toMatchObject({ status: 401 });
	});

	it('rejects an invalid token without touching the db', async () => {
		await expect(call(req_with('Bearer garbage'))).rejects.toMatchObject({ status: 401, message: 'invalid or expired access token' });
		expect(t.calls).toHaveLength(0);
	});

	it('rejects a valid token for a deleted user', async () => {
		setup([[]]);
		await expect(call(req_with(`Bearer ${await token_for()}`))).rejects.toMatchObject({ status: 401 });
	});

	it('sets the user and verification flag', async () => {
		setup([[{ verified: true }]]);
		const req = req_with(`Bearer ${await token_for()}`);
		const next = await call(req);
		expect(next).toHaveBeenCalledOnce();
		expect(req.user?.role).toBe('USER');
		expect(req.email_verified).toBe(true);
	});

	it('caches verified users and skips the db the second time', async () => {
		setup([[{ verified: true }]]);
		const token = await token_for();
		await call(req_with(`Bearer ${token}`));
		await call(req_with(`Bearer ${token}`));
		expect(t.calls).toHaveLength(1);
	});

	it('does not cache unverified users, so verification applies at once', async () => {
		setup([[{ verified: false }], [{ verified: true }]]);
		const token = await token_for();
		const first = req_with(`Bearer ${token}`);
		await call(first);
		expect(first.email_verified).toBe(false);
		const second = req_with(`Bearer ${token}`);
		await call(second);
		expect(second.email_verified).toBe(true);
		expect(t.calls).toHaveLength(2);
	});

	it('expires the cache after the ttl', async () => {
		vi.useFakeTimers();
		try {
			setup([[{ verified: true }], [{ verified: true }]]);
			const token = await token_for();
			await call(req_with(`Bearer ${token}`));
			vi.advanceTimersByTime(60_001);
			await call(req_with(`Bearer ${token}`));
			expect(t.calls).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('forget_user and the user_deleted event drop the cache entry', async () => {
		setup([[{ verified: true }], [{ verified: true }], [{ verified: true }]]);
		const token = await token_for();
		const user_id = `user-${n}`;
		await call(req_with(`Bearer ${token}`));
		forget_user(user_id);
		await call(req_with(`Bearer ${token}`));
		h.handlers.user_deleted({ user_id });
		await call(req_with(`Bearer ${token}`));
		expect(t.calls).toHaveLength(3);
	});

	it('ids_redirected clears the whole cache', async () => {
		setup([[{ verified: true }], [{ verified: true }]]);
		const token = await token_for();
		await call(req_with(`Bearer ${token}`));
		h.handlers.ids_redirected(undefined);
		await call(req_with(`Bearer ${token}`));
		expect(t.calls).toHaveLength(2);
	});

	it('a user deleted after being cached is refused once forgotten', async () => {
		setup([[{ verified: true }], []]);
		const token = await token_for();
		await call(req_with(`Bearer ${token}`));
		forget_user(`user-${n}`);
		await expect(call(req_with(`Bearer ${token}`))).rejects.toMatchObject({ status: 401 });
	});
});

describe('require_verified', () => {
	it('blocks unverified accounts with a code', () => {
		expect(() => require_verified({ email_verified: false } as Request, {} as never, vi.fn())).toThrow(expect.objectContaining({ status: 403, body: { code: 'EMAIL_NOT_VERIFIED' } }));
	});

	it('lets verified accounts through', () => {
		const next = vi.fn();
		require_verified({ email_verified: true } as Request, {} as never, next);
		expect(next).toHaveBeenCalled();
	});
});

describe('require_admin', () => {
	const admin_req = () => ({ user: { id: 'a', role: 'USER', sid: 's' } }) as unknown as Request;

	it('requires a user', async () => {
		await expect(require_admin({} as Request, {} as never, vi.fn())).rejects.toMatchObject({ status: 401 });
	});

	it('refuses non-admins according to the database, not the token', async () => {
		setup([[{ role: 'USER' }]]);
		const req = admin_req();
		(req.user as { role: string }).role = 'ADMIN';
		await expect(require_admin(req, {} as never, vi.fn())).rejects.toMatchObject({ status: 403 });
	});

	it('refuses when the user row is gone', async () => {
		setup([[]]);
		await expect(require_admin(admin_req(), {} as never, vi.fn())).rejects.toMatchObject({ status: 403 });
	});

	it('promotes the request and marks the context privileged', async () => {
		setup([[{ role: 'ADMIN' }]]);
		const req = admin_req();
		const context: RequestContext = { request_id: 'r', user_id: () => 'a' };
		const next = vi.fn();
		await run_in_context(context, () => require_admin(req, {} as never, next));
		expect(req.user?.role).toBe('ADMIN');
		expect(context.privileged).toBe(true);
		expect(next).toHaveBeenCalled();
	});

	it('works outside a request context', async () => {
		setup([[{ role: 'ADMIN' }]]);
		const next = vi.fn();
		await require_admin(admin_req(), {} as never, next);
		expect(next).toHaveBeenCalled();
	});
});
