import { describe, expect, it } from 'vitest';
import { WorkQueue } from './queue';
import type { Candidate } from './store';

const track = (illusi_id: string, track_name: string, artist_name = 'Artist'): Candidate =>
	({ illusi_id, entity_type: 'track', applemusic_id: null, request: { type: 'track', artist_name, track_name } });
const known = (illusi_id: string, applemusic_id: string): Candidate => ({ illusi_id, entity_type: 'track', applemusic_id, request: null });

describe('WorkQueue', () => {
	it('dedupes by type + normalized fields, sharing one request', () => {
		const q = new WorkQueue({ live: 3, backfill: 1 });
		expect(q.add(track('a', 'Song'), 'live')).toBe(true);
		expect(q.add(track('b', 'song!'), 'live')).toBe(true);
		expect(q.add(track('a', 'Song'), 'backfill')).toBe(false);
		expect(q.size()).toBe(1);
		expect(q.take()[0].illusi_ids).toEqual(['a', 'b']);
		expect(q.size()).toBe(0);
	});
	it('skips candidates with nothing to look up', () => {
		expect(new WorkQueue({ live: 3, backfill: 1 }).add({ illusi_id: 'x', entity_type: 'track', applemusic_id: null, request: null }, 'live')).toBe(false);
	});
	it('replaces a waiting search with a known id', () => {
		const q = new WorkQueue({ live: 3, backfill: 1 });
		q.add(track('a', 'Song'), 'backfill');
		q.add(known('a', '123'), 'live');
		expect(q.size('backfill')).toBe(0);
		expect(q.take()).toMatchObject([{ applemusic_id: '123', illusi_ids: ['a'] }]);
	});
	it('batches known ids from the same lane, up to 200 ids', () => {
		const q = new WorkQueue({ live: 3, backfill: 1 });
		for (let i = 0; i < 250; i++) q.add(known(`k${i}`, String(1000 + i)), 'live');
		q.add(track('s', 'Song'), 'live');
		const first = q.take();
		expect(first).toHaveLength(200);
		expect(q.take()).toHaveLength(50);
		expect(q.take()).toMatchObject([{ illusi_ids: ['s'] }]);
	});
	it('interleaves lanes at the ratio', () => {
		const q = new WorkQueue({ live: 3, backfill: 1 });
		for (let i = 0; i < 6; i++) q.add(track(`l${i}`, `Live ${i}`), 'live');
		for (let i = 0; i < 3; i++) q.add(track(`b${i}`, `Back ${i}`), 'backfill');
		const order = Array.from({ length: 9 }, () => q.take()[0].illusi_ids[0][0]).join('');
		expect(order).toBe('lllblllbb');
	});
});
