import { describe, expect, it } from 'vitest';
import type { ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { validate_graph } from '../entities';
import { itunes_release_graph, recent_collections } from './itunes_checks';
import { release_window, scope_graph } from './logic';

const ARTIST = '11111111-1111-4111-8111-111111111111';
const AM = 500;
const now = new Date('2026-11-23T12:00:00Z');
const window = release_window(now, 7);
const collection = (id: number, released: string, extra: Partial<ITunesCollection> = {}): ITunesCollection => ({
	wrapperType: 'collection', collectionId: id, artistId: AM, artistName: 'Lelo', collectionName: `Album ${id}`, trackCount: 2, releaseDate: released, ...extra
});
const song = (id: number, collection_id: number, extra: Partial<ITunesTrack> = {}): ITunesTrack => ({
	wrapperType: 'track', kind: 'song', trackId: id, collectionId: collection_id, artistId: AM, artistName: 'Lelo', trackName: `Song ${id}`, trackNumber: id % 10, trackTimeMillis: 180_000, ...extra
});

describe('recent_collections', () => {
	it('keeps the artist\'s own releases in the window, newest first', () => {
		const picked = recent_collections([
			collection(1, '2026-11-20T08:00:00Z'),
			collection(2, '2026-11-22T08:00:00Z'),
			collection(3, '2026-10-01T08:00:00Z'),
			collection(4, '2026-11-30T08:00:00Z'),
			collection(5, '2026-11-21T08:00:00Z', { artistId: 999 }),
			collection(6, '2026-11-21T08:00:00Z', { collectionId: undefined }),
			collection(7, 'not a date')
		], AM, window);
		expect(picked.map(c => c.collectionId)).toEqual([2, 1]);
	});
});

describe('itunes_release_graph', () => {
	it('credits the target, keeps features and drops non-songs, and survives validation and scoping', () => {
		const raw = itunes_release_graph(ARTIST, AM, [collection(10, '2026-11-22T08:00:00Z', { collectionName: 'Fresh - Single', trackCount: 1, collectionExplicitness: 'explicit' })], new Map([[10, [
			song(11, 10, { trackExplicitness: 'notExplicit' }),
			song(12, 10, { artistId: 600, artistName: 'Feature' }),
			song(13, 10, { kind: 'music-video' })
		]]]));
		expect(raw.albums).toEqual([expect.objectContaining({ ref: 'album:10', name: 'Fresh', album_type: 'SINGLE', artist_ref: ARTIST, explicit: true, service_ids: { applemusic_id: '10' } })]);
		expect((raw.tracks as { ref: string; explicit: boolean | null; source: string }[]).map(t => [t.ref, t.explicit, t.source])).toEqual([['track:11', false, 'Apple Music'], ['track:12', null, 'Apple Music']]);
		expect(raw.artists).toEqual([{ ref: 'artist:600', name: 'Feature', service_ids: { applemusic_id: '600' } }]);
		expect(raw.relations?.tracks_artists).toEqual([{ track_ref: 'track:11', artist_ref: ARTIST }, { track_ref: 'track:12', artist_ref: 'artist:600' }]);

		const validated = validate_graph(raw);
		expect(validated.rejected).toEqual([]);
		const scoped = scope_graph(validated.graph, ARTIST);
		expect(scoped.rejected).toEqual([]);
		expect(scoped.graph.tracks).toHaveLength(2);
		expect(scoped.graph.albums[0].release_date).toEqual(new Date('2026-11-22T08:00:00Z'));
	});
});
