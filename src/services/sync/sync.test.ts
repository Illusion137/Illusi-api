import { describe, expect, it } from 'vitest';
import { decode_cursor, encode_cursor, next_cursor } from './cursor';
import { clamp_edited_at, lww_update, lww_wins } from './lww';
import { walk_phases } from './pull';
import { validate_push_rows } from './push';
import { in_ids } from './rows';
import { PgDialect } from 'drizzle-orm/pg-core';
import { tracks_table } from '../../db/schema';

const t1 = '2026-10-25 01:00:00.123456+00';
const t2 = '2026-10-25 02:00:00.5+00';

describe('cursor', () => {
	it('round-trips and rejects garbage', () => {
		const c = { v: 1 as const, since: t1, upper: t2, phase: 3, key: 'abc' };
		expect(decode_cursor(encode_cursor(c))).toEqual(c);
		expect(decode_cursor(encode_cursor({ v: 1, since: null }))).toEqual({ v: 1, since: null });
		expect(decode_cursor('not-a-cursor')).toBeNull();
		expect(decode_cursor(Buffer.from(JSON.stringify({ v: 1, since: 'yesterday' })).toString('base64url'))).toBeNull();
		expect(decode_cursor(Buffer.from(JSON.stringify({ v: 1, since: t1, phase: 2 })).toString('base64url'))).toBeNull();
	});
	it('continues a sweep or starts the next one at its watermark', () => {
		expect(next_cursor(t1, t2, { phase: 2, key: 'k' })).toEqual({ v: 1, since: t1, upper: t2, phase: 2, key: 'k' });
		expect(next_cursor(null, t2, null)).toEqual({ v: 1, since: t2 });
	});
});

describe('lww', () => {
	const now = new Date('2026-10-25T12:00:00Z');
	it('clamps future edits to server time', () => {
		expect(clamp_edited_at(new Date('2030-01-01'), now)).toBe(now);
		const past = new Date('2026-10-25T11:00:00Z');
		expect(clamp_edited_at(past, now)).toBe(past);
	});
	it('applies only strictly newer edits', () => {
		const stored = new Date('2026-10-25T10:00:00Z');
		expect(lww_wins(null, stored)).toBe(true);
		expect(lww_wins(stored, new Date('2026-10-25T10:00:01Z'))).toBe(true);
		expect(lww_wins(stored, stored)).toBe(false);
		expect(lww_wins(stored, new Date('2026-10-25T09:00:00Z'))).toBe(false);
		// A future-dated device can at best tie with server now, so a later real edit still wins.
		const clamped = clamp_edited_at(new Date('2099-01-01'), now);
		expect(lww_wins(clamped, new Date(now.getTime() + 1))).toBe(true);
	});
	it('replaces the whole row: present fields, explicit nulls; omitted fields kept', () => {
		const at = new Date();
		expect(lww_update<{ title: string | null; start_at: number | null; deleted: boolean }>(['title', 'start_at', 'deleted'], { title: null, deleted: true }, at)).toEqual({ title: null, deleted: true, edited_at: at });
	});
});

describe('walk_phases', () => {
	const phase = (items: string[], cost = 1) => ({
		cost,
		run: async (after: string | null, limit: number) => {
			const rest = items.filter(i => after == null || i > after).slice(0, limit);
			return { n: rest.length, last: rest.at(-1) ?? null };
		}
	});
	it('pages through phases with keyset positions', async () => {
		const phases = [phase(['a', 'b', 'c']), phase(['x', 'y'], 2)];
		expect(await walk_phases(phases, { phase: 0, key: null }, 2)).toEqual({ phase: 0, key: 'b' });
		expect(await walk_phases(phases, { phase: 0, key: 'b' }, 3)).toEqual({ phase: 1, key: 'x' });
		expect(await walk_phases(phases, { phase: 0, key: 'b' }, 2)).toEqual({ phase: 1, key: null });
		expect(await walk_phases(phases, { phase: 1, key: null }, 4)).toEqual({ phase: 1, key: 'y' });
		expect(await walk_phases(phases, { phase: 1, key: 'x' }, 4)).toBeNull();
	});
	it('runs zero-cost phases once at the start of a sweep', async () => {
		let runs = 0;
		const once = { cost: 0, run: async () => { runs++; return { n: 0, last: null }; } };
		expect(await walk_phases([once, phase(['a'])], { phase: 0, key: null }, 10)).toBeNull();
		expect(runs).toBe(1);
	});
});

describe('validate_push_rows', () => {
	it('rejects malformed rows individually', () => {
		const { rows, rejected, profile } = validate_push_rows({
			user_tracks: [{ track_id: 't', edited_at: '2026-01-01T00:00:00Z', title: 'x' }, { track_id: 't' }],
			track_plays: [{ client_id: 'nope', track_id: 't', created_at: 1 }],
			profile: { username: 'me', edited_at: 0 }
		});
		expect(rows.user_tracks).toHaveLength(1);
		expect(rows.user_tracks[0].row.edited_at).toEqual(new Date('2026-01-01T00:00:00Z'));
		expect(rows.track_plays).toHaveLength(0);
		expect(rejected.map(r => [r.table, r.index])).toEqual([['user_tracks', 1], ['track_plays', 0]]);
		expect(profile?.username).toBe('me');
	});
});

describe('in_ids', () => {
	it('is false for an empty list and an any-match otherwise', () => {
		const dialect = new PgDialect();
		expect(dialect.sqlToQuery(in_ids(tracks_table.id, [])).sql).toBe('false');
		expect(dialect.sqlToQuery(in_ids(tracks_table.id, ['a'])).sql).toContain('in');
	});
});
