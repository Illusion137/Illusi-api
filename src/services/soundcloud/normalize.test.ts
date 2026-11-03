import { describe, expect, it } from 'vitest';
import { is_transcoding_stale } from './ingest';
import { changed_fields, decide_membership, flatten_items, is_stale, map_track, map_user, merge_rows, unwrap_items } from './normalize';

const user = (id: number, extra: Record<string, unknown> = {}) => ({ kind: 'user', id, permalink: `user-${id}`, username: `User ${id}`, ...extra });
const track = (id: number, extra: Record<string, unknown> = {}) => ({ kind: 'track', id, title: `Track ${id}`, user_id: 1, user: user(1), ...extra });
const stub = (id: number) => ({ id, kind: 'track', monetization_model: 'NOT_APPLICABLE', policy: 'ALLOW' });

describe('unwrap_items', () => {
	it('expands collections and unwraps like/history wrappers', () => {
		const items = unwrap_items([
			{ collection: [track(1), { kind: 'like', created_at: 'x', track: track(2) }] },
			[{ played_at: 1, track_id: 3, track: track(3) }],
			{ kind: 'like', playlist: { kind: 'playlist', id: 9, title: 'P' } },
			user(4)
		]);
		expect(items.map(i => (i as { id: number }).id)).toEqual([1, 2, 3, 9, 4]);
	});
});

describe('flatten_items', () => {
	it('pulls nested users and full playlist tracks out; stubs only give membership', () => {
		const { batch, accepted, rejected } = flatten_items([
			{
				kind: 'playlist', id: 100, title: 'P', track_count: 3,
				user: [user(5), { kind: 'user', id: 'bad' }],
				tracks: [track(10, { user: user(6), user_id: 6 }), stub(11), stub(12)]
			}
		]);
		expect([accepted, rejected]).toEqual([1, 0]);
		expect([...batch.users.keys()].sort()).toEqual([5, 6]);
		expect([...batch.tracks.keys()]).toEqual([10]);
		expect(batch.playlists.get(100)?.members).toEqual([10, 11, 12]);
		expect(batch.playlists.get(100)?.row.user_id).toBe(5);
	});

	it('rejects malformed items and unknown kinds individually', () => {
		const { batch, accepted, rejected } = flatten_items([track(1), { kind: 'station', id: 2 }, { kind: 'track', id: 3 }, 'junk', user(4, { permalink: '' }), user(5)]);
		expect([accepted, rejected]).toEqual([2, 4]);
		expect([...batch.tracks.keys()]).toEqual([1]);
		expect([...batch.users.keys()].sort()).toEqual([1, 5]);
	});

	it('dedupes the same id, preferring the newer object and filling gaps from the older', () => {
		const { batch } = flatten_items([
			track(1, { last_modified: '2024-01-01T00:00:00Z', genre: 'Old', description: 'desc', playback_count: 10 }),
			track(1, { last_modified: '2024-06-01T00:00:00Z', genre: 'New', playback_count: 20 }),
			track(1, { last_modified: '2023-01-01T00:00:00Z', genre: 'Oldest', playback_count: 5 })
		]);
		const row = batch.tracks.get(1)?.row;
		expect(row?.genre).toBe('New');
		expect(row?.description).toBe('desc');
		expect(row?.playback_count).toBe(20);
		expect(batch.tracks.size).toBe(1);
	});

	it('keeps one user per permalink (newest)', () => {
		const { batch } = flatten_items([
			user(1, { permalink: 'same', last_modified: '2024-01-01T00:00:00Z' }),
			user(2, { permalink: 'same', last_modified: '2025-01-01T00:00:00Z' })
		]);
		expect([...batch.users.keys()]).toEqual([2]);
	});

	it('prefers a complete membership list when merging playlists', () => {
		const { batch } = flatten_items([
			{ kind: 'playlist', id: 1, title: 'P', track_count: 2, tracks: [stub(1), stub(2)] },
			{ kind: 'playlist', id: 1, title: 'P', track_count: 2, tracks: [stub(1)] }
		]);
		expect(batch.playlists.get(1)?.members).toEqual([1, 2]);
	});
});

describe('field mapping', () => {
	it('maps users: dates, badges', () => {
		const row = map_user(user(1, {
			created_at: '2020-01-02T03:04:05Z', last_modified: '2021-01-01T00:00:00Z',
			badges: { pro: true, creator_mid_tier: false, pro_unlimited: true, verified: true }, followers_count: 12, city: ''
		}));
		expect(row).toMatchObject({
			soundcloud_created_at: new Date('2020-01-02T03:04:05Z'), soundcloud_last_modified: new Date('2021-01-01T00:00:00Z'),
			badge_pro: true, badge_creator_mid_tier: false, badge_pro_unlimited: true, verified: true, followers_count: 12, city: null
		});
	});

	it('maps tracks: publisher_metadata, transcodings, truncation', () => {
		const entry = map_track(track(7, {
			genre: 'x'.repeat(200),
			permalink_url: 'https://soundcloud.com/a/b',
			publisher_metadata: { artist: 'Artist', album_title: 'Album', release_title: 'Rel', isrc: 'USABC1234567', upc_or_ean: '123', explicit: true, contains_music: true, p_line: 'P', c_line: 'C' },
			media: { transcodings: [
				{ url: 'https://api/t/1', preset: 'mp3_0_0', duration: 1000, snipped: false, format: { protocol: 'progressive', mime_type: 'audio/mpeg' }, quality: 'sq' },
				{ url: 'https://api/t/1', preset: 'dup' },
				{ preset: 'no url' }
			] }
		}));
		expect(entry?.row).toMatchObject({
			publisher_artist: 'Artist', album_title: 'Album', release_title: 'Rel', isrc: 'USABC1234567', upc_or_ean: '123',
			explicit: true, contains_music: true, p_line: 'P', c_line: 'C', user_id: 1
		});
		expect(entry?.row.genre).toHaveLength(128);
		expect(entry?.permalink_url).toBe('https://soundcloud.com/a/b');
		expect(entry?.transcodings).toEqual([{ track_id: 7, url: 'https://api/t/1', preset: 'dup', protocol: null, mime_type: null, quality: null, duration: null, snipped: null }]);
		expect(map_track(track(8))?.transcodings).toBeNull();
		expect(map_track(track(8, { media: { transcodings: [] } }))?.transcodings).toEqual([]);
	});
});

describe('merge_rows', () => {
	it('falls back to the fuller row when neither has last_modified', () => {
		const [row] = merge_rows<{ a: number | null; b: number | null; soundcloud_last_modified?: Date | null }>({ a: 1, b: 2 }, { a: 3, b: null });
		expect(row).toEqual({ a: 1, b: 2 });
	});
});

describe('decide_membership', () => {
	const known = new Set([1, 2, 3]);
	it('replaces when complete, with array positions and unknown stubs skipped', () => {
		expect(decide_membership([1, 4, 2], 3, known)).toEqual({ mode: 'replace', rows: [{ track_id: 1, position: 0 }, { track_id: 2, position: 2 }] });
	});
	it('only adds when partial', () => {
		expect(decide_membership([3], 10, known)).toEqual({ mode: 'add', rows: [{ track_id: 3, position: 0 }] });
		expect(decide_membership([4], 10, known)).toEqual({ mode: 'none' });
	});
	it('handles missing tracks and empty complete lists', () => {
		expect(decide_membership(null, 3, known)).toEqual({ mode: 'none' });
		expect(decide_membership([], 0, known)).toEqual({ mode: 'replace', rows: [] });
	});
	it('keeps the first position of duplicates', () => {
		expect(decide_membership([2, 2], 2, known)).toEqual({ mode: 'replace', rows: [{ track_id: 2, position: 0 }] });
	});
});

describe('stale rules', () => {
	const older = new Date('2024-01-01');
	const newer = new Date('2024-06-01');
	it('is_stale only when both are known and incoming is older', () => {
		expect(is_stale(older, newer)).toBe(true);
		expect(is_stale(newer, older)).toBe(false);
		expect(is_stale(newer, newer)).toBe(false);
		expect(is_stale(null, newer)).toBe(false);
		expect(is_stale(older, null)).toBe(false);
	});
	it('changed_fields mirrors coalesce + stale', () => {
		const existing = { id: 1, genre: 'A', likes_count: 1, title: 'T', soundcloud_last_modified: newer };
		expect(changed_fields(undefined, { id: 1 }, [])).toEqual(['*']);
		expect(changed_fields(existing, { id: 1, genre: 'B', likes_count: 2, title: null, soundcloud_last_modified: older }, ['likes_count'])).toEqual(['likes_count']);
		expect(changed_fields(existing, { id: 1, genre: 'B', likes_count: 1, title: null, soundcloud_last_modified: newer }, ['likes_count'])).toEqual(['genre']);
	});
	it('is_transcoding_stale uses SC_TRANSCODING_STALE_AFTER_HOURS', () => {
		const now = Date.parse('2026-01-02T00:00:00Z');
		expect(is_transcoding_stale(null, now)).toBe(true);
		expect(is_transcoding_stale(new Date(now - 3_600_000), now)).toBe(false);
		expect(is_transcoding_stale(new Date(now - 25 * 3_600_000), now)).toBe(true);
	});
});

describe('nesting and merging gaps', () => {
	it('stops unwrapping past the depth limit and keeps the remainder as an item', () => {
		const deep = [[[[[{ kind: 'track', id: 1 }]]]]];
		expect(unwrap_items(deep).length).toBe(1);
		const wrapped = { collection: { collection: [] } };
		const nested = { collection: [{ collection: [{ collection: [{ collection: [{ kind: 'track', id: 1 }] }] }] }] };
		expect(unwrap_items([nested, wrapped]).length).toBeGreaterThan(0);
	});
	it('keeps the longer member list when neither playlist is complete', () => {
		const stub = (id: number) => ({ kind: 'track', id });
		const pl = (tracks: unknown[]) => ({ kind: 'playlist', id: 1, title: 'P', track_count: 5, tracks });
		expect(flatten_items([pl([stub(1)]), pl([stub(1), stub(2)])]).batch.playlists.get(1)?.members).toEqual([1, 2]);
		expect(flatten_items([pl([stub(1), stub(2)]), pl([stub(1)])]).batch.playlists.get(1)?.members).toEqual([1, 2]);
	});
});
