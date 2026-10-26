import { describe, expect, it } from 'vitest';
import { detect_ttml_sync, genius_version, lrclib_versions, musixmatch_versions, ttml_version, ytm_version } from './formats';

describe('TTML (BiniLyrics / GoLyrics)', () => {
	it('prefers the service hint, then the timing attribute, then structure', () => {
		expect(detect_ttml_sync('<tt itunes:timing="Word">', 'syllable')).toBe('SYLLABLE');
		expect(detect_ttml_sync('<tt itunes:timing="Word">')).toBe('WORD');
		expect(detect_ttml_sync('<tt itunes:timing="Line">')).toBe('LINE');
		expect(detect_ttml_sync('<tt itunes:timing="None">')).toBe('NONE');
		expect(detect_ttml_sync('<tt><p begin="1"><span begin="1">a</span></p></tt>')).toBe('WORD');
		expect(detect_ttml_sync('<tt><p begin="1">a</p></tt>')).toBe('LINE');
		expect(detect_ttml_sync('<tt><p>a</p></tt>')).toBe('NONE');
	});

	it('stores the TTML untouched', () => {
		const raw = '<tt itunes:timing="Line"><p begin="1">x</p></tt>';
		expect(ttml_version(raw)).toEqual({ format: 'TTML', sync_type: 'LINE', raw_content: raw });
	});
});

describe('Musixmatch', () => {
	it('stores richsync, subtitle and plain as separate versions', () => {
		const versions = musixmatch_versions({ richsync_body: '[{"ts":1}]', subtitle_body: '[00:01.00]a', lyrics_body: 'a' });
		expect(versions.map(v => [v.format, v.sync_type])).toEqual([['MXM_RICHSYNC_JSON', 'WORD'], ['LRC', 'LINE'], ['PLAIN', 'NONE']]);
		expect(versions[0].raw_content).toBe('[{"ts":1}]');
	});

	it('skips missing or empty bodies', () => {
		expect(musixmatch_versions({ lyrics_body: '  ' })).toEqual([]);
	});
});

describe('LRCLib', () => {
	it('detects LRC vs enhanced LRC and keeps plain', () => {
		expect(lrclib_versions({ syncedLyrics: '[00:01.00]a', plainLyrics: 'a' }).map(v => [v.format, v.sync_type])).toEqual([['LRC', 'LINE'], ['PLAIN', 'NONE']]);
		expect(lrclib_versions({ syncedLyrics: '[00:01.00]<00:01.00>a <00:01.50>b' })[0]).toMatchObject({ format: 'ELRC', sync_type: 'WORD' });
		expect(lrclib_versions({ instrumental: true, syncedLyrics: null, plainLyrics: null })).toEqual([]);
	});
});

describe('Genius / YouTube Music', () => {
	it('stores the Genius body as JSON text', () => {
		const body = { tag: 'root', children: ['a'] };
		expect(genius_version(body)).toEqual({ format: 'GENIUS_BODY_JSON', sync_type: 'NONE', raw_content: JSON.stringify(body) });
		expect(genius_version(undefined)).toBeNull();
	});

	it('detects YouTube Music payload formats', () => {
		expect(ytm_version('plain words')).toMatchObject({ format: 'PLAIN', sync_type: 'NONE' });
		expect(ytm_version('[00:01.00]timed')).toMatchObject({ format: 'LRC', sync_type: 'LINE' });
		expect(ytm_version({ timedLyricsData: [{ lyricLine: 'a', cueRange: { startTimeMilliseconds: '0' } }] })).toMatchObject({ format: 'YTM_JSON', sync_type: 'LINE' });
		expect(ytm_version({ description: 'a' })).toMatchObject({ format: 'YTM_JSON', sync_type: 'NONE' });
		expect(ytm_version('')).toBeNull();
		expect(ytm_version(undefined)).toBeNull();
	});
});
