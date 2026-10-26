import { describe, expect, it } from 'vitest';
import { batch_collections, chunk } from './batching';

describe('batch_collections', () => {
	it('keeps each lookup at ≤ 200 results counting one collection row per album', () => {
		const albums = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, track_count: 5 + (i % 17) }));
		const batches = batch_collections(albums);
		const cost = new Map(albums.map(a => [a.id, a.track_count + 1]));
		for (const b of batches) expect(b.reduce((s, id) => s + cost.get(id)!, 0)).toBeLessThanOrEqual(200);
		expect(batches.flat().sort((a, b) => a - b)).toEqual(albums.map(a => a.id));
	});
	it('is exact at the boundary', () => {
		expect(batch_collections([{ id: 1, track_count: 99 }, { id: 2, track_count: 99 }])).toEqual([[1, 2]]);
		expect(batch_collections([{ id: 1, track_count: 99 }, { id: 2, track_count: 100 }])).toHaveLength(2);
		expect(batch_collections([{ id: 1, track_count: 199 }])).toEqual([[1]]);
	});
	it('gives oversized or unknown albums their own lookup and drops duplicates', () => {
		const batches = batch_collections([{ id: 1, track_count: 250 }, { id: 2, track_count: 3 }, { id: 3 }, { id: 2, track_count: 3 }, { id: 4, track_count: 4 }]);
		expect(batches).toEqual([[4, 2], [1], [3]]);
	});
	it('honours a custom limit', () => {
		expect(batch_collections([{ id: 1, track_count: 4 }, { id: 2, track_count: 4 }, { id: 3, track_count: 4 }], 10)).toEqual([[1, 2], [3]]);
	});
});

describe('chunk', () => {
	it('splits into lookups of at most 200 ids', () => {
		const ids = Array.from({ length: 450 }, (_, i) => String(i));
		expect(chunk(ids).map(c => c.length)).toEqual([200, 200, 50]);
		expect(chunk([])).toEqual([]);
	});
});
