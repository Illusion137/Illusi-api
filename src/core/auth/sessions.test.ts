import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted((): { ex: unknown } => ({ ex: null }));
vi.mock('../../db', () => ({ db: new Proxy({}, { get: (_t, p) => (h.ex as Record<string, unknown>)[p as string] }) }));
vi.mock('../log', () => ({ logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { create_session, is_session_live, revoke_all_for_user, revoke_family, rotate_refresh_token } from './sessions';
import { hash_token, verify_access_token } from './tokens';

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
const row = (over: Record<string, unknown> = {}) => ({ id: 'row-1', family_id: 'fam-1', user_id: 'u1', device_name: 'phone', revoked_at: null, replaced_by: null, expires_at: new Date(Date.now() + 60_000), ...over });

beforeEach(() => { setup([]); });

describe('create_session', () => {
	it('stores only the token hash and signs a token bound to the new family', async () => {
		setup([undefined]);
		const pair = await create_session({ id: 'u1', role: 'USER' }, 'iphone');
		const values = t.arg(t.calls[0], 'values') as Record<string, unknown>;
		expect(values.token_hash).toBe(hash_token(pair.refresh_token));
		expect(values).toMatchObject({ user_id: 'u1', device_name: 'iphone', family_id: values.id });
		expect(values.token_hash).not.toBe(pair.refresh_token);
		expect(await verify_access_token(pair.access_token)).toEqual({ id: 'u1', role: 'USER', sid: values.id });
	});

	it('defaults device_name to null', async () => {
		setup([undefined]);
		await create_session({ id: 'u1', role: 'USER' });
		expect((t.arg(t.calls[0], 'values') as Record<string, unknown>).device_name).toBeNull();
	});
});

describe('rotate_refresh_token', () => {
	it('rejects unknown tokens', async () => {
		setup([[]]);
		expect(await rotate_refresh_token('x')).toEqual({ ok: false, reason: 'unknown' });
	});

	it('detects reuse of a rotated token and revokes the family', async () => {
		setup([[row({ revoked_at: new Date(), replaced_by: 'row-2' })], undefined]);
		expect(await rotate_refresh_token('x')).toEqual({ ok: false, reason: 'reused' });
		expect(t.calls[1].op).toBe('update');
	});

	it('reports a plainly revoked token without touching the family', async () => {
		setup([[row({ revoked_at: new Date() })]]);
		expect(await rotate_refresh_token('x')).toEqual({ ok: false, reason: 'revoked' });
		expect(t.calls).toHaveLength(1);
	});

	it('rejects expired tokens', async () => {
		setup([[row({ expires_at: new Date(Date.now() - 1) })]]);
		expect(await rotate_refresh_token('x')).toEqual({ ok: false, reason: 'expired' });
	});

	it('rejects a token whose user no longer exists', async () => {
		setup([[row()], []]);
		expect(await rotate_refresh_token('x')).toEqual({ ok: false, reason: 'unknown' });
	});

	it('rotates within the family and links the old row to the new one', async () => {
		setup([[row()], [{ id: 'u1', role: 'ADMIN' }], undefined, undefined]);
		const result = await rotate_refresh_token('old');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const inserted = t.arg(t.calls[2], 'values') as Record<string, unknown>;
		expect(inserted).toMatchObject({ family_id: 'fam-1', user_id: 'u1', device_name: 'phone', token_hash: hash_token(result.tokens.refresh_token) });
		expect(t.arg(t.calls[3], 'set')).toMatchObject({ replaced_by: inserted.id });
		expect(await verify_access_token(result.tokens.access_token)).toEqual({ id: 'u1', role: 'ADMIN', sid: 'fam-1' });
	});
});

describe('revocation and liveness', () => {
	it('revoke_family and revoke_all_for_user issue an update', async () => {
		setup([undefined, undefined]);
		await revoke_family('fam-1');
		await revoke_all_for_user('u1');
		expect(t.calls.map(c => c.op)).toEqual(['update', 'update']);
		expect(t.arg(t.calls[0], 'set')).toHaveProperty('revoked_at');
	});

	it('is_session_live reflects whether a live row exists', async () => {
		setup([[{ id: 'a' }], []]);
		expect(await is_session_live(t.ex as never, 'fam-1')).toBe(true);
		expect(await is_session_live(t.ex as never, 'fam-1')).toBe(false);
	});
});
