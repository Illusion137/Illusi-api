import type { ITunesArtist, ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { describe, expect, it } from 'vitest';
import { is_conclusive_track, pick_track, rank_albums, rank_artists, request_key } from './matching';

const artist = (id: number, name: string): ITunesArtist => ({ wrapperType: 'artist', artistId: id, artistName: name });
const album = (id: number, name: string, extra: Partial<ITunesCollection> = {}): ITunesCollection => ({ wrapperType: 'collection', collectionId: id, collectionName: name, ...extra });
const song = (id: number, name: string, extra: Partial<ITunesTrack> = {}): ITunesTrack => ({ wrapperType: 'track', kind: 'song', trackId: id, trackName: name, ...extra });

describe('request_key', () => {
	it('dedupes on normalized fields', () => {
		expect(request_key({ type: 'track', artist_name: 'Drake', track_name: 'One Dance (feat. Wizkid)' }))
			.toBe(request_key({ type: 'track', artist_name: 'drake', album_name: null, track_name: 'One Dance' }));
		expect(request_key({ type: 'album', artist_name: 'A', album_name: 'X (Deluxe)' })).toBe(request_key({ type: 'album', artist_name: 'a', album_name: 'X' }));
		expect(request_key({ type: 'track', artist_name: 'A', track_name: 'S', duration_ms: 1 })).not.toBe(request_key({ type: 'track', artist_name: 'A', track_name: 'S', duration_ms: 2 }));
	});
});

describe('rank_artists', () => {
	it('keeps only names above the threshold, best first', () => {
		const ranked = rank_artists('The Weeknd', [artist(1, 'The Weeknd Tribute Band'), artist(2, 'The Weeknd'), artist(3, 'The Weekend')], 0.9);
		expect(ranked.map(a => a.artistId)).toEqual([2, 3]);
		expect(rank_artists('Drake', [artist(1, 'Drake Bell')], 0.9)).toEqual([]);
	});
});

describe('rank_albums', () => {
	it('matches collectionName or censored name and prefers explicit, then track count', () => {
		const albums = [
			album(1, 'Views', { collectionExplicitness: 'cleaned', trackCount: 20 }),
			album(2, 'Views', { collectionExplicitness: 'explicit', trackCount: 20 }),
			album(3, 'Scorpion'),
			album(4, 'Clean Name', { collectionCensoredName: 'Views (Deluxe)', collectionExplicitness: 'explicit', trackCount: 25 })
		];
		expect(rank_albums('Views', albums, 0.9, 20).map(a => a.collectionId)).toEqual([2, 4, 1]);
	});
});

describe('pick_track', () => {
	it('requires the threshold', () => {
		expect(pick_track({ track_name: 'Hello' }, [song(1, 'Goodbye')], 0.9)).toBeNull();
	});
	it('breaks ties on duration within ±3 s', () => {
		const tracks = [song(1, 'Intro', { trackTimeMillis: 60_000 }), song(2, 'Intro', { trackTimeMillis: 200_000 })];
		expect(pick_track({ track_name: 'Intro', duration_ms: 201_500 }, tracks, 0.9)?.trackId).toBe(2);
		expect(pick_track({ track_name: 'Intro', duration_ms: 61_000 }, tracks, 0.9)?.trackId).toBe(1);
	});
	it('prefers the explicit version over the cleaned one', () => {
		const tracks = [
			song(1, 'Song', { trackExplicitness: 'cleaned', trackTimeMillis: 100_000 }),
			song(2, 'Song', { trackExplicitness: 'explicit', trackTimeMillis: 100_500 })
		];
		expect(pick_track({ track_name: 'Song', duration_ms: 100_000 }, tracks, 0.9)?.trackId).toBe(2);
	});
	it('prefers the matching album when one is given', () => {
		const tracks = [song(1, 'Song', { collectionName: 'Greatest Hits' }), song(2, 'Song', { collectionName: 'The Album' })];
		expect(pick_track({ track_name: 'Song', album_name: 'The Album - Single' }, tracks, 0.9)?.trackId).toBe(2);
	});
	it('ignores non-song results and strips features', () => {
		const tracks = [{ ...song(1, 'Song'), kind: 'music-video' as const }, song(2, 'Song (feat. X)')];
		expect(pick_track({ track_name: 'Song' }, tracks, 0.9)?.trackId).toBe(2);
	});
});

describe('is_conclusive_track', () => {
	it('needs an exact name, a fitting duration and not a cleaned version', () => {
		expect(is_conclusive_track({ track_name: 'Song', duration_ms: 100_000 }, song(1, 'Song', { trackTimeMillis: 101_000, trackExplicitness: 'explicit' }))).toBe(true);
		expect(is_conclusive_track({ track_name: 'Song', duration_ms: 100_000 }, song(1, 'Song', { trackTimeMillis: 110_000 }))).toBe(false);
		expect(is_conclusive_track({ track_name: 'Song' }, song(1, 'Song', { trackExplicitness: 'cleaned' }))).toBe(false);
		expect(is_conclusive_track({ track_name: 'Songs' }, song(1, 'Song'))).toBe(false);
	});
});
