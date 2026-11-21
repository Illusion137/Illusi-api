import { describe, expect, it } from 'vitest';
import type { BiniSearchHit } from '@origin/binilyrics/types';
import type { KuGouLyricsCandidate } from '@origin/kugou/types';
import { classify_error, error_message, pick_bini_hit, pick_catalog_hit, pick_kugou_candidate } from './servers';

describe('classify_error', () => {
	it('treats 404s and "no result" messages as NOT_FOUND', () => {
		expect(classify_error('rozfetch failed | response NOT ok | 404: Not Found;\n : args{}').status).toBe('NOT_FOUND');
		expect(classify_error('Failed to find specified track\n : args{\n  status: 404\n}').status).toBe('NOT_FOUND');
		expect(classify_error('BiniLyrics: response contained no TTML').status).toBe('NOT_FOUND');
		expect(classify_error('QQ Music: no lyrics found').status).toBe('NOT_FOUND');
		expect(classify_error('Unison: lyrics not found\n : args{ status: 404 }').status).toBe('NOT_FOUND');
		expect(classify_error('lrc.red: not a valid ISRC').status).toBe('NOT_FOUND');
	});

	it('treats captchas and rate limits as SKIPPED with a cooldown', () => {
		expect(classify_error('Please solve the captcha')).toEqual({ status: 'SKIPPED', cooldown_ms: 60_000 });
		expect(classify_error('QQ Music: too many requests (search results withheld)')).toEqual({ status: 'SKIPPED', cooldown_ms: 60_000 });
		expect(classify_error('Too many requests\n : args{\n  status: 429\n}')).toMatchObject({ status: 'SKIPPED' });
	});

	it('cools a service down when it answers with an HTML page', () => {
		expect(classify_error('Unexpected token \'<\', "<html>\r')).toEqual({ status: 'SKIPPED', cooldown_ms: 10 * 60_000 });
		expect(classify_error('<!DOCTYPE html><title>502 Bad Gateway</title>')).toMatchObject({ status: 'SKIPPED' });
	});

	it('retries a pending Unison lookup later without pausing the service', () => {
		expect(classify_error('Unison: lookup pending')).toEqual({ status: 'SKIPPED' });
	});

	it('is ERROR otherwise, and ignores keywords in the request args', () => {
		expect(classify_error('[ABORTED_ROZFETCH]The operation timed out').status).toBe('ERROR');
		expect(classify_error('rozfetch failed | response NOT ok | 500\n : args{ input: "song not found captcha" }').status).toBe('ERROR');
	});

	it('reads lib-origin and plain error shapes', () => {
		expect(error_message({ error: new Error('boom') })).toBe('boom');
		expect(error_message({ error: 'Lyrics not found' })).toBe('Lyrics not found');
	});
});

describe('pick_bini_hit', () => {
	const hit = (track_name: string, artist_name: string, duration: number): BiniSearchHit => ({ id: '1', isrc: '', track_name, artist_name, album_name: '', duration, lyricsUrl: 'https://x', timing_type: 'word' });
	const q = { title: 'Song', artist: 'Artist', album: null, duration_s: 180, isrc: null, youtube_id: null };

	it('needs the title plus artist or duration', () => {
		expect(pick_bini_hit([hit('Other', 'Artist', 180), hit('Song', 'Artist', 999)], q)?.duration).toBe(999);
		expect(pick_bini_hit([hit('Song', 'Nobody', 181)], q)).not.toBeNull();
		expect(pick_bini_hit([hit('Song', 'Nobody', 300)], q)).toBeNull();
		expect(pick_bini_hit(undefined, q)).toBeNull();
	});
});

describe('pick_catalog_hit', () => {
	const q = { title: 'Song', artist: 'Artist', album: null, duration_s: 180, isrc: null, youtube_id: null };
	const hit = (title: string, artists: string[], duration_s: number | null) => ({ title, artists, duration_ms: duration_s == null ? null : duration_s * 1000, item: `${title}/${artists.join('+')}/${duration_s}` });

	it('needs the title, a duration that agrees, and the artist unless the duration confirms it', () => {
		expect(pick_catalog_hit([hit('Other', ['Artist'], 180), hit('Song (Remix)', ['Artist'], 240), hit('Song', ['Artist'], 181)], q)).toBe('Song/Artist/181');
		expect(pick_catalog_hit([hit('Song', ['Artist'], 200)], q)).toBeNull();
		expect(pick_catalog_hit([hit('Song', ['Cover Band'], 179)], q)).toBe('Song/Cover Band/179');
		expect(pick_catalog_hit([hit('Song', ['Cover Band'], null)], q)).toBeNull();
		expect(pick_catalog_hit([hit('Song', ['Someone', 'Artist'], null)], q)).toBe('Song/Someone+Artist/null');
		expect(pick_catalog_hit([hit('Song', ['Cover Band'], 179)], { ...q, duration_s: null })).toBeNull();
	});
});

describe('pick_kugou_candidate', () => {
	const c = (id: string, krctype: number, score: number, duration: number): KuGouLyricsCandidate => ({ id, accesskey: 'k', song: 'Song', singer: 'Artist', duration, krctype, score });

	it('prefers synced candidates, then score, among those whose duration agrees', () => {
		expect(pick_kugou_candidate([c('a', 2, 90, 180_000), c('b', 1, 40, 180_500), c('c', 1, 60, 179_000)], 180_000)?.id).toBe('c');
		expect(pick_kugou_candidate([c('a', 1, 90, 240_000)], 180_000)).toBeNull();
		expect(pick_kugou_candidate([c('a', 1, 90, 240_000)], null)?.id).toBe('a');
		expect(pick_kugou_candidate([], 180_000)).toBeNull();
	});
});
