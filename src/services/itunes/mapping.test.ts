import type { ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { describe, expect, it } from 'vitest';
import { derive_artist, derive_collection, map_artist, map_collection, map_explicitness, map_track } from './mapping';

const track: ITunesTrack = {
	wrapperType: 'track', kind: 'song', artistId: 1, collectionId: 2, trackId: 3, artistName: 'Artist', collectionName: 'Album',
	trackName: 'Song', trackCensoredName: 'S**g', artistViewUrl: 'https://music.apple.com/us/artist/1', collectionViewUrl: 'https://c',
	trackViewUrl: 'https://t', previewUrl: 'https://p.m4a', artworkUrl30: 'https://a/30x30bb.jpg', artworkUrl60: 'https://a/60x60bb.jpg',
	artworkUrl100: 'https://a/100x100bb.jpg', collectionPrice: 9.99, trackPrice: 1.29, releaseDate: '2020-01-02T12:00:00Z',
	collectionExplicitness: 'notExplicit', trackExplicitness: 'explicit', discCount: 1, discNumber: 1, trackCount: 12, trackNumber: 4,
	trackTimeMillis: 201_000, country: 'USA', currency: 'USD', primaryGenreName: 'Pop', isStreamable: true
};

describe('mapping', () => {
	it('maps camelCase track fields to snake_case columns', () => {
		expect(map_track(track)).toMatchObject({
			id: 3, artist_id: 1, collection_id: 2, name: 'Song', censored_name: 'S**g', kind: 'song', view_url: 'https://t',
			preview_url: 'https://p.m4a', artwork_url_100: 'https://a/100x100bb.jpg', artwork_url_600: 'https://a/600x600bb.jpg',
			price: 1.29, explicitness: 'explicit', track_time_millis: 201_000, track_number: 4, track_count: 12, is_streamable: true,
			release_date: new Date('2020-01-02T12:00:00Z'), primary_genre_name: 'Pop', primary_genre_id: null
		});
	});
	it('maps collections, with collectionExplicitness → explicitness', () => {
		const c: ITunesCollection = { wrapperType: 'collection', collectionId: 2, artistId: 1, collectionName: 'Album', collectionExplicitness: 'cleaned', trackCount: 12, releaseDate: 'not a date', genres: ['Pop'] };
		expect(map_collection(c)).toMatchObject({ id: 2, artist_id: 1, name: 'Album', explicitness: 'cleaned', track_count: 12, release_date: null, genres: ['Pop'] });
	});
	it('maps artists', () => {
		expect(map_artist({ wrapperType: 'artist', artistId: 1, artistName: 'A', artistLinkUrl: 'https://l', amgArtistId: 5, primaryGenreId: 14 }))
			.toEqual({ id: 1, name: 'A', link_url: 'https://l', artist_type: null, amg_artist_id: 5, primary_genre_name: null, primary_genre_id: 14 });
	});
	it('rejects unknown explicitness values', () => {
		expect(map_explicitness('notExplicit')).toBe('notExplicit');
		expect(map_explicitness('Explicit')).toBeNull();
		expect(map_explicitness(undefined)).toBeNull();
	});
	it('derives parent rows from a song', () => {
		expect(derive_artist(track)).toMatchObject({ id: 1, name: 'Artist', link_url: 'https://music.apple.com/us/artist/1' });
		expect(derive_collection(track)).toMatchObject({ id: 2, artist_id: 1, name: 'Album', explicitness: 'notExplicit', price: 9.99, track_count: 12 });
		expect(derive_artist({ ...track, artistName: undefined })).toBeNull();
	});
});
