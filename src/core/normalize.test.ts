import { describe, expect, it } from 'vitest';
import { name_similarity, normalize_name, primary_artist_name } from './normalize';
import { normalize_isrc, normalize_soundcloud_permalink, normalize_youtube_id } from './service_ids';
import { parse_thumbnail_size } from './thumbnails';

describe('normalize_name', () => {
	it('strips features, versions and punctuation', () => {
		expect(normalize_name('Song Name (feat. Someone) [Remastered]')).toBe('song name');
		expect(normalize_name('Album - Single')).toBe('album');
		expect(normalize_name('Album (Deluxe Edition)')).toBe('album');
		expect(name_similarity('Beyoncé', 'Beyonce')).toBe(1);
		expect(normalize_name('ＡＢＣ')).toBe('abc');
		expect(normalize_name('방탄소년단')).toBe('방탄소년단');
	});
	it('takes the primary artist', () => {
		expect(primary_artist_name('A, B & C')).toBe('A');
		expect(primary_artist_name('Drake feat. Future')).toBe('Drake');
	});
});

describe('service ids', () => {
	it('normalizes', () => {
		expect(normalize_youtube_id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1')).toBe('dQw4w9WgXcQ');
		expect(normalize_youtube_id('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(normalize_soundcloud_permalink('https://soundcloud.com/User/Track-1?in=x')).toBe('user/track-1');
		expect(normalize_isrc('us-abc-12-34567')).toBe('USABC1234567');
	});
	it('parses thumbnail sizes', () => {
		expect(parse_thumbnail_size('https://is1.mzstatic.com/x/100x100bb.jpg')).toEqual({ width: 100, height: 100 });
		expect(parse_thumbnail_size('https://lh3.googleusercontent.com/a=w544-h544-l90')).toEqual({ width: 544, height: 544 });
	});
});
