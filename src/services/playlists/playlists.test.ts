import { describe, expect, it } from 'vitest';
import { resolve_playlist_tracks, sort_playlist_tracks, track_query_filter } from '@illusive/playlist_resolution';
import type { Track } from '@illusive/types';
import { can_copy } from './copy';
import { to_inheritance_mode, to_sort_type } from './enums';
import { creates_cycle, edges_from } from './inheritance';
import { reachable_playlists } from './resolve';
import type { PlaylistShape } from './resolve';
import { row_to_track } from './track_adapter';
import type { TrackRow } from './track_adapter';
import { inheritance_mode, sort_type } from '../../db/schema';

function row(overrides: Partial<TrackRow> = {}): TrackRow {
	return {
		track_id: 't1',
		title: 'Global Title',
		duration_ms: 180_000,
		explicit: null,
		imported: false,
		album: null,
		artists: [{ id: 'a1', name: 'Artist One' }],
		producers: [],
		service_ids: {},
		sample: null,
		user_title: null,
		added_at: null,
		downloaded_at: null,
		start_at: null,
		end_at: null,
		plays: 0,
		last_played_at: null,
		...overrides
	};
}

describe('row_to_track', () => {
	it('maps the core fields', () => {
		const track = row_to_track(row({
			album: { id: 'al', name: 'Album' },
			explicit: true,
			service_ids: { youtube_id: 'dQw4w9WgXcQ', soundcloud_id: 42, spotify_id: null },
			producers: ['Metro', 'Wheezy'],
			imported: true
		}));
		expect(track.uid).toBe('t1');
		expect(track.illusi_id).toBe('t1');
		expect(track.duration).toBe(180);
		expect(track.explicit).toBe('EXPLICIT');
		expect(track.album).toEqual({ name: 'Album', uuid: 'al' });
		expect(track.artists).toEqual([{ name: 'Artist One', uuid: 'a1' }]);
		expect(track.youtube_id).toBe('dQw4w9WgXcQ');
		expect(track.soundcloud_id).toBe(42);
		expect(track.spotify_id).toBeUndefined();
		expect(track.prods).toBe('Metro, Wheezy');
		expect(track.imported_id).toBe('t1');
	});
	it('applies the user-specific fields', () => {
		const added = new Date('2024-01-01T00:00:00Z');
		const downloaded = new Date('2024-02-01T00:00:00Z');
		const played = new Date('2024-03-01T00:00:00Z');
		const track = row_to_track(row({ user_title: 'My Title', added_at: added, downloaded_at: downloaded, plays: 7, last_played_at: played, start_at: 5 }));
		expect(track.title).toBe('My Title');
		expect(track.media_uri).toBeDefined();
		expect(track.meta).toMatchObject({ plays: 7, added_date: added.toISOString(), downloaded_date: downloaded.toISOString(), last_played_date: played.toISOString(), begdur: 5 });
	});
	it('defaults dates the way the client does', () => {
		const track = row_to_track(row());
		expect(track.meta?.added_date).toBe(new Date(0).toISOString());
		expect(track.meta?.downloaded_date).toBeUndefined();
		expect(track.media_uri).toBeUndefined();
		expect(track.explicit).toBe('NONE');
	});
	it('works with lib-origin query flags and sorts', () => {
		const tracks: Track[] = [
			row_to_track(row({ track_id: 'a', title: 'Zeta', explicit: true, plays: 1, duration_ms: 100_000 })),
			row_to_track(row({ track_id: 'b', title: 'Alpha', downloaded_at: new Date(), plays: 9, duration_ms: 300_000, service_ids: { youtube_id: 'x' } })),
			row_to_track(row({ track_id: 'c', title: 'Mid', user_title: 'Beta', artists: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] }))
		];
		const uids = (list: Track[]) => list.map(t => t.uid);
		expect(uids(track_query_filter(tracks, '@ex'))).toEqual(['a']);
		expect(uids(track_query_filter(tracks, '@dl'))).toEqual(['b']);
		expect(uids(track_query_filter(tracks, '@yt'))).toEqual(['b']);
		expect(uids(track_query_filter(tracks, '@ma'))).toEqual(['c']);
		expect(uids(track_query_filter(tracks, '@drg 200'))).toEqual(['b']);
		expect(uids(track_query_filter(tracks, '@plg 5'))).toEqual(['b']);
		expect(uids(track_query_filter(tracks, '@tteq beta'))).toEqual(['c']);
		expect(uids(sort_playlist_tracks('ALPHABETICAL', tracks.slice()))).toEqual(['b', 'c', 'a']);
		expect(uids(sort_playlist_tracks('PLAYS_HILOW', tracks.slice()))).toEqual(['b', 'a', 'c']);
		expect(uids(sort_playlist_tracks('DURATION_LOWHI', tracks.slice()))).toEqual(['a', 'c', 'b']);
	});
});

describe('enum mapping', () => {
	it('maps every DB sort type and inheritance mode', () => {
		for (const value of sort_type.enumValues) expect(to_sort_type(value)).toBe(value);
		for (const value of inheritance_mode.enumValues) expect(to_inheritance_mode(value)).toBe(value);
		expect(to_inheritance_mode(null)).toBeUndefined();
	});
});

describe('creates_cycle', () => {
	const edges = edges_from([
		{ playlist_id: 'A', ref_id: 'B' },
		{ playlist_id: 'B', ref_id: 'C' },
		{ playlist_id: 'D', ref_id: 'C' }
	]);
	it('rejects self and indirect cycles', () => {
		expect(creates_cycle(edges, 'A', 'A')).toBe(true);
		expect(creates_cycle(edges, 'B', 'A')).toBe(true);
		expect(creates_cycle(edges, 'C', 'A')).toBe(true);
	});
	it('allows DAG edges', () => {
		expect(creates_cycle(edges, 'A', 'C')).toBe(false);
		expect(creates_cycle(edges, 'A', 'D')).toBe(false);
		expect(creates_cycle(edges, 'C', 'E')).toBe(false);
	});
	it('terminates on an already-cyclic graph', () => {
		const cyclic = edges_from([{ playlist_id: 'X', ref_id: 'Y' }, { playlist_id: 'Y', ref_id: 'X' }]);
		expect(creates_cycle(cyclic, 'Z', 'X')).toBe(false);
	});
});

describe('reachable_playlists', () => {
	const shape = (inherits: string[], searches: string[] = []): PlaylistShape => ({
		track_ids: [],
		inherited_playlists: inherits.map(uuid => ({ uuid, mode: 'INCLUDE' })),
		inherited_searchs: searches.map(query => ({ query, mode: 'INCLUDE' })),
		sort: 'OLDEST'
	});
	it('follows inheritance, ignores unknown playlists and notes searches', () => {
		const shapes = new Map([['A', shape(['B', 'foreign'])], ['B', shape(['A'], ['@ex'])], ['C', shape([])]]);
		const { ids, needs_library } = reachable_playlists('A', shapes);
		expect([...ids].sort()).toEqual(['A', 'B']);
		expect(needs_library).toBe(true);
		expect(reachable_playlists('C', shapes).needs_library).toBe(false);
	});
});

describe('lib-origin resolution over adapted tracks', () => {
	it('combines inheritance modes and searches like the client', async () => {
		const t = (id: string, title: string, explicit = false) => row_to_track(row({ track_id: id, title, explicit }));
		const library = [t('1', 'One', true), t('2', 'Two'), t('3', 'Three', true), t('4', 'Four')];
		const result = await resolve_playlist_tracks('root', {
			get_playlist: uuid => uuid === 'root'
				? { tracks: [library[0], library[1]], inherited_playlists: [{ uuid: 'child', mode: 'EXCLUDE' }], inherited_searchs: [{ query: '@ex', mode: 'INCLUDE' }], sort: 'ALPHABETICAL' }
				: { tracks: [library[1]], inherited_playlists: [{ uuid: 'root', mode: 'INCLUDE' }], sort: 'OLDEST' },
			library_tracks: library
		});
		expect(result.map(x => x.uid)).toEqual(['1', '3']);
	});
});

describe('can_copy', () => {
	it('allows public non-deleted playlists and own playlists', () => {
		expect(can_copy({ user_id: 'u2', public: true, deleted: false }, 'u1')).toBe(true);
		expect(can_copy({ user_id: 'u2', public: true, deleted: true }, 'u1')).toBe(false);
		expect(can_copy({ user_id: 'u2', public: false, deleted: false }, 'u1')).toBe(false);
		expect(can_copy({ user_id: 'u1', public: false, deleted: false }, 'u1')).toBe(true);
	});
});
