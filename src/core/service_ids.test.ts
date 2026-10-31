import { describe, expect, it } from 'vitest';
import {
	normalize_applemusic_id, normalize_isrc, normalize_service_id, normalize_service_ids, normalize_soundcloud_permalink,
	normalize_spotify_id, normalize_youtube_id, NUMERIC_SERVICE_ID_COLUMNS, SERVICE_ID_COLUMNS, UNIQUE_SERVICE_ID_COLUMNS
} from './service_ids';

describe('constants', () => {
	it('treat isrc as the only non-unique column', () => {
		expect(UNIQUE_SERVICE_ID_COLUMNS).toHaveLength(SERVICE_ID_COLUMNS.length - 1);
		expect(UNIQUE_SERVICE_ID_COLUMNS).not.toContain('isrc');
		expect(NUMERIC_SERVICE_ID_COLUMNS).toEqual(['soundcloud_id', 'genius_id']);
	});
});

describe('normalize_youtube_id', () => {
	it.each([
		['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['  dQw4w9WgXcQ ', 'dQw4w9WgXcQ'],
		['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'dQw4w9WgXcQ'],
		['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['youtu.be/dQw4w9WgXcQ?si=x', 'dQw4w9WgXcQ'],
		['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://www.youtube-nocookie.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://youtube.com/watch', null],
		['https://youtube.com/watch?v=short', null],
		['https://vimeo.com/dQw4w9WgXcQ', null],
		['http://[bad', null]
	])('%s', (input, expected) => {
		expect(normalize_youtube_id(input)).toBe(expected);
	});
});

describe('normalize_soundcloud_permalink', () => {
	it.each([
		['artist/Track', 'artist/track'],
		['/artist/track/', 'artist/track'],
		['https://soundcloud.com/Artist/Track?si=1#t', 'artist/track'],
		['m.soundcloud.com/artist/track', 'artist/track'],
		['https://evil.com/artist/track', null],
		['https://notsoundcloud.com/a/b', null],
		['artist', null],
		['artist//track', null],
		['   ', null],
		['http://[bad', null]
	])('%s', (input, expected) => {
		expect(normalize_soundcloud_permalink(input)).toBe(expected);
	});
});

describe('normalize_applemusic_id', () => {
	it.each([
		[123, '123'],
		[' 456 ', '456'],
		['https://music.apple.com/us/album/name/123?i=456', '456'],
		['https://music.apple.com/us/album/name/123', '123'],
		['https://music.apple.com/us/artist/x/id789/', '789'],
		['https://music.apple.com/us/album/name/123?i=abc', '123'],
		['https://music.apple.com/us/album/name', null],
		['not a url', null]
	])('%s', (input, expected) => {
		expect(normalize_applemusic_id(input)).toBe(expected);
	});
});

describe('normalize_spotify_id', () => {
	it.each([
		['4uLU6hMCjMI75M1A2tKUQC', '4uLU6hMCjMI75M1A2tKUQC'],
		['spotify:track:4uLU6hMCjMI75M1A2tKUQC', '4uLU6hMCjMI75M1A2tKUQC'],
		['https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=1', '4uLU6hMCjMI75M1A2tKUQC'],
		['https://open.spotify.com/playlist/4uLU6hMCjMI75M1A2tKUQC', null],
		['short', null]
	])('%s', (input, expected) => {
		expect(normalize_spotify_id(input)).toBe(expected);
	});
});

describe('normalize_isrc', () => {
	it.each([
		['US-RC1-76-07839', 'USRC17607839'],
		['usrc17607839', 'USRC17607839'],
		['US RC1 7607839', 'USRC17607839'],
		['USRC1760783', null],
		['1SRC17607839', null]
	])('%s', (input, expected) => {
		expect(normalize_isrc(input)).toBe(expected);
	});
});

describe('normalize_service_id', () => {
	it('parses numeric columns as positive safe integers', () => {
		expect(normalize_service_id('soundcloud_id', ' 12 ')).toBe(12);
		expect(normalize_service_id('genius_id', 7)).toBe(7);
		expect(normalize_service_id('genius_id', 0)).toBeNull();
		expect(normalize_service_id('genius_id', -1)).toBeNull();
		expect(normalize_service_id('genius_id', 1.5)).toBeNull();
		expect(normalize_service_id('genius_id', 'abc')).toBeNull();
		expect(normalize_service_id('genius_id', '9007199254740993')).toBeNull();
	});

	it('trims plain string columns and rejects blanks', () => {
		expect(normalize_service_id('deezer_id', ' 55 ')).toBe('55');
		expect(normalize_service_id('tidal_id', 99)).toBe('99');
		expect(normalize_service_id('pandora_id', '  ')).toBeNull();
	});

	it('dispatches to the specific normalizers', () => {
		expect(normalize_service_id('isrc', 'us-rc1-76-07839')).toBe('USRC17607839');
		expect(normalize_service_id('youtube_id', 'bad')).toBeNull();
	});
});

describe('normalize_service_ids', () => {
	it('keeps valid values, skips empty ones and reports the rejected', () => {
		expect(normalize_service_ids({ youtube_id: 'dQw4w9WgXcQ', spotify_id: 'nope', deezer_id: '', tidal_id: null, genius_id: '5', isrc: undefined })).toEqual({
			ids: { youtube_id: 'dQw4w9WgXcQ', genius_id: 5 },
			rejected: [{ column: 'spotify_id', value: 'nope' }]
		});
	});
});
