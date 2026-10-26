import { describe, expect, it } from 'vitest';
import { LaneScheduler, parse_lane_ratio } from './scheduler';

const run = (s: LaneScheduler, n: number, live = 100, backfill = 100) => Array.from({ length: n }, () => s.next(live, backfill)?.[0]).join('');

describe('parse_lane_ratio', () => {
	it('parses and falls back to 3:1', () => {
		expect(parse_lane_ratio('3:1')).toEqual({ live: 3, backfill: 1 });
		expect(parse_lane_ratio(' 5 : 2 ')).toEqual({ live: 5, backfill: 2 });
		expect(parse_lane_ratio('nonsense')).toEqual({ live: 3, backfill: 1 });
		expect(parse_lane_ratio('0:0')).toEqual({ live: 3, backfill: 1 });
	});
});

describe('LaneScheduler', () => {
	it('interleaves at the ratio', () => {
		expect(run(new LaneScheduler({ live: 3, backfill: 1 }), 8)).toBe('lllblllb');
		expect(run(new LaneScheduler({ live: 2, backfill: 2 }), 8)).toBe('llbbllbb');
	});
	it('gives every turn to the other lane when one is empty', () => {
		const s = new LaneScheduler({ live: 3, backfill: 1 });
		expect(run(s, 3, 0, 5)).toBe('bbb');
		expect(run(s, 3, 5, 0)).toBe('lll');
		expect(s.next(0, 0)).toBeNull();
	});
	it('handles a zero side', () => {
		expect(run(new LaneScheduler({ live: 0, backfill: 1 }), 3)).toBe('bbb');
		expect(run(new LaneScheduler({ live: 1, backfill: 0 }), 3)).toBe('lll');
	});
});
