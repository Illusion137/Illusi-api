import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingEvents } from './events';
import { PG_ERRORS } from './pg_errors';

const warn = vi.hoisted(() => vi.fn());
vi.mock('./log', () => ({ logger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { enrich_service_ids, find_illusi_ids_by_service_ids } from './enrich';

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

const ctx = (events?: PendingEvents) => ({ source: 'test', user_id: 'u1', token_jti: 'j', events });
const events = () => {
	const push = vi.fn();
	return { events: { push } as unknown as PendingEvents, push };
};
const row = (over: Record<string, unknown> = {}) => ({ illusi_id: 'i1', youtube_id: null, spotify_id: null, isrc: null, applemusic_id: null, ...over });
beforeEach(() => { warn.mockClear(); });

describe('enrich_service_ids', () => {
	it('does nothing when every id is rejected, and reports them', async () => {
		const { ex, calls } = make_ex([]);
		const result = await enrich_service_ids(ex as never, 'i1', { youtube_id: 'bad' }, ctx());
		expect(result).toEqual({ filled: [], conflicts: [], rejected: [{ column: 'youtube_id', value: 'bad' }] });
		expect(calls).toHaveLength(0);
		expect(warn).toHaveBeenCalled();
	});

	it('never creates a row for an unknown illusi_id', async () => {
		const { ex, calls } = make_ex([[]]);
		const result = await enrich_service_ids(ex as never, 'i1', { deezer_id: '1' }, ctx());
		expect(result.filled).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it('fills empty columns and queues events', async () => {
		const { events: ev, push } = events();
		const { ex } = make_ex([[row()], [], [{ illusi_id: 'i1' }], [], [{ illusi_id: 'i1' }]]);
		const result = await enrich_service_ids(ex as never, 'i1', { youtube_id: 'dQw4w9WgXcQ', applemusic_id: '55' }, ctx(ev));
		expect(result.filled).toEqual(['youtube_id', 'applemusic_id']);
		expect(push).toHaveBeenCalledWith('service_ids_filled', { illusi_id: 'i1', columns: ['youtube_id', 'applemusic_id'] });
		expect(push).toHaveBeenCalledWith('applemusic_id_filled', { illusi_id: 'i1', applemusic_id: '55' });
	});

	it('skips events when there is no collector or nothing was filled', async () => {
		const { ex } = make_ex([[row()], [{ illusi_id: 'i1' }]]);
		expect((await enrich_service_ids(ex as never, 'i1', { isrc: 'USRC17607839' }, ctx())).filled).toEqual(['isrc']);
	});

	it('is a no-op when the value already matches', async () => {
		const { ex, calls } = make_ex([[row({ youtube_id: 'dQw4w9WgXcQ' })]]);
		const result = await enrich_service_ids(ex as never, 'i1', { youtube_id: 'dQw4w9WgXcQ' }, ctx());
		expect(result).toMatchObject({ filled: [], conflicts: [] });
		expect(calls).toHaveLength(1);
	});

	it('records a different_value conflict once and never overwrites', async () => {
		const { ex, calls, arg } = make_ex([[row({ youtube_id: 'aaaaaaaaaaa' })], [], undefined]);
		const result = await enrich_service_ids(ex as never, 'i1', { youtube_id: 'bbbbbbbbbbb' }, ctx());
		expect(result.conflicts).toEqual([{ column: 'youtube_id', kind: 'different_value', existing_value: 'aaaaaaaaaaa', incoming_value: 'bbbbbbbbbbb', other_illusi_id: null }]);
		expect(arg(calls[2], 'values')).toMatchObject({ illusi_id: 'i1', column: 'youtube_id', source: 'test', source_user_id: 'u1', source_token_jti: 'j' });
		expect(calls.filter(c => c.op === 'update')).toHaveLength(0);
	});

	it('does not record a conflict twice', async () => {
		const { ex, calls } = make_ex([[row({ youtube_id: 'aaaaaaaaaaa' })], [{ id: 1 }]]);
		await enrich_service_ids(ex as never, 'i1', { youtube_id: 'bbbbbbbbbbb' }, ctx());
		expect(calls.filter(c => c.op === 'insert')).toHaveLength(0);
	});

	it('flags an id owned by another entity as taken', async () => {
		const { ex } = make_ex([[row()], [{ illusi_id: 'i2' }], [], undefined]);
		const result = await enrich_service_ids(ex as never, 'i1', { spotify_id: '4uLU6hMCjMI75M1A2tKUQC' }, ctx());
		expect(result.conflicts).toEqual([{ column: 'spotify_id', kind: 'taken', existing_value: null, incoming_value: '4uLU6hMCjMI75M1A2tKUQC', other_illusi_id: 'i2' }]);
	});

	it('survives a unique violation from a concurrent writer and records it as taken', async () => {
		const { ex } = make_ex([[row()], [], Object.assign(new Error('dup'), { code: PG_ERRORS.unique_violation }), [{ illusi_id: 'i2' }], [], undefined]);
		const result = await enrich_service_ids(ex as never, 'i1', { deezer_id: '9' }, ctx());
		expect(result.conflicts[0]).toMatchObject({ kind: 'taken', other_illusi_id: 'i2' });
		expect(result.filled).toEqual([]);
	});

	it('reports other_illusi_id null when the racing owner vanished', async () => {
		const { ex } = make_ex([[row()], [], Object.assign(new Error('dup'), { code: PG_ERRORS.unique_violation }), [], [], undefined]);
		expect((await enrich_service_ids(ex as never, 'i1', { deezer_id: '9' }, ctx())).conflicts[0].other_illusi_id).toBeNull();
	});

	it('rethrows other database errors', async () => {
		const { ex } = make_ex([[row()], [], new Error('connection lost')]);
		await expect(enrich_service_ids(ex as never, 'i1', { deezer_id: '9' }, ctx())).rejects.toThrow('connection lost');
	});

	it('does not count a lost update race as filled', async () => {
		const { ex } = make_ex([[row()], [], []]);
		expect((await enrich_service_ids(ex as never, 'i1', { deezer_id: '9' }, ctx())).filled).toEqual([]);
	});
});

describe('find_illusi_ids_by_service_ids', () => {
	it('merges columns per matching illusi_id', async () => {
		const { ex } = make_ex([[{ illusi_id: 'i1' }], [{ illusi_id: 'i1' }, { illusi_id: 'i2' }]]);
		expect(await find_illusi_ids_by_service_ids(ex as never, { youtube_id: 'dQw4w9WgXcQ', isrc: 'USRC17607839', deezer_id: null })).toEqual([
			{ illusi_id: 'i1', columns: ['youtube_id', 'isrc'] },
			{ illusi_id: 'i2', columns: ['isrc'] }
		]);
	});

	it('is empty without usable ids', async () => {
		const { ex, calls } = make_ex([]);
		expect(await find_illusi_ids_by_service_ids(ex as never, { youtube_id: 'bad' })).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});
