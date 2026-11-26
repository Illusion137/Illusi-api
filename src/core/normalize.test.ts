import { describe, expect, it } from 'vitest';
import { name_similarity, names_differ, names_match, normalize_name, primary_artist_name, split_release_suffix, strip_decorations } from './normalize';
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
		expect(normalize_name('cade\u200e \u200e')).toBe('cade');
	});
	it('reads a $ written for an s as one, but not in a price', () => {
		expect(normalize_name('KA$HDAMI')).toBe(normalize_name('KASHDAMI'));
		expect(normalize_name('$umn$light')).toBe(normalize_name('SumnSlight'));
		expect(normalize_name('$uicideboy$')).toBe('suicideboys');
		expect(normalize_name('Joey Bada$$')).toBe('joey badass');
		expect(normalize_name('A$AP Rocky')).toBe('asap rocky');
		expect(normalize_name('$100 Bill')).toBe('100 bill');
		expect(name_similarity('Ca$h Out', 'Cash Out')).toBe(1);
	});
	it('takes the primary artist', () => {
		expect(primary_artist_name('A, B & C')).toBe('A');
		expect(primary_artist_name('Drake feat. Future')).toBe('Drake');
	});
});

describe('names_match', () => {
	it('keeps sequels, volumes, parts and years apart', () => {
		for (const [a, b] of [
			['Lil Boat 2', 'Lil Boat 3'], ['R&B Hits 2025', 'R&B Hits 2022'], ['A Love Letter To You 3', 'A Love Letter To You'],
			['Cooking Up, Vol. 1', 'Cooking Up, Vol. 2'], ['Side Bitch Is My Main Bitch', 'Side Bitch Is My Main Bitch Pt. 2'],
			['Goodbye Despair 2 (Instrumentals)', 'Goodbye Despair (Instrumentals)'], ['Rock II', 'Rock III']
		]) {
			expect(names_differ(a, b), `${a} / ${b}`).toBe(true);
			expect(names_match(a, b), `${a} / ${b}`).toBe(false);
		}
		expect(names_differ('Vol. 02', 'Vol. 2')).toBe(false);
		expect(names_differ('Rocky II', 'Rocky 2')).toBe(false);
	});
	it('keeps a word replaced by another apart, but not a typo', () => {
		expect(names_match('Otorimonogatari Gekihanongakushu (Original Soundtrack)', 'Nisemonogatari Gekihanongakushu (Original Soundtrack)')).toBe(false);
		expect(names_match('Koimonogatari Gekihanongakushu (Original Soundtrack)', 'Bakemonogatari Gekihanongakushu (Original Soundtrack)')).toBe(false);
		expect(names_match('Hotline Bling', 'Hotline Blinng')).toBe(true);
		expect(names_match('Colour Me Badd', 'Color Me Badd')).toBe(true);
	});
	it('ignores how an upload is decorated', () => {
		expect(strip_decorations('Fantasy (Official 4K Video) [prod. X]')).toEqual({ text: 'Fantasy', removed: 2 });
		expect(strip_decorations('Song (Remix)')).toEqual({ text: 'Song (Remix)', removed: 0 });
		expect(names_match('Fantasy (Official 4K Video)', 'Fantasy')).toBe(true);
		expect(names_match('Song (prod. 808 Mafia)', 'Song')).toBe(true);
		expect(names_match('Song (feat. 21 Savage)', 'Song')).toBe(true);
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

describe('split_release_suffix', () => {
	it('drops Apple Music\'s release suffix and reads the type from it', () => {
		expect(split_release_suffix('Zelda - Single')).toEqual({ name: 'Zelda', album_type: 'SINGLE' });
		expect(split_release_suffix('Spacepaxk 2 - EP')).toEqual({ name: 'Spacepaxk 2', album_type: 'EP' });
		expect(split_release_suffix('Weak \u2013 album')).toEqual({ name: 'Weak', album_type: 'ALBUM' });
	});
	it('leaves other names alone', () => {
		expect(split_release_suffix('Single Ladies')).toEqual({ name: 'Single Ladies', album_type: null });
		expect(split_release_suffix('Live - Remastered')).toEqual({ name: 'Live - Remastered', album_type: null });
		expect(split_release_suffix(' - Single')).toEqual({ name: ' - Single', album_type: null });
	});
});
