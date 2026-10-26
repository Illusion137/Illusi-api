import { describe, expect, it } from 'vitest';
import type { BiniSearchHit } from '@origin/binilyrics/types';
import { classify_error, error_message, pick_bini_hit } from './servers';

describe('classify_error', () => {
	it('treats 404s and "no result" messages as NOT_FOUND', () => {
		expect(classify_error('BINILYRICS', 'rozfetch failed | response NOT ok | 404: Not Found;\n : args{}').status).toBe('NOT_FOUND');
		expect(classify_error('LRCLIB', 'Failed to find specified track\n : args{\n  status: 404\n}').status).toBe('NOT_FOUND');
		expect(classify_error('GOLYRICS', 'GoLyrics: response contained no TTML').status).toBe('NOT_FOUND');
		expect(classify_error('MUSIXMATCH', 'Musixmatch found no matching track').status).toBe('NOT_FOUND');
	});

	it('treats captchas and rate limits as SKIPPED with a cooldown', () => {
		expect(classify_error('MUSIXMATCH', 'Musixmatch captcha cooldown is active for every app id')).toEqual({ status: 'SKIPPED', cooldown_ms: 2 * 60 * 60_000 });
		expect(classify_error('LRCLIB', 'Too many requests\n : args{\n  status: 429\n}')).toMatchObject({ status: 'SKIPPED' });
	});

	it('is ERROR otherwise, and ignores keywords in the request args', () => {
		expect(classify_error('GOLYRICS', '[ABORTED_ROZFETCH]The operation timed out').status).toBe('ERROR');
		expect(classify_error('BINILYRICS', 'rozfetch failed | response NOT ok | 500\n : args{ input: "song not found captcha" }').status).toBe('ERROR');
	});

	it('reads lib-origin and plain error shapes', () => {
		expect(error_message({ error: new Error('boom') })).toBe('boom');
		expect(error_message({ error: 'Lyrics not found' })).toBe('Lyrics not found');
	});
});

describe('pick_bini_hit', () => {
	const hit = (track_name: string, artist_name: string, duration: number): BiniSearchHit => ({ id: '1', isrc: '', track_name, artist_name, album_name: '', duration, lyricsUrl: 'https://x', timing_type: 'word' });
	const q = { title: 'Song', artist: 'Artist', album: null, duration_s: 180 };

	it('needs the title plus artist or duration', () => {
		expect(pick_bini_hit([hit('Other', 'Artist', 180), hit('Song', 'Artist', 999)], q)?.duration).toBe(999);
		expect(pick_bini_hit([hit('Song', 'Nobody', 181)], q)).not.toBeNull();
		expect(pick_bini_hit([hit('Song', 'Nobody', 300)], q)).toBeNull();
		expect(pick_bini_hit(undefined, q)).toBeNull();
	});
});
