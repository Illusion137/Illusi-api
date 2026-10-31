import { describe, expect, it } from 'vitest';
import { add_review_item } from './review';

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

const report = { kind: 'DUPLICATE' as never, entity_table: 'tracks', entity_id: '1', field: 'name', proposed_value: 'B', source_user_id: 'u1' };
const existing = (over: Record<string, unknown> = {}) => ({
	id: 9, proposed_values: [{ value: 'B', source_user_ids: ['u1'], occurrences: 1 }], source_user_ids: ['u1'], occurrences: 1, current_value: 'A', details: { d: 1 }, ...over
});

describe('add_review_item', () => {
	it('inserts a new open item with one proposal', async () => {
		const { ex, calls, arg } = make_ex([[], [{ id: 5 }]]);
		expect(await add_review_item(ex as never, { ...report, current_value: 'A' })).toBe(5);
		expect(arg(calls[1], 'values')).toMatchObject({
			entity_table: 'tracks', field: 'name', occurrences: 1, source_user_ids: ['u1'], current_value: 'A',
			proposed_values: [{ value: 'B', source_user_ids: ['u1'], occurrences: 1 }], dedupe_key: expect.stringMatching(/^[0-9a-f]{64}$/u)
		});
	});

	it('uses the same dedupe key per kind, entity and field, and different ones otherwise', async () => {
		const keys: string[] = [];
		for (const field of ['name', 'name', 'other']) {
			const { ex, calls, arg } = make_ex([[], [{ id: 1 }]]);
			await add_review_item(ex as never, { ...report, field });
			keys.push((arg(calls[1], 'values') as { dedupe_key: string }).dedupe_key);
		}
		expect(keys[0]).toBe(keys[1]);
		expect(keys[0]).not.toBe(keys[2]);
	});

	it('handles reports without field, user or proposed value', async () => {
		const { ex, calls, arg } = make_ex([[], [{ id: 2 }]]);
		await add_review_item(ex as never, { kind: 'DUPLICATE' as never, entity_table: 't', entity_id: '1' });
		expect(arg(calls[1], 'values')).toMatchObject({ field: null, source_user_ids: [], proposed_values: [{ value: null, source_user_ids: [] }], current_value: null, details: null });
	});

	it('retries after losing an insert race and then bumps the winner', async () => {
		const { ex, calls } = make_ex([[], [], [existing()], undefined]);
		expect(await add_review_item(ex as never, report)).toBe(9);
		expect(calls.map(c => c.op)).toEqual(['select', 'insert', 'select', 'update']);
	});

	it('bumps a matching proposal and adds a new user', async () => {
		const { ex, calls, arg } = make_ex([[existing()], undefined]);
		await add_review_item(ex as never, { ...report, source_user_id: 'u2', plan: { p: 1 }, evidence: { e: 1 } });
		expect(arg(calls[1], 'set')).toMatchObject({
			proposed_values: [{ value: 'B', source_user_ids: ['u1', 'u2'], occurrences: 2, plan: { p: 1 }, evidence: { e: 1 } }],
			source_user_ids: ['u1', 'u2'], occurrences: 2, current_value: 'A', details: { d: 1 }
		});
	});

	it('does not duplicate a repeating user', async () => {
		const { ex, calls, arg } = make_ex([[existing()], undefined]);
		await add_review_item(ex as never, report);
		expect(arg(calls[1], 'set')).toMatchObject({ source_user_ids: ['u1'], proposed_values: [{ source_user_ids: ['u1'], occurrences: 2 }] });
	});

	it('groups a conflicting proposal separately and overrides current_value and details', async () => {
		const { ex, calls, arg } = make_ex([[existing()], undefined]);
		await add_review_item(ex as never, { ...report, proposed_value: 'C', source_user_id: null, current_value: 'Z', details: { d: 2 } });
		const set = arg(calls[1], 'set') as { proposed_values: unknown[]; source_user_ids: string[]; current_value: string; details: unknown };
		expect(set.proposed_values).toHaveLength(2);
		expect(set.source_user_ids).toEqual(['u1']);
		expect(set).toMatchObject({ current_value: 'Z', details: { d: 2 } });
	});

	it('copes with an existing row without proposals', async () => {
		const { ex, calls, arg } = make_ex([[existing({ proposed_values: null })], undefined]);
		await add_review_item(ex as never, report);
		expect((arg(calls[1], 'set') as { proposed_values: unknown[] }).proposed_values).toHaveLength(1);
	});
});
