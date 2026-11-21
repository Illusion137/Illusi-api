import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricsQuery } from './servers';

const mocks = vi.hoisted(() => ({
	bini_search: vi.fn(),
	bini_ttml: vi.fn(),
	lrclib_get: vi.fn(),
	lrcred_song: vi.fn(),
	unison_get: vi.fn(),
	qq_search: vi.fn(),
	qq_lyrics: vi.fn(),
	kugou_songs: vi.fn(),
	kugou_candidates: vi.fn(),
	kugou_download: vi.fn()
}));

vi.mock('@origin/binilyrics/binilyrics', () => ({ BiniLyrics: { search: mocks.bini_search, get_ttml: mocks.bini_ttml } }));
vi.mock('@origin/lrclib/lrclib', () => ({ LRCLib: { get: mocks.lrclib_get } }));
vi.mock('@origin/lrcred/lrcred', () => ({ LRCRed: { get_song: mocks.lrcred_song } }));
vi.mock('@origin/unison/unison', () => ({ Unison: { get_lyrics: mocks.unison_get } }));
vi.mock('@origin/qqmusic/qqmusic', () => ({ QQMusic: { search_songs: mocks.qq_search, get_lyrics: mocks.qq_lyrics } }));
vi.mock('@origin/kugou/kugou', () => ({ KuGou: { search_songs: mocks.kugou_songs, search_lyrics: mocks.kugou_candidates, download_lyrics: mocks.kugou_download } }));

const q: LyricsQuery = { title: 'Song', artist: 'Artist', album: 'Album', duration_s: 180, isrc: 'USAAA2600001', youtube_id: 'vid12345678' };
const bare: LyricsQuery = { title: 'Song', artist: 'Artist', album: null, duration_s: null, isrc: null, youtube_id: null };
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

describe('query_service LRCRED', () => {
	it('looks the ISRC up and stores the TTML, skipping model-synced files', async () => {
		const { query_service } = await load();
		mocks.lrcred_song.mockResolvedValue({ id: 'USAAA2600001', level: 'word', source: TTML });
		expect(await query_service('LRCRED', q)).toMatchObject({ status: 'FOUND', versions: [{ format: 'TTML', sync_type: 'WORD', raw_content: TTML }] });
		expect(mocks.lrcred_song).toHaveBeenCalledWith('USAAA2600001', expect.anything());
		mocks.lrcred_song.mockResolvedValue({ id: 'USAAA2600001', byModel: true, source: TTML });
		expect((await query_service('LRCRED', q)).status).toBe('NOT_FOUND');
	});

	it('is NOT_FOUND without an ISRC, without asking', async () => {
		const { query_service } = await load();
		expect((await query_service('LRCRED', bare)).status).toBe('NOT_FOUND');
		expect(mocks.lrcred_song).not.toHaveBeenCalled();
	});
});

describe('query_service UNISON', () => {
	const data = { id: 7, videoId: 'vid12345678', song: 'Song', artist: 'Artist', lyrics: '[00:01.00]Hi', format: 'lrc', syncType: 'linesync', voteCount: 3, submitter: { keyId: 'abc', displayName: 'someone', reputation: 2 } };

	it('stores the lyrics with their attribution, without the volatile fields', async () => {
		const { query_service } = await load();
		mocks.unison_get.mockResolvedValue(data);
		const out = await query_service('UNISON', q);
		expect(out).toMatchObject({ status: 'FOUND', versions: [{ format: 'UNISON_JSON', sync_type: 'LINE' }] });
		expect(JSON.parse(out.versions[0].raw_content)).toEqual({ id: 7, videoId: 'vid12345678', format: 'lrc', syncType: 'linesync', submitter: { keyId: 'abc', displayName: 'someone' }, lyrics: '[00:01.00]Hi' });
		expect(mocks.unison_get).toHaveBeenCalledWith({ v: 'vid12345678' }, expect.anything());
	});

	it('falls back to the track fields when the video id misses', async () => {
		const { query_service } = await load();
		mocks.unison_get.mockResolvedValueOnce({ error: new Error('Unison: lyrics not found') }).mockResolvedValueOnce(data);
		expect((await query_service('UNISON', q)).status).toBe('FOUND');
		expect(mocks.unison_get).toHaveBeenLastCalledWith({ song: 'Song', artist: 'Artist', album: 'Album', duration: 180, isrc: 'USAAA2600001' }, expect.anything());
		mocks.unison_get.mockResolvedValue({ error: new Error('Unison: lyrics not found') });
		expect((await query_service('UNISON', bare)).status).toBe('NOT_FOUND');
	});
});

describe('query_service QQMUSIC', () => {
	const song = (over: Record<string, unknown> = {}) => ({ mid: 'm1', id: 1, title: 'Song', singer: [{ name: 'Artist', mid: 's' }], album: { name: 'Album', mid: 'a' }, interval: 180, ...over });
	const QRC = '<Lyric_1 LyricType="1" LyricContent="[1000,500]Hi(1000,500)"/>';

	it('stores the QRC of the matching song', async () => {
		const { query_service } = await load();
		mocks.qq_search.mockResolvedValue([song({ mid: 'cover', interval: 240 }), song()]);
		mocks.qq_lyrics.mockResolvedValue({ format: 'QRC', text: QRC });
		expect(await query_service('QQMUSIC', q)).toMatchObject({ status: 'FOUND', versions: [{ format: 'QRC', sync_type: 'WORD', raw_content: QRC }] });
		expect(mocks.qq_search).toHaveBeenCalledWith('Song Artist', expect.anything());
		expect(mocks.qq_lyrics).toHaveBeenCalledWith('m1', expect.anything());
	});

	it('is NOT_FOUND without a match or for the instrumental placeholder', async () => {
		const { query_service } = await load();
		mocks.qq_search.mockResolvedValue([song({ title: 'Other' })]);
		expect((await query_service('QQMUSIC', q)).status).toBe('NOT_FOUND');
		expect(mocks.qq_lyrics).not.toHaveBeenCalled();
		mocks.qq_search.mockResolvedValue([song()]);
		mocks.qq_lyrics.mockResolvedValue({ format: 'LRC', text: '[00:00.00]此歌曲为没有填词的纯音乐，请您欣赏' });
		expect((await query_service('QQMUSIC', q)).status).toBe('NOT_FOUND');
	});
});

describe('query_service KUGOU', () => {
	const song = { hash: 'h1', songname: 'Song', singername: 'Artist、Other', album_name: 'Album', duration: 180 };
	const KRC = '[1000,500]<0,500,0>Hi';

	it('finds the song, picks a synced candidate and stores the KRC', async () => {
		const { query_service } = await load();
		mocks.kugou_songs.mockResolvedValue([song]);
		mocks.kugou_candidates.mockResolvedValue([{ id: 'c2', accesskey: 'k2', krctype: 2, score: 90, duration: 180_000 }, { id: 'c1', accesskey: 'k1', krctype: 1, score: 50, duration: 180_100 }]);
		mocks.kugou_download.mockResolvedValue({ format: 'KRC', text: KRC });
		expect(await query_service('KUGOU', q)).toMatchObject({ status: 'FOUND', versions: [{ format: 'KRC', sync_type: 'WORD', raw_content: KRC }] });
		expect(mocks.kugou_candidates).toHaveBeenCalledWith({ keyword: 'Artist、Other - Song', duration_ms: 180_000, hash: 'h1' }, expect.anything());
		expect(mocks.kugou_download).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'krc', expect.anything());
	});

	it('is NOT_FOUND without candidates', async () => {
		const { query_service } = await load();
		mocks.kugou_songs.mockResolvedValue([song]);
		mocks.kugou_candidates.mockResolvedValue([]);
		expect((await query_service('KUGOU', q)).status).toBe('NOT_FOUND');
		expect(mocks.kugou_download).not.toHaveBeenCalled();
	});
});

describe('query_service LRCLIB', () => {
	it('maps synced, plain and instrumental results', async () => {
		const { query_service } = await load();
		mocks.lrclib_get.mockResolvedValue({ syncedLyrics: '[00:01.00]<00:01.00>Hi', plainLyrics: 'Hi' });
		const found = await query_service('LRCLIB', q);
		expect(found.versions.map((v: { format: string; sync_type: string }) => [v.format, v.sync_type])).toEqual([['ELRC', 'WORD'], ['PLAIN', 'NONE']]);
		expect(mocks.lrclib_get).toHaveBeenCalledWith({ track_name: 'Song', artist_name: 'Artist', album_name: 'Album', duration: 180 }, {});
		mocks.lrclib_get.mockResolvedValue({ instrumental: true });
		expect((await query_service('LRCLIB', bare)).status).toBe('INSTRUMENTAL');
		expect(mocks.lrclib_get).toHaveBeenLastCalledWith({ track_name: 'Song', artist_name: 'Artist' }, {});
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

describe('query_service cooldowns', () => {
	it('skips a throttled service until its cooldown ends', async () => {
		const { query_service, cooldown_until } = await load();
		expect(cooldown_until('QQMUSIC')).toBeNull();
		mocks.qq_search.mockResolvedValue({ error: new Error('QQ Music: too many requests (search results withheld)') });
		const first = await query_service('QQMUSIC', q);
		expect(first.status).toBe('SKIPPED');
		const until = cooldown_until('QQMUSIC')!;
		expect(first.cooldown_until).toEqual(until);
		mocks.qq_search.mockClear();
		expect(await query_service('QQMUSIC', q)).toMatchObject({ status: 'SKIPPED', cooldown_until: until });
		expect(mocks.qq_search).not.toHaveBeenCalled();
		expect(cooldown_until('QQMUSIC', until.getTime() + 1)).toBeNull();
	});
});

describe('query_service timeouts', () => {
	it('gives up on a slow service', async () => {
		const { query_service } = await load();
		mocks.bini_search.mockReturnValue(new Promise(() => undefined));
		const out = await query_service('BINILYRICS', q, 20);
		expect(out).toMatchObject({ status: 'ERROR', error: 'timed out after 20ms' });
	});
});
