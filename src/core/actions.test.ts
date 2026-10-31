import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ live: vi.fn() }));
vi.mock('./auth/sessions', () => ({ is_session_live: h.live }));
vi.mock('./log', () => ({ logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { consume_action_token, issue_action, issue_actions, release_check_target, research_target, with_actions } from './actions';
import type { ActionBody } from './actions';

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

const user = { id: 'u1', role: 'USER', sid: 'sid-1' } as const;
const key = new TextEncoder().encode(process.env.ACTION_TOKEN_SECRET);
const claims = (over: Record<string, unknown> = {}) => ({ typ: 'UPLOAD_MEDIA', tgt: 't1', sid: 'sid-1', ...over });
const sign = (payload: Record<string, unknown>, sub: string | null = 'u1', jti: string | null = 'jti-1', exp: number = Math.floor(Date.now() / 1000) + 60) => {
	let jwt = new SignJWT(payload).setProtectedHeader({ alg: 'HS256' });
	if (sub) jwt = jwt.setSubject(sub);
	if (jti) jwt = jwt.setJti(jti);
	jwt = jwt.setExpirationTime(exp);
	return jwt.sign(key);
};

let t: ReturnType<typeof make_ex>;
beforeEach(() => { t = make_ex([[{ jti: 'jti-1' }]]); h.live.mockReset(); h.live.mockResolvedValue(true); });
const consume = (token: string, type: Parameters<typeof consume_action_token>[3] = 'UPLOAD_MEDIA', target = 't1') => consume_action_token(t.ex as never, user, token, type, target);

describe('targets', () => {
	it('are service:id pairs', () => {
		expect(research_target('spotify', 't')).toBe('spotify:t');
		expect(release_check_target('spotify', 'a')).toBe('spotify:a');
	});
});

describe('issue_action', () => {
	it('keeps the body and adds a token consumable for its type and target', async () => {
		const action = await issue_action(user, { type: 'UPLOAD_MEDIA', track_id: 't1' });
		expect(action).toMatchObject({ type: 'UPLOAD_MEDIA', track_id: 't1' });
		const consumed = await consume(action.token);
		expect(consumed).toMatchObject({ user_id: 'u1', type: 'UPLOAD_MEDIA', target: 't1' });
	});

	it.each<[ActionBody, string]>([
		[{ type: 'FETCH_NEW_RELEASES', artist_id: 'a1', service: 'spotify', service_artist_id: 'x', since: '2026-01-01' }, 'spotify:a1'],
		[{ type: 'RESEARCH_TRACK', track_id: 't9', service: 'deezer', query: 'q', title: 't', artists: [], duration_ms: null }, 'deezer:t9'],
		[{ type: 'CHECK_GENIUS', track_id: 't2', query: 'q' }, 't2']
	])('targets %j as %s', async (body, target) => {
		const action = await issue_action(user, body);
		expect((await consume(action.token, body.type, target)).target).toBe(target);
	});

	it('gives every token its own jti', async () => {
		const [a, b] = await issue_actions(user, [{ type: 'UPLOAD_MEDIA', track_id: 't1' }, { type: 'UPLOAD_MEDIA', track_id: 't1' }]);
		expect(a.token).not.toBe(b.token);
	});
});

describe('consume_action_token', () => {
	it('rejects bad signatures and expiry with 401', async () => {
		await expect(consume('garbage')).rejects.toMatchObject({ status: 401 });
		const expired = await sign(claims(), 'u1', 'j', Math.floor(Date.now() / 1000) - 10);
		await expect(consume(expired)).rejects.toMatchObject({ status: 401, message: 'invalid or expired action token' });
	});

	it.each([
		['sub', async () => sign(claims(), null)],
		['jti', async () => sign(claims(), 'u1', null)],
		['typ', async () => sign({ tgt: 't1', sid: 's' })],
		['sid', async () => sign({ typ: 'UPLOAD_MEDIA', tgt: 't1' })]
	])('rejects a token without %s as malformed', async (_name, make) => {
		await expect(consume(await make())).rejects.toMatchObject({ status: 401, message: 'malformed action token' });
	});

	it('rejects tokens issued to another user', async () => {
		await expect(consume(await sign(claims(), 'someone-else'))).rejects.toMatchObject({ status: 403, message: 'action token issued to another user' });
	});

	it('rejects a type or target mismatch', async () => {
		const token = await sign(claims());
		await expect(consume(token, 'CHECK_GENIUS')).rejects.toMatchObject({ status: 403, message: 'action token type mismatch' });
		await expect(consume(token, 'UPLOAD_MEDIA', 'other')).rejects.toMatchObject({ status: 403, message: 'action token target mismatch' });
	});

	it('rejects a revoked session before recording the use', async () => {
		h.live.mockResolvedValue(false);
		await expect(consume(await sign(claims()))).rejects.toMatchObject({ status: 401, message: 'action token session revoked' });
		expect(t.calls).toHaveLength(0);
	});

	it('rejects a replayed token', async () => {
		t = make_ex([[]]);
		await expect(consume(await sign(claims()))).rejects.toMatchObject({ status: 403, message: 'action token already used' });
	});

	it('records the use with the token expiry', async () => {
		const exp = Math.floor(Date.now() / 1000) + 120;
		await consume(await sign(claims(), 'u1', 'jti-1', exp));
		expect(t.arg(t.calls[0], 'values')).toMatchObject({ jti: 'jti-1', user_id: 'u1', type: 'UPLOAD_MEDIA', target: 't1', expires_at: new Date(exp * 1000) });
	});
});

describe('with_actions', () => {
	it('adds actions only when there are some', () => {
		const a = { type: 'UPLOAD_MEDIA', track_id: 't', token: 'x' } as const;
		expect(with_actions({ ok: 1 }, [])).toEqual({ ok: 1 });
		expect(with_actions({ ok: 1 }, [a])).toEqual({ ok: 1, actions: [a] });
	});
});
