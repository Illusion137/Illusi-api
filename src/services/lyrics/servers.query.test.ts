import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricsQuery } from './servers';

const mocks = vi.hoisted(() => ({
	bini_search: vi.fn(),
	bini_ttml: vi.fn(),
	golyrics_ttml: vi.fn(),
	mxm_macro: vi.fn(),
	mxm_richsync: vi.fn(),
	lrclib_get: vi.fn()
}));

vi.mock('@origin/binilyrics/binilyrics', () => ({ BiniLyrics: { search: mocks.bini_search, get_ttml: mocks.bini_ttml } }));
vi.mock('@origin/golyrics/golyrics', () => ({ GoLyrics: { get_ttml: mocks.golyrics_ttml } }));
vi.mock('@origin/musixmatch/musixmatch', () => ({ Musixmatch: { get_macro_subtitles: mocks.mxm_macro, get_richsync: mocks.mxm_richsync } }));
vi.mock('@origin/lrclib/lrclib', () => ({ LRCLib: { get: mocks.lrclib_get } }));

const q: LyricsQuery = { title: 'Song', artist: 'Artist', album: 'Album', duration_s: 180 };
const bare: LyricsQuery = { title: 'Song', artist: 'Artist', album: null, duration_s: null };
const TTML = '<tt><body><div><p begin="00:01.000" end="00:02.000">Hi</p></div></body></tt>';

/** A fresh module per test: cooldowns are process state. */
const load = async () => import('./servers.js');

beforeEach(() => { vi.resetAllMocks(); });

describe('query_service BINILYRICS', () => {
	const hit = { id: '1', isrc: '', track_name: 'Song', artist_name: 'Artist', album_name: '', duration: 180, lyricsUrl: 'https://bini/x', timing_type: 'word' };

	it('stores the TTML of the matching hit', async () => {
		const { query_service } = await load();
		mocks.bini_search.mockResolvedValue({ results: [{ ...hit, lyricsUrl: '' }, hit] });
		mocks.bini_ttml.mockResolvedValue(TTML);
		const out = await query_service('BINILYRICS', q);
		expect(out).toEqual({ service: 'BINILYRICS', status: 'FOUND', versions: [{ format: 'TTML', sync_type: 'WORD', raw_content: TTML }] });
		expect(mocks.bini_search).toHaveBeenCalledWith({ track: 'Song', artist: 'Artist', album: 'Album', duration: 180 }, expect.anything());
		expect(mocks.bini_ttml).toHaveBeenCalledWith('https://bini/x', expect.anything());
	});

	it('is NOT_FOUND without a matching hit or with blank TTML', async () => {
		const { query_service } = await load();
		mocks.bini_search.mockResolvedValue({ results: [{ ...hit, track_name: 'Other' }] });
		expect((await query_service('BINILYRICS', bare)).status).toBe('NOT_FOUND');
		expect(mocks.bini_search).toHaveBeenCalledWith({ track: 'Song', artist: 'Artist' }, expect.anything());
		mocks.bini_search.mockResolvedValue({ results: [hit] });
		mocks.bini_ttml.mockResolvedValue('  \n');
		expect((await query_service('BINILYRICS', q)).status).toBe('NOT_FOUND');
	});

	it('passes search and TTML errors through the classifier', async () => {
		const { query_service } = await load();
		mocks.bini_search.mockResolvedValue({ error: 'rozfetch failed | response NOT ok | 404: Not Found' });
		expect(await query_service('BINILYRICS', q)).toMatchObject({ status: 'NOT_FOUND', versions: [], error: expect.stringContaining('404') });
		mocks.bini_search.mockResolvedValue({ results: [hit] });
		mocks.bini_ttml.mockResolvedValue({ error: new Error('connection reset') });
		expect(await query_service('BINILYRICS', q)).toMatchObject({ status: 'ERROR', error: 'connection reset' });
	});
});

describe('query_service GOLYRICS', () => {
	it('returns the TTML and maps errors', async () => {
		const { query_service } = await load();
		mocks.golyrics_ttml.mockResolvedValue(TTML);
		expect(await query_service('GOLYRICS', q)).toMatchObject({ status: 'FOUND', versions: [{ format: 'TTML', sync_type: 'LINE' }] });
		expect(mocks.golyrics_ttml).toHaveBeenCalledWith({ song: 'Song', artist: 'Artist', album: 'Album', duration: 180 }, expect.anything());
		mocks.golyrics_ttml.mockResolvedValue({ error: 'GoLyrics: response contained no TTML' });
		expect((await query_service('GOLYRICS', bare)).status).toBe('NOT_FOUND');
		expect(mocks.golyrics_ttml).toHaveBeenLastCalledWith({ song: 'Song', artist: 'Artist' }, expect.anything());
	});

	it('turns thrown errors into ERROR', async () => {
		const { query_service } = await load();
		mocks.golyrics_ttml.mockRejectedValue(new Error('boom\nargs: {}'));
		expect(await query_service('GOLYRICS', q)).toMatchObject({ status: 'ERROR', error: 'boom' });
	});
});

describe('query_service MUSIXMATCH', () => {
	const macro = (calls: Record<string, unknown>) => ({ macro_calls: calls });
	const call = (body: unknown) => ({ message: { body } });
	const track = (over: Record<string, unknown> = {}) => call({ track: { track_id: 42, has_richsync: 0, ...over } });

	it('keeps richsync, subtitle and lyrics bodies as returned', async () => {
		const { query_service } = await load();
		mocks.mxm_macro.mockResolvedValue(macro({
			'matcher.track.get': track(),
			'track.richsync.get': call({ richsync: { richsync_body: '[{"ts":1}]' } }),
			'track.subtitles.get': call({ subtitle_list: [{ subtitle: { subtitle_body: '[00:01.00]Hi' } }] }),
			'track.lyrics.get': call({ lyrics: { lyrics_body: 'Hi' } })
		}));
		const out = await query_service('MUSIXMATCH', q);
		expect(out.status).toBe('FOUND');
		expect(out.versions.map((v: { format: string }) => v.format)).toEqual(['MXM_RICHSYNC_JSON', 'LRC', 'PLAIN']);
		expect(mocks.mxm_macro).toHaveBeenCalledWith({ q_track: 'Song', q_artist: 'Artist', q_album: 'Album', q_duration: 180 }, expect.anything());
	});

	it('fetches richsync separately when the macro lacks it', async () => {
		const { query_service } = await load();
		mocks.mxm_macro.mockResolvedValue(macro({ 'matcher.track.get': track({ has_richsync: 1 }), 'track.richsync.get': call([]) }));
		mocks.mxm_richsync.mockResolvedValue([{ ts: 1 }]);
		const out = await query_service('MUSIXMATCH', bare);
		expect(out.versions).toEqual([{ format: 'MXM_RICHSYNC_JSON', sync_type: 'WORD', raw_content: '[{"ts":1}]' }]);
		expect(mocks.mxm_richsync).toHaveBeenCalledWith(42, undefined, expect.anything());
		mocks.mxm_richsync.mockResolvedValue({ error: 'nope' });
		expect((await query_service('MUSIXMATCH', bare)).status).toBe('NOT_FOUND');
	});

	it('is NOT_FOUND for the placeholder track or no track', async () => {
		const { query_service } = await load();
		mocks.mxm_macro.mockResolvedValue(macro({ 'matcher.track.get': track({ track_id: 115264642 }) }));
		expect((await query_service('MUSIXMATCH', q)).status).toBe('NOT_FOUND');
		mocks.mxm_macro.mockResolvedValue(macro({ 'matcher.track.get': call('') }));
		expect((await query_service('MUSIXMATCH', q)).status).toBe('NOT_FOUND');
	});

	it('cools down after a captcha and skips the service until it ends', async () => {
		const { query_service, cooldown_until } = await load();
		expect(cooldown_until('MUSIXMATCH')).toBeNull();
		mocks.mxm_macro.mockResolvedValue({ error: new Error('Musixmatch captcha cooldown is active') });
		const first = await query_service('MUSIXMATCH', q);
		expect(first.status).toBe('SKIPPED');
		const until = cooldown_until('MUSIXMATCH')!;
		expect(until.getTime() - Date.now()).toBeGreaterThan(60 * 60_000);
		expect(first.cooldown_until).toEqual(until);
		mocks.mxm_macro.mockClear();
		expect(await query_service('MUSIXMATCH', q)).toMatchObject({ status: 'SKIPPED', cooldown_until: until });
		expect(mocks.mxm_macro).not.toHaveBeenCalled();
		expect(cooldown_until('MUSIXMATCH', until.getTime() + 1)).toBeNull();
	});
});

describe('query_service LRCLIB', () => {
	it('maps synced, plain and instrumental results', async () => {
		const { query_service } = await load();
		mocks.lrclib_get.mockResolvedValue({ syncedLyrics: '[00:01.00]<00:01.00>Hi', plainLyrics: 'Hi' });
		const found = await query_service('LRCLIB', q);
		expect(found.versions.map((v: { format: string; sync_type: string }) => [v.format, v.sync_type])).toEqual([['ELRC', 'WORD'], ['PLAIN', 'NONE']]);
		expect(mocks.lrclib_get).toHaveBeenCalledWith({ track_name: 'Song', artist_name: 'Artist', album_name: 'Album', duration: 180 });
		mocks.lrclib_get.mockResolvedValue({ instrumental: true });
		expect((await query_service('LRCLIB', bare)).status).toBe('INSTRUMENTAL');
		expect(mocks.lrclib_get).toHaveBeenLastCalledWith({ track_name: 'Song', artist_name: 'Artist' });
		mocks.lrclib_get.mockResolvedValue({ instrumental: false, plainLyrics: ' ' });
		expect((await query_service('LRCLIB', q)).status).toBe('NOT_FOUND');
		mocks.lrclib_get.mockResolvedValue({ instrumental: true, plainLyrics: 'la' });
		expect((await query_service('LRCLIB', q)).status).toBe('FOUND');
	});

	it('rate limits put the service on cooldown', async () => {
		const { query_service } = await load();
		mocks.lrclib_get.mockResolvedValue({ error: 'Too many requests\n : args{\n  status: 429\n}' });
		const out = await query_service('LRCLIB', q);
		expect(out).toMatchObject({ status: 'SKIPPED', error: 'Too many requests' });
		expect(out.cooldown_until).toBeInstanceOf(Date);
	});
});

describe('query_service timeouts', () => {
	it('gives up on a slow service', async () => {
		const { query_service } = await load();
		mocks.golyrics_ttml.mockReturnValue(new Promise(() => undefined));
		const out = await query_service('GOLYRICS', q, 20);
		expect(out).toMatchObject({ status: 'ERROR', error: 'timed out after 20ms' });
	});
});
