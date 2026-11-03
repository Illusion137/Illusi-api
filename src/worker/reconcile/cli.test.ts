import { describe, expect, it } from 'vitest';
import { full_pass_due, local_day, parse_args } from './cli';
import { simple_pairs } from './run';
import { conflict } from './test_fixtures';

describe('parse_args', () => {
	it('defaults to the scheduler with the configured dry-run flag', () => {
		expect(parse_args([], false)).toEqual({ initial: null, dry_run: false, once: false });
		expect(parse_args([], true).dry_run).toBe(true);
	});
	it('parses modes and flags', () => {
		expect(parse_args(['--full', '--dry-run'], false)).toEqual({ initial: 'full', dry_run: true, once: false });
		expect(parse_args(['--once'], false)).toEqual({ initial: 'incremental', dry_run: false, once: true });
		expect(parse_args(['--once', '--full'], false).initial).toBe('full');
	});
	it('parses the incremental flag', () => {
		expect(parse_args(['--incremental'], false).initial).toBe('incremental');
	});
	it('rejects unknown arguments', () => {
		expect(() => parse_args(['--nope'], false)).toThrow(/unknown argument/u);
	});
});

describe('full_pass_due', () => {
	it('runs once per day after the configured hour', () => {
		const early = new Date(2026, 0, 2, 2, 0);
		const late = new Date(2026, 0, 2, 3, 30);
		expect(full_pass_due(early, null, 3)).toBe(false);
		expect(full_pass_due(late, null, 3)).toBe(true);
		expect(full_pass_due(late, local_day(late), 3)).toBe(false);
		expect(full_pass_due(late, local_day(new Date(2026, 0, 1, 3)), 3)).toBe(true);
	});
});

describe('simple_pairs', () => {
	it('keeps pairs whose ids are linked to nobody else', () => {
		const ab = conflict('a', 'applemusic_id', '1', { other_illusi_id: 'b' });
		const ba = conflict('b', 'genius_id', '2', { other_illusi_id: 'a' });
		const cd = conflict('c', 'applemusic_id', '3', { other_illusi_id: 'd' });
		const de = conflict('d', 'soundcloud_id', '4', { other_illusi_id: 'e', status: 'deferred' });
		const single = conflict('f', 'isrc', 'X');
		expect(simple_pairs([ab, ba, cd, single], [ab, ba, cd, de, single])).toEqual([['a', 'b']]);
	});
});
