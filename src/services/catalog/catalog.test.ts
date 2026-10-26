import { describe, expect, it } from 'vitest';
import { HttpError } from '../../core/http';
import { decode_cursor, encode_cursor, page_from, slice_page } from './paging';
import { artist_name_candidates, detect_service_id, match_score, rank_candidates, search_text, trigram_similarity } from './search';
import { sort_thumbnails } from './views';

describe('paging', () => {
	it('round-trips offsets', () => {
		expect(decode_cursor(encode_cursor(150))).toBe(150);
		expect(decode_cursor(undefined)).toBe(0);
	});

	it('rejects foreign cursors', () => {
		for (const bad of ['nope', encode_cursor(-1), Buffer.from('{"o":1.5}').toString('base64url'), Buffer.from('[]').toString('base64url')]) {
			expect(() => decode_cursor(bad)).toThrow(HttpError);
		}
	});

	it('uses the extra row only to signal a next page', () => {
		expect(page_from([1, 2, 3], 0, 2)).toEqual({ items: [1, 2], next_cursor: encode_cursor(2) });
		expect(page_from([1, 2], 4, 2)).toEqual({ items: [1, 2], next_cursor: null });
	});

	it('slices a complete list', () => {
		const all = [1, 2, 3, 4, 5];
		expect(slice_page(all, 0, 2)).toEqual({ items: [1, 2], next_cursor: encode_cursor(2) });
		expect(slice_page(all, 4, 2)).toEqual({ items: [5], next_cursor: null });
		expect(slice_page(all, 10, 2)).toEqual({ items: [], next_cursor: null });
	});
});

describe('search text', () => {
	it('folds case and accents like illusi_search_text', () => {
		expect(search_text('Beyoncé')).toBe('beyonce');
		expect(search_text('MØ')).toBe('mø');
	});

	it('computes pg_trgm similarity', () => {
		expect(trigram_similarity('word', 'word')).toBe(1);
		expect(trigram_similarity('word', 'two words')).toBeCloseTo(4 / 11);
		expect(trigram_similarity('', 'x')).toBe(0);
	});

	it('ranks exact over prefix over contains over fuzzy', () => {
		const exact = match_score('hotline bling', ['Hotline Bling']);
		const prefix = match_score('hotline', ['Hotline Bling']);
		const contains = match_score('bling', ['Hotline Bling']);
		const fuzzy = match_score('hotlin blng', ['Hotline Bling']);
		expect(exact).toBe(3);
		expect(prefix).toBe(2);
		expect(contains).toBe(1);
		expect(fuzzy).toBeGreaterThan(0);
		expect(fuzzy).toBeLessThan(1);
	});

	it('lists runs of words as possible artist names', () => {
		expect(artist_name_candidates('tyler the creator')).toEqual(['tyler', 'the', 'creator', 'tyler the', 'the creator', 'tyler the creator']);
		expect(artist_name_candidates('   ')).toEqual([]);
	});
});

describe('rank_candidates', () => {
	it('puts linked results first, then score, then plays', () => {
		const ranked = rank_candidates('hotline bling', [
			{ id: 'cover', texts: ['Hotline Bling (Cover)'], plays: 100, linked: false },
			{ id: 'orig', texts: ['Hotline Bling', 'Drake Hotline Bling'], plays: 5, linked: false },
			{ id: 'remix', texts: ['Hotline Bling'], plays: 50, linked: false },
			{ id: 'link', texts: ['Something Else'], plays: 0, linked: true },
			{ id: 'none', texts: ['zzzz'], plays: 1000, linked: false }
		]);
		expect(ranked).toEqual(['link', 'remix', 'orig', 'cover']);
	});

	it('matches artist + title queries through combined texts', () => {
		const ranked = rank_candidates('drake hotline bling', [
			{ id: 'other', texts: ['Hotline Bling', 'Someone Hotline Bling'], plays: 0, linked: false },
			{ id: 'drake', texts: ['Hotline Bling', 'Drake Hotline Bling'], plays: 0, linked: false }
		]);
		expect(ranked[0]).toBe('drake');
	});

	it('merges duplicate candidates from different sources', () => {
		const ranked = rank_candidates('song', [
			{ id: 'a', texts: ['x'], plays: 0, linked: false },
			{ id: 'a', texts: ['Song'], plays: 3, linked: false }
		]);
		expect(ranked).toEqual(['a']);
	});
});

describe('detect_service_id', () => {
	it('recognises links', () => {
		expect(detect_service_id('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x')).toEqual({ column: 'spotify_id', value: '4uLU6hMCjMI75M1A2tKUQC' });
		expect(detect_service_id('spotify:album:4uLU6hMCjMI75M1A2tKUQC')).toEqual({ column: 'spotify_id', value: '4uLU6hMCjMI75M1A2tKUQC' });
		expect(detect_service_id('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toEqual({ column: 'youtube_id', value: 'dQw4w9WgXcQ' });
		expect(detect_service_id('youtu.be/dQw4w9WgXcQ')).toEqual({ column: 'youtube_id', value: 'dQw4w9WgXcQ' });
		expect(detect_service_id('https://soundcloud.com/Artist/Track?in=x')).toEqual({ column: 'soundcloud_permalink', value: 'artist/track' });
		expect(detect_service_id('https://music.apple.com/us/album/name/123?i=456')).toEqual({ column: 'applemusic_id', value: '456' });
		expect(detect_service_id('https://www.deezer.com/en/track/3135556')).toEqual({ column: 'deezer_id', value: '3135556' });
		expect(detect_service_id('https://tidal.com/browse/track/1234')).toEqual({ column: 'tidal_id', value: '1234' });
	});

	it('recognises ISRCs', () => {
		expect(detect_service_id('USUM71703861')).toEqual({ column: 'isrc', value: 'USUM71703861' });
		expect(detect_service_id('US-UM7-17-03861')).toEqual({ column: 'isrc', value: 'USUM71703861' });
	});

	it('leaves plain words alone', () => {
		for (const q of ['beautifully', 'hotline bling', '4uLU6hMCjMI75M1A2tKUQC', 'drake', '12345']) expect(detect_service_id(q)).toBeNull();
	});
});

describe('sort_thumbnails', () => {
	it('puts the largest first and unknown sizes last', () => {
		const sorted = sort_thumbnails([
			{ url: 'u', width: null, height: null },
			{ url: 's', width: 100, height: 100 },
			{ url: 'l', width: 600, height: 600 }
		]);
		expect(sorted.map(t => t.url)).toEqual(['l', 's', 'u']);
	});
});
