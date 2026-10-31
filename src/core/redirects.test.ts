import { describe, expect, it } from 'vitest';
import { resolve_redirect, resolve_redirects } from './redirects';

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

const r = (old_id: string, new_id: string) => ({ old_id, new_id });

describe('resolve_redirects', () => {
	it('maps unredirected ids to themselves with one query', async () => {
		const { ex, calls } = make_ex([[]]);
		const map = await resolve_redirects(ex as never, ['a', 'b']);
		expect([...map]).toEqual([['a', 'a'], ['b', 'b']]);
		expect(calls).toHaveLength(1);
	});

	it('does not query for no ids', async () => {
		const { ex, calls } = make_ex([]);
		expect((await resolve_redirects(ex as never, [])).size).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it('follows chains hop by hop', async () => {
		const { ex } = make_ex([[r('a', 'b'), r('x', 'y')], [r('b', 'c')], []]);
		const map = await resolve_redirects(ex as never, ['a', 'x', 'z']);
		expect(Object.fromEntries(map)).toEqual({ a: 'c', x: 'y', z: 'z' });
	});

	it('stops after 10 hops on a cycle', async () => {
		const results = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? [r('a', 'b')] : [r('b', 'a')]));
		const { ex, calls } = make_ex(results);
		const map = await resolve_redirects(ex as never, ['a']);
		expect(calls).toHaveLength(10);
		expect(['a', 'b']).toContain(map.get('a'));
	});

	it('resolve_redirect returns the single target', async () => {
		const { ex } = make_ex([[r('a', 'b')], []]);
		expect(await resolve_redirect(ex as never, 'a')).toBe('b');
	});
});
