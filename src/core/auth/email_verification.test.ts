import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted((): { ex: unknown; send: ReturnType<typeof vi.fn> } => ({ ex: null, send: vi.fn() }));
vi.mock('../../db', () => ({ db: new Proxy({}, { get: (_t, p) => (h.ex as Record<string, unknown>)[p as string] }) }));
vi.mock('../email', () => ({ send_email: h.send }));

import { hash_token } from './tokens';
import { send_verification_email, verification_link, verify_email } from './email_verification';

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
const setup = (results: unknown[]) => { t = make_ex(results); h.ex = t.ex; h.send.mockReset(); h.send.mockResolvedValue(undefined); };

describe('verification_link', () => {
	it('joins the public url without a double slash', () => {
		expect(verification_link('tok')).toBe('http://localhost:3000/api/v1/auth/verify_email?token=tok');
	});
});

describe('send_verification_email', () => {
	it('replaces pending links, stores only the hash and emails the link', async () => {
		setup([undefined, undefined]);
		await send_verification_email({ id: 'u1', email: 'a@b.c', username: 'A<script>' });
		expect(t.calls.map(c => c.op)).toEqual(['delete', 'insert']);
		const values = t.arg(t.calls[1], 'values') as { token_hash: string; email: string; expires_at: Date };
		expect(values.email).toBe('a@b.c');
		expect(values.expires_at.getTime()).toBeGreaterThan(Date.now());
		const mail = h.send.mock.calls[0][0] as { to: string; text: string; html: string };
		const token = /token=([\w-]+)/u.exec(mail.text)![1];
		expect(hash_token(token)).toBe(values.token_hash);
		expect(mail.to).toBe('a@b.c');
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).toContain('&#60;script&#62;');
	});

	it('propagates a send failure', async () => {
		setup([undefined, undefined]);
		h.send.mockRejectedValue(new Error('smtp down'));
		await expect(send_verification_email({ id: 'u1', email: 'a@b.c', username: 'a' })).rejects.toThrow('smtp down');
	});
});

describe('verify_email', () => {
	it('is false for unknown, used or expired tokens', async () => {
		setup([[]]);
		expect(await verify_email('x')).toBe(false);
		expect(t.calls).toHaveLength(1);
	});

	it('marks the link used and the user verified', async () => {
		setup([[{ id: 5, user_id: 'u1', email: 'a@b.c' }], undefined, [{ id: 'u1' }]]);
		expect(await verify_email('x')).toBe(true);
		expect(t.arg(t.calls[1], 'set')).toHaveProperty('used_at');
		expect(t.arg(t.calls[2], 'set')).toHaveProperty('email_verified_at');
	});

	it('is false when the account email changed since the link was sent', async () => {
		setup([[{ id: 5, user_id: 'u1', email: 'old@b.c' }], undefined, []]);
		expect(await verify_email('x')).toBe(false);
	});
});
