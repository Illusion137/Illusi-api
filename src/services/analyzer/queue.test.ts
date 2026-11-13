import { describe, expect, it } from 'vitest';
import { JobQueue } from './queue';

const make = () => new JobQueue<{ id: string }>(j => j.id);

describe('JobQueue', () => {
	it('reports size and held count and refuses queued or running keys', () => {
		const q = make();
		expect(q.push({ id: 'a' })).toBe(true);
		expect(q.push({ id: 'a' })).toBe(false);
		expect(q.size).toBe(1);
		expect(q.held_count).toBe(1);
		expect(q.has('a')).toBe(true);
	});
	it('keeps a key held while running and frees it on release', async () => {
		const q = make();
		q.push({ id: 'a' });
		expect(await q.next()).toEqual({ id: 'a' });
		expect(q.size).toBe(0);
		expect(q.push({ id: 'a' })).toBe(false);
		q.release('a');
		expect(q.push({ id: 'a' })).toBe(true);
	});
	it('hands a pushed job straight to a waiting consumer', async () => {
		const q = make();
		const waiting = q.next();
		q.push({ id: 'a' });
		expect(await waiting).toEqual({ id: 'a' });
		expect(q.size).toBe(0);
	});
	it('puts a retried job at the front', async () => {
		const q = make();
		q.push({ id: 'a' });
		q.push({ id: 'b' });
		const a = (await q.next())!;
		q.push_front(a);
		expect(await q.next()).toEqual({ id: 'a' });
		expect(await q.next()).toEqual({ id: 'b' });
	});
	it('drops a retried job instead of requeueing it once closed', () => {
		const q = make();
		q.push({ id: 'a' });
		q.close();
		q.push_front({ id: 'a' });
		expect(q.size).toBe(0);
		expect(q.held_count).toBe(0);
	});
	it('close wakes waiters with null, drops queued jobs and refuses new ones until reopened', async () => {
		const q = make();
		const waiting = q.next();
		q.close();
		expect(await waiting).toBeNull();
		expect(await q.next()).toBeNull();
		expect(q.push({ id: 'a' })).toBe(false);
		q.reopen();
		expect(q.push({ id: 'a' })).toBe(true);
		q.push({ id: 'b' });
		q.close();
		expect(q.held_count).toBe(0);
	});
});

describe('JobQueue priorities', () => {
	const by_rank = () => new JobQueue<{ id: string; rank: number }>(j => j.id, (a, b) => a.rank - b.rank);

	it('hands out the highest priority first, first in first out among equals', async () => {
		const q = by_rank();
		for (const [id, rank] of [['a', 3], ['b', 1], ['c', 2], ['d', 1], ['e', 3], ['f', 0]] as const) q.push({ id, rank });
		const order: string[] = [];
		while (q.size > 0) order.push((await q.next())!.id);
		expect(order).toEqual(['f', 'b', 'd', 'c', 'a', 'e']);
	});

	it('serves a retry before any priority', async () => {
		const q = by_rank();
		q.push({ id: 'a', rank: 5 });
		q.push({ id: 'b', rank: 0 });
		q.push({ id: 'c', rank: 1 });
		const b = (await q.next())!;
		q.push_front(b);
		expect((await q.next())!.id).toBe('b');
		expect((await q.next())!.id).toBe('c');
		expect((await q.next())!.id).toBe('a');
	});

	it('updates and reorders a queued job, but not a running or unknown one', async () => {
		const q = by_rank();
		for (const [id, rank] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) q.push({ id, rank });
		const a = (await q.next())!;
		expect(q.update('a', (j) => { j.rank = 9; })).toBe(false);
		expect(a.rank).toBe(1);
		expect(q.update('x', () => undefined)).toBe(false);
		expect(q.update('d', (j) => { j.rank = 0; })).toBe(true);
		q.push_front(a);
		expect(q.update('a', (j) => { j.rank = 7; })).toBe(true);
		const order: string[] = [];
		while (q.size > 0) order.push((await q.next())!.id);
		expect(order).toEqual(['a', 'd', 'b', 'c']);
	});

	it('keeps order over many jobs', async () => {
		const q = by_rank();
		const ranks = Array.from({ length: 200 }, (_, i) => (i * 37) % 101);
		ranks.forEach((rank, i) => q.push({ id: String(i), rank }));
		const out: number[] = [];
		while (q.size > 0) out.push((await q.next())!.rank);
		expect(out).toEqual([...ranks].sort((a, b) => a - b));
	});
});
