import { describe, expect, it } from 'vitest';
import type { Graph } from '../entities';
import { flatten_items, unwrap_items } from '../soundcloud';
import type { Batch } from '../soundcloud';
import {
	dedupe_feed_albums, feed_ids, group_album_rows, is_check_due, parse_services, pick_checks, release_window, scope_graph, scope_soundcloud_batch,
	soundcloud_feed_rows, youtube_music_feed_rows
} from './logic';
import type { AlbumRow, CheckCandidate, FeedAlbum } from './logic';

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

describe('feed rows', () => {
	const window = release_window(now, 7);
	const uploader = { kind: 'user', id: 5, permalink: 'up', username: 'Up', avatar_url: 'https://i1.sndcdn.com/avatar.jpg' };
	const track = (id: number, created_at: string, extra: object = {}) => ({ kind: 'track', id, title: `T${id}`, user: uploader, created_at, permalink_url: `https://soundcloud.com/up/t${id}`, ...extra });
	const stream = [
		{ type: 'track', created_at: '2026-10-24T00:00:00Z', track: track(1, '2026-10-24T00:00:00Z') },
		// A repost of something old
		{ type: 'track-repost', created_at: '2026-10-24T00:00:00Z', track: track(2, '2025-01-01T00:00:00Z') },
		{ type: 'track', created_at: '2026-10-24T00:00:00Z', track: track(3, '2026-10-24T00:00:00Z', { sharing: 'private' }) },
		{
			type: 'playlist', created_at: '2026-10-23T00:00:00Z',
			playlist: { kind: 'playlist', id: 9, title: 'EP', set_type: 'ep', user: uploader, created_at: '2026-10-23T00:00:00Z', permalink_url: 'https://soundcloud.com/up/sets/ep', tracks: [track(4, '2026-10-23T00:00:00Z')] }
		}
	];

	it('keeps the stream\'s own public releases from the window, not reposts of old ones or a playlist\'s tracks', () => {
		const items = unwrap_items(stream);
		const rows = soundcloud_feed_rows('u', flatten_items(items).batch, feed_ids(items), window);
		expect(rows.map(r => [r.kind, r.external_id])).toEqual([['track', '1'], ['album', '9']]);
		expect(rows[1]).toMatchObject({ album_type: 'EP', name: 'EP', url: 'https://soundcloud.com/up/sets/ep', artists: [{ name: 'Up', id: 'up' }], artwork_url: uploader.avatar_url });
	});

	it('takes YouTube Music albums undated, once each', () => {
		const rows = youtube_music_feed_rows('u', [
			{ id: 'MPREb_1', name: 'A', album_type: 'single', artists: [{ name: 'X', id: 'UC1' }, { name: 'Y' }] },
			{ id: 'MPREb_1', name: 'A again', artists: [] }
		]);
		expect(rows).toEqual([{
			user_id: 'u', service: 'youtube_music', external_id: 'MPREb_1', kind: 'album', name: 'A', album_type: 'SINGLE',
			artists: [{ name: 'X', id: 'UC1' }, { name: 'Y', id: null }], artwork_url: null, url: null, explicit: null, released_at: null
		}]);
	});

	it('drops feed albums the catalog already has, and repeats', () => {
		const album = (name: string, artist: string, service = 'youtube_music'): FeedAlbum => ({
			service, id: name + service, name, album_type: 'ALBUM', explicit: null, artwork_url: null, url: null, artists: [{ name: artist, id: null }], release_date: now.toISOString()
		});
		const feed = [album('Known (Deluxe Edition)', 'Beyoncé'), album('New', 'X'), album('New', 'X', 'soundcloud'), album('New', 'Y')];
		const out = dedupe_feed_albums(feed, [{ name: 'Known', artists: [{ id: 'a', name: 'Beyonce' }] }]);
		expect(out.map(a => [a.name, a.service, a.artists[0].name])).toEqual([['New', 'youtube_music', 'X'], ['New', 'youtube_music', 'Y']]);
	});
});
