import { describe, expect, it } from 'vitest';
import { validate_graph } from './payload';

const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('validate_graph', () => {
	it('rejects a malformed entity with the relations that reference it, keeps the rest', () => {
		const { graph, rejected } = validate_graph({
			artists: [{ ref: 'a1', name: 'Artist' }, { ref: 'a2' }],
			tracks: [{ ref: 't1', title: 'Song', duration_ms: 1000 }],
			relations: {
				tracks_artists: [{ track_ref: 't1', artist_ref: 'a1' }, { track_ref: 't1', artist_ref: 'a2' }],
				similar_artists: [{ artist_ref: 'a1', similar_artist_ref: 'a2' }]
			}
		});
		expect(graph.artists.map(a => a.ref)).toEqual(['a1']);
		expect(graph.tracks).toHaveLength(1);
		expect(graph.relations.tracks_artists).toEqual([{ track_ref: 't1', artist_ref: 'a1' }]);
		expect(graph.relations.similar_artists).toEqual([]);
		expect(rejected.map(r => [r.kind, r.reason.split(' ').slice(-3).join(' ')])).toEqual([
			['artist', 'malformed'],
			['tracks_artists', 'a rejected entity'],
			['similar_artists', 'a rejected entity']
		]);
	});

	it('drops reference fields to rejected or unknown refs but applies the entity', () => {
		const { graph, rejected } = validate_graph({
			artists: [{ ref: 'bad', name: '' }],
			albums: [{ ref: 'al', name: 'Album', artist_ref: 'bad' }],
			tracks: [{ ref: 't', title: 'T', album_ref: 'nope' }, { ref: 't2', title: 'T2', album_ref: uuid }]
		});
		expect(graph.albums[0].artist_ref).toBeUndefined();
		expect(graph.tracks[0].album_ref).toBeUndefined();
		expect(graph.tracks[1].album_ref).toBe(uuid);
		expect(rejected.filter(r => r.field).map(r => [r.ref, r.field])).toEqual([['al', 'artist_ref'], ['t', 'album_ref']]);
	});

	it('rejects duplicate refs, wrong-type refs, self similarity and dedupes relations', () => {
		const { graph, rejected } = validate_graph({
			artists: [{ ref: 'x', name: 'A' }, { ref: 'x', name: 'B' }],
			albums: [{ ref: 'al', name: 'Album' }],
			relations: {
				artist_albums: [{ artist_ref: 'x', album_ref: 'al' }, { artist_ref: 'x', album_ref: 'al' }, { artist_ref: 'al', album_ref: 'x' }],
				similar_artists: [{ artist_ref: 'x', similar_artist_ref: 'x' }, { artist_ref: 'x', similar_artist_ref: uuid }]
			}
		});
		expect(graph.artists).toHaveLength(1);
		expect(graph.relations.artist_albums).toHaveLength(1);
		expect(graph.relations.similar_artists).toEqual([{ artist_ref: 'x', similar_artist_ref: uuid }]);
		expect(rejected.map(r => r.reason)).toEqual([
			'duplicate ref',
			'artist_ref references a album, expected artist',
			'artist cannot be similar to itself'
		]);
	});

	it('cleans thumbnail sizes and parses dates', () => {
		const { graph, rejected } = validate_graph({
			albums: [{ ref: 'a', name: 'A', release_date: '2020-01-02', thumbnails: [{ url: 'https://x/1.jpg', width: -1, height: 'x' }] }, { ref: 'b', name: 'B', release_date: 'not a date' }]
		});
		expect(graph.albums[0].release_date).toEqual(new Date('2020-01-02'));
		expect(graph.albums[0].thumbnails?.[0]).toEqual({ url: 'https://x/1.jpg', width: null, height: null });
		expect(rejected[0]).toMatchObject({ kind: 'album', ref: 'b', reason: 'malformed' });
	});
});

describe('validate_graph relations', () => {
	it('rejects a malformed relation entry and keeps the others', () => {
		const { rejected } = validate_graph({ relations: { tracks_artists: [{ track_ref: 1 }], album_tracks: [], artist_albums: [], similar_artists: [] } });
		expect(rejected).toEqual([expect.objectContaining({ kind: 'tracks_artists', index: 0, reason: 'malformed' })]);
	});
});
