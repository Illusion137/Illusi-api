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
