import { describe, expect, it } from 'vitest';
import { HttpError } from '../../core/http';
import { decode_cursor, encode_cursor, page_from, slice_page } from './paging';
import { artist_name_candidates, detect_service_id, edit_distance, match_score, rank_boost, rank_candidates, search_text, search_words, trigram_similarity } from './search';
import type { Candidate } from './search';
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

	it('splits folded words on punctuation', () => {
		expect(search_words('...Baby One More Time')).toEqual(['baby', 'one', 'more', 'time']);
		expect(search_words('Tyler, The Creator')).toEqual(['tyler', 'the', 'creator']);
		expect(search_words('  ')).toEqual([]);
	});

	it('measures edits and adjacent swaps up to a limit', () => {
		expect(edit_distance('roulette', 'rouletee', 2)).toBe(1);
		expect(edit_distance('mobbstar', 'mobbstarr', 1)).toBe(1);
		expect(edit_distance('form', 'from', 1)).toBe(1);
		expect(edit_distance('abc', 'xyz', 1)).toBe(2);
		expect(edit_distance('a', 'abcd', 1)).toBe(2);
	});

	it('scores exact over extra words over missing words over fuzzy', () => {
		const exact = match_score('hotline bling', 'Hotline Bling');
		const extra = match_score('hotline bling', 'Hotline Bling (Cover)');
		const reordered = match_score('bling hotline', 'Hotline Bling');
		const missing = match_score('hotline bling remastered', 'Hotline Bling');
		const fuzzy = match_score('hotlin blng', 'Hotline Bling');
		expect(exact).toBe(1);
		expect(extra).toBeLessThan(exact);
		expect(reordered).toBeLessThan(exact);
		expect(reordered).toBeGreaterThan(extra);
		expect(missing).toBeLessThan(extra);
		expect(fuzzy).toBeGreaterThan(0);
		expect(fuzzy).toBeLessThan(missing);
	});

	it('ignores punctuation and spacing', () => {
		expect(match_score('baby one more time', '...Baby One More Time')).toBe(1);
		expect(match_score('acdc', 'AC/DC')).toBe(1);
		expect(match_score('Beyonce', 'Beyoncé')).toBe(1);
	});

	it('finds the artist named anywhere in the query', () => {
		const named = match_score('drake hotline bling', 'Hotline Bling', ['Drake']);
		expect(named).toBeGreaterThan(match_score('drake hotline bling', 'Hotline Bling', ['Someone']));
		expect(named).toBeGreaterThan(match_score('drake hotline bling', 'Drake - Hotline Bling', ['Uploader']));
		expect(match_score('dogtooth tyler the creator', 'DOGTOOTH', ['Tyler, The Creator'])).toBeGreaterThan(1);
		// Only the artist: close to an exact title, under it.
		const by_artist = match_score('lelo', 'Like Sunday', ['Lelo']);
		expect(by_artist).toBeGreaterThan(0.9);
		expect(by_artist).toBeLessThan(match_score('lelo', 'Lelo'));
	});

	it('takes typos in long words and the last word as typed', () => {
		expect(match_score('russian rouletee', 'Russian Roulette')).toBeGreaterThan(0.6);
		expect(match_score('mobbstar', 'Wave', ['MOBBSTARR'])).toBeGreaterThan(0.6);
		expect(match_score('hotline bl', 'Hotline Bling')).toBeGreaterThan(match_score('hotline', 'Hotline Bling'));
		// "love" is no typo of "lose", and a whole word beats a prefix.
		expect(match_score('love', 'Lose')).toBeLessThan(0.45);
		expect(match_score('love', 'Love Hurts')).toBeGreaterThan(match_score('love', 'Loverboy'));
	});

	it('falls back to substrings and trigrams for unspaced or garbled text', () => {
		expect(match_score('そう', 'もうそう☆えくすぷれす')).toBeCloseTo(0.45);
		expect(match_score('hotlinebling', 'Hotline Bling')).toBe(1);
		const garbled = match_score('htolinne', 'Hotline');
		expect(garbled).toBeGreaterThan(0);
		expect(garbled).toBeLessThan(0.45);
		expect(match_score('', 'x')).toBe(0);
	});

	it('lists runs of words as possible artist names', () => {
		expect(artist_name_candidates('tyler the creator')).toEqual(['tyler', 'the', 'creator', 'tyler the', 'the creator', 'tyler the creator']);
		expect(artist_name_candidates('   ')).toEqual([]);
	});
});

const candidate = (id: string, name: string, extra: Partial<Candidate> = {}): Candidate => ({
	id, name, credits: [], popularity: 0, presence: 0, official: false, mine: false, linked: false, ...extra
});

describe('rank_candidates', () => {
	it('puts linked results first, then match, then plays', () => {
		const ranked = rank_candidates('hotline bling', [
			candidate('cover', 'Hotline Bling (Cover)', { popularity: 3 }),
			candidate('orig', 'Hotline Bling', { credits: ['Drake'], popularity: 5 }),
			candidate('remix', 'Hotline Bling', { popularity: 50 }),
			candidate('link', 'Something Else', { linked: true }),
			candidate('none', 'zzzz', { popularity: 1000 })
		]);
		expect(ranked).toEqual(['link', 'remix', 'orig', 'cover']);
	});

	it('orders equal matches by release metadata, library and artist catalog', () => {
		const ranked = rank_candidates('hotline bling', [
			candidate('upload', 'hotline bling', { credits: ['BillieEilishVEVO'] }),
			candidate('namesake', 'Hotline Bling', { credits: ['Miro Mas'], official: true, presence: 1 }),
			candidate('drake', 'Hotline Bling', { credits: ['Drake'], official: true, presence: 40 }),
			candidate('mine', 'Hotline Bling', { credits: ['Someone'], mine: true })
		]);
		expect(ranked).toEqual(['mine', 'drake', 'namesake', 'upload']);
	});

	it('lets popularity reorder close matches but not distant ones', () => {
		expect(rank_candidates('hotline bling', [
			candidate('exact', 'Hotline Bling'),
			candidate('cover', 'Hotline Bling (Cover)', { popularity: 100 })
		])).toEqual(['cover', 'exact']);
		expect(rank_candidates('hotline bling', [
			candidate('exact', 'Hotline Bling'),
			candidate('other', 'Hotline', { popularity: 1_000_000, official: true, mine: true })
		])).toEqual(['exact', 'other']);
		expect(rank_boost(candidate('x', 'x', { popularity: 1e9, presence: 1e9, official: true, mine: true }))).toBeCloseTo(0.36);
	});

	it('matches artist + title queries through credits', () => {
		const ranked = rank_candidates('drake hotline bling', [
			candidate('other', 'Hotline Bling', { credits: ['Someone'] }),
			candidate('drake', 'Hotline Bling', { credits: ['Drake'] })
		]);
		expect(ranked[0]).toBe('drake');
	});

	it('merges duplicate candidates from different sources', () => {
		const ranked = rank_candidates('song', [
			candidate('a', 'Song'),
			candidate('a', 'Song', { linked: true }),
			candidate('b', 'Song')
		]);
		expect(ranked).toEqual(['a', 'b']);
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

describe('detect_service_id edge cases', () => {
	it('ignores unparseable links and links without a recognizable track id', () => {
		expect(detect_service_id('http://[bad')).toBeNull();
		expect(detect_service_id('https://example.com/track/123')).toBeNull();
		expect(detect_service_id('https://www.deezer.com/en/track/123')).toEqual({ column: 'deezer_id', value: '123' });
		expect(detect_service_id('https://tidal.com/browse/track/456')).toEqual({ column: 'tidal_id', value: '456' });
	});
});
