import { describe, expect, it } from 'vitest';
import type { Graph } from '../entities';
import type { Batch } from '../soundcloud';
import { group_album_rows, is_check_due, parse_services, pick_checks, release_window, scope_graph, scope_soundcloud_batch } from './logic';
import type { AlbumRow, CheckCandidate } from './logic';

const ARTIST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-25T12:00:00Z');
const hours = (h: number) => new Date(now.getTime() - h * 3_600_000);
const policy = { recheck_after_ms: 12 * 3_600_000, request_cooldown_ms: 30 * 60_000 };

describe('parse_services', () => {
	it('accepts comma lists and repeats, dedupes, drops unknown', () => {
		expect(parse_services('spotify, SoundCloud,nope')).toEqual(['spotify', 'soundcloud']);
		expect(parse_services(['spotify', 'deezer,spotify'])).toEqual(['spotify', 'deezer']);
		expect(parse_services(undefined)).toEqual([]);
		expect(parse_services('constructor,__proto__')).toEqual([]);
	});
});

describe('release_window', () => {
	it('covers the last N days up to now', () => {
		expect(release_window(now, 7)).toEqual({ since: new Date('2026-10-18T12:00:00Z'), until: now });
	});
});

describe('check scheduling', () => {
	it('is due when never checked, stale, and not just requested', () => {
		expect(is_check_due({ requested_at: null, checked_at: null }, now, policy)).toBe(true);
		expect(is_check_due({ requested_at: null, checked_at: hours(1) }, now, policy)).toBe(false);
		expect(is_check_due({ requested_at: null, checked_at: hours(13) }, now, policy)).toBe(true);
		expect(is_check_due({ requested_at: hours(0.25), checked_at: null }, now, policy)).toBe(false);
		expect(is_check_due({ requested_at: hours(1), checked_at: null }, now, policy)).toBe(true);
	});

	it('takes turns between services, never-checked first', () => {
		const c = (artist_id: string, service: CheckCandidate['service'], checked_at: Date | null): CheckCandidate => ({ artist_id, service, service_artist_id: artist_id, requested_at: null, checked_at });
		const candidates = [
			c('s1', 'spotify', hours(20)), c('s2', 'spotify', null), c('s3', 'spotify', hours(30)), c('s4', 'spotify', hours(1)),
			c('d1', 'deezer', hours(40))
		];
		const picked = pick_checks(candidates, ['spotify', 'deezer'], now, policy, 4).map(p => p.artist_id);
		expect(picked).toEqual(['s2', 'd1', 's3', 's1']);
		expect(pick_checks(candidates, ['soundcloud'], now, policy, 4)).toEqual([]);
	});
});

describe('scope_graph', () => {
	const graph: Graph = {
		artists: [{ ref: 'feat', name: 'Feature' }, { ref: 'stranger', name: 'Stranger' }],
		albums: [
			{ ref: 'mine', name: 'Mine', artist_ref: ARTIST, release_date: null },
			{ ref: 'credited', name: 'Credited', release_date: null },
			{ ref: 'theirs', name: 'Theirs', artist_ref: OTHER, release_date: null }
		],
		tracks: [
			{ ref: 't1', title: 'One', album_ref: 'mine' },
			{ ref: 't2', title: 'Two' },
			{ ref: 't3', title: 'Three', album_ref: 'theirs' }
		],
		relations: {
			tracks_artists: [{ track_ref: 't1', artist_ref: 'feat' }, { track_ref: 't3', artist_ref: 'stranger' }],
			album_tracks: [{ album_ref: 'credited', track_ref: 't2' }, { album_ref: 'theirs', track_ref: 't3' }],
			artist_albums: [{ artist_ref: ARTIST, album_ref: 'credited' }],
			similar_artists: [{ artist_ref: ARTIST, similar_artist_ref: 'stranger' }]
		}
	};

	it('keeps only releases credited to the target and their features', () => {
		const { graph: scoped, rejected } = scope_graph(graph, ARTIST);
		expect(scoped.albums.map(a => a.ref)).toEqual(['mine', 'credited']);
		expect(scoped.tracks.map(t => t.ref)).toEqual(['t1', 't2']);
		expect(scoped.artists.map(a => a.ref)).toEqual(['feat']);
		expect(scoped.relations.tracks_artists).toEqual([{ track_ref: 't1', artist_ref: 'feat' }]);
		expect(scoped.relations.album_tracks).toEqual([{ album_ref: 'credited', track_ref: 't2' }]);
		expect(scoped.relations.similar_artists).toEqual([]);
		expect(rejected.map(r => r.ref ?? r.kind)).toEqual(['stranger', 'theirs', 't3', 'similar_artists']);
	});
});

describe('scope_soundcloud_batch', () => {
	it('keeps the target user and their uploads only', () => {
		const batch = {
			users: new Map([[1, { id: 1 }], [2, { id: 2 }]]),
			tracks: new Map([[10, { row: { id: 10, user_id: 1 } }], [11, { row: { id: 11, user_id: 2 } }]]),
			playlists: new Map([[20, { row: { id: 20, user_id: 2 } }]])
		} as unknown as Batch;
		const { batch: scoped, dropped } = scope_soundcloud_batch(batch, 1);
		expect([...scoped.users.keys()]).toEqual([1]);
		expect([...scoped.tracks.keys()]).toEqual([10]);
		expect(scoped.playlists.size).toBe(0);
		expect(dropped).toBe(3);
	});
});

describe('group_album_rows', () => {
	it('folds artists and thumbnails per album, keeping order', () => {
		const base = { name: 'A', album_type: 'SINGLE', release_date: '2026-10-24T00:00:00Z', track_count: 1, explicit: false };
		const rows: AlbumRow[] = [
			{ ...base, id: 'a', artist_id: 'x', artist_name: 'X', thumbnail_url: 'u1', thumbnail_width: 600, thumbnail_height: 600 },
			{ ...base, id: 'a', artist_id: 'x', artist_name: 'X', thumbnail_url: 'u2', thumbnail_width: 100, thumbnail_height: 100 },
			{ ...base, id: 'a', artist_id: 'y', artist_name: 'Y', thumbnail_url: 'u1', thumbnail_width: 600, thumbnail_height: 600 },
			{ ...base, id: 'b', artist_id: null, artist_name: null, thumbnail_url: null, thumbnail_width: null, thumbnail_height: null }
		];
		const out = group_album_rows(rows);
		expect(out.map(r => r.id)).toEqual(['a', 'b']);
		expect(out[0].artists).toEqual([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]);
		expect(out[0].thumbnails.map(t => t.url)).toEqual(['u1', 'u2']);
		expect(out[0].release_date).toBe('2026-10-24T00:00:00.000Z');
		expect(out[1]).toMatchObject({ artists: [], thumbnails: [] });
	});
});
