import { describe, expect, it } from 'vitest';
import { day_seed, mix_soundtrack, seeded_random, split_counts, weighted_order } from './logic';
import type { RotationTrack } from './logic';

const rotation = (n: number): RotationTrack[] => Array.from({ length: n }, (_, i) => ({ track_id: `r${i}`, plays: n - i, score: n - i }));
const recs = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

describe('seeded_random', () => {
	it('repeats for a seed, differs between seeds, stays in [0, 1)', () => {
		const a = seeded_random('x');
		const b = seeded_random('x');
		const values = Array.from({ length: 100 }, () => a());
		expect(values).toEqual(Array.from({ length: 100 }, () => b()));
		expect(values.every(v => v >= 0 && v < 1)).toBe(true);
		expect(seeded_random('y')()).not.toBe(values[0]);
	});

	it('seeds by user and UTC day', () => {
		expect(day_seed('u', new Date('2026-11-24T01:00:00Z'))).toBe(day_seed('u', new Date('2026-11-24T23:00:00Z')));
		expect(day_seed('u', new Date('2026-11-24T01:00:00Z'))).not.toBe(day_seed('u', new Date('2026-11-25T01:00:00Z')));
	});
});

describe('weighted_order', () => {
	it('puts heavier items first far more often', () => {
		const random = seeded_random('w');
		let heavy_first = 0;
		for (let i = 0; i < 500; i++) if (weighted_order(['light', 'heavy'], item => (item === 'heavy' ? 20 : 1), random)[0] === 'heavy') heavy_first++;
		expect(heavy_first).toBeGreaterThan(430);
	});
});

describe('split_counts', () => {
	it('takes the share, and lets either side fill in for the other', () => {
		expect(split_counts(100, 100, 50)).toEqual({ rotation: 20, recommended: 30 });
		expect(split_counts(3, 100, 50)).toEqual({ rotation: 3, recommended: 47 });
		expect(split_counts(100, 5, 50)).toEqual({ rotation: 45, recommended: 5 });
		expect(split_counts(2, 3, 50)).toEqual({ rotation: 2, recommended: 3 });
	});
});

describe('mix_soundtrack', () => {
	it('spreads the two sides through each other, opening with heavy rotation, without repeats', () => {
		const mix = mix_soundtrack({ rotation: rotation(10), recommended: [...recs(30), 'r0'], artists: new Map(), limit: 10, random: seeded_random('m') });
		expect(mix).toHaveLength(10);
		expect(mix[0].reason).toBe('heavy_rotation');
		expect(mix.filter(m => m.reason === 'heavy_rotation')).toHaveLength(4);
		expect(new Set(mix.map(m => m.track_id)).size).toBe(10);
		// Never three of one side in a row with a 4:6 split
		const runs = mix.map(m => m.reason).join(',');
		expect(runs).not.toMatch(/(heavy_rotation,){2}heavy_rotation|(for_you,){2}for_you/u);
	});

	it('is the same for the same seed', () => {
		const opts = { rotation: rotation(20), recommended: recs(40), artists: new Map(), limit: 25 };
		expect(mix_soundtrack({ ...opts, random: seeded_random('s') })).toEqual(mix_soundtrack({ ...opts, random: seeded_random('s') }));
	});

	it('avoids the same artist twice in a row when another track is near', () => {
		const artists = new Map<string, string[]>([['r0', ['a']], ['r1', ['a']], ['f0', ['a']], ['f1', ['b']], ['f2', ['a']]]);
		const mix = mix_soundtrack({ rotation: rotation(2), recommended: recs(3), artists, limit: 5, random: seeded_random('a'), rotation_share: 0.4 });
		for (let i = 1; i < mix.length; i++) {
			const clash = (artists.get(mix[i].track_id) ?? []).some(a => (artists.get(mix[i - 1].track_id) ?? []).includes(a));
			if (clash) expect(mix.slice(i).every(m => artists.get(m.track_id)?.includes('a'))).toBe(true);
		}
	});

	it('handles nothing to go on', () => {
		expect(mix_soundtrack({ rotation: [], recommended: [], artists: new Map(), limit: 10, random: seeded_random('e') })).toEqual([]);
		expect(mix_soundtrack({ rotation: [], recommended: recs(3), artists: new Map(), limit: 10, random: seeded_random('e') }).map(m => m.reason)).toEqual(['for_you', 'for_you', 'for_you']);
	});
});
