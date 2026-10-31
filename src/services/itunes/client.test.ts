import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const itunes = vi.hoisted(() => ({ search: vi.fn(), lookup: vi.fn() }));
vi.mock('@origin/itunes/itunes', () => ({ ITunes: itunes }));
vi.mock('../../config', () => ({ config: { ITUNES_REQUEST_INTERVAL_MS: 0, ITUNES_ABORT_MS: 1234, ITUNES_COUNTRY: 'US' } }));

import { ITunesClient, ITunesDropError, ITunesStoppedError, TtlCache } from './client';

const http_error = (status: number, retry_after?: string) => ({ error: new Error(`response NOT ok | ${status}: x`), retry_after });
const artist = (artistId: number, name = 'A') => ({ wrapperType: 'artist', artistId, artistName: name });
const collection = (collectionId: number, artistId = 1) => ({ wrapperType: 'collection', collectionId, artistId, collectionName: `C${collectionId}` });
const track = (trackId: number, collectionId: number) => ({ wrapperType: 'track', trackId, collectionId, trackName: `T${trackId}` });

describe('TtlCache', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it('returns a value until it expires', () => {
		const cache = new TtlCache<string, number>(1000);
		cache.set('a', 1);
		expect(cache.get('a')).toBe(1);
		vi.advanceTimersByTime(999);
		expect(cache.get('a')).toBe(1);
		vi.advanceTimersByTime(1);
		expect(cache.get('a')).toBeUndefined();
	});
	it('returns undefined for unknown keys and after clear', () => {
		const cache = new TtlCache<string, number>(1000);
		expect(cache.get('x')).toBeUndefined();
		cache.set('x', 1);
		cache.clear();
		expect(cache.get('x')).toBeUndefined();
	});
	it('drops expired entries first when full', () => {
		const cache = new TtlCache<string, number>(1000, 2);
		cache.set('old', 1);
		vi.advanceTimersByTime(500);
		cache.set('mid', 2);
		vi.advanceTimersByTime(600);
		cache.set('new', 3);
		expect(cache.get('old')).toBeUndefined();
		expect(cache.get('mid')).toBe(2);
		expect(cache.get('new')).toBe(3);
	});
	it('evicts the oldest entry when full and nothing expired', () => {
		const cache = new TtlCache<string, number>(1000, 2);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toBe(2);
		expect(cache.get('c')).toBe(3);
	});
});

describe('ITunesClient.request', () => {
	let client: ITunesClient;
	beforeEach(() => {
		vi.useFakeTimers();
		itunes.search.mockReset();
		itunes.lookup.mockReset();
		client = new ITunesClient();
		client.start();
	});
	afterEach(() => { vi.useRealTimers(); });

	it('returns the result of a successful call', async () => {
		await expect(client.request('x', async () => ({ ok: 1 }))).resolves.toEqual({ ok: 1 });
	});

	it('serializes overlapping callers', async () => {
		const order: string[] = [];
		const slow = client.request('a', async () => {
			order.push('a:start');
			await new Promise(r => setTimeout(r, 100));
			order.push('a:end');
			return 'a';
		});
		const fast = client.request('b', async () => { order.push('b'); return 'b'; });
		await vi.advanceTimersByTimeAsync(200);
		await expect(Promise.all([slow, fast])).resolves.toEqual(['a', 'b']);
		expect(order).toEqual(['a:start', 'a:end', 'b']);
	});

	it('keeps serving requests after one was dropped', async () => {
		await expect(client.request('bad', async () => http_error(404))).rejects.toBeInstanceOf(ITunesDropError);
		await expect(client.request('good', async () => 'fine')).resolves.toBe('fine');
	});

	it('retries a rate-limited request until it succeeds', async () => {
		const fn = vi.fn().mockResolvedValueOnce(http_error(429)).mockResolvedValueOnce(http_error(403)).mockResolvedValueOnce('done');
		const p = client.request('x', fn);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await expect(p).resolves.toBe('done');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('honours Retry-After', async () => {
		const fn = vi.fn().mockResolvedValueOnce(http_error(429, '5')).mockResolvedValueOnce('ok');
		const p = client.request('x', fn);
		await vi.advanceTimersByTimeAsync(4900);
		expect(fn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(200);
		await expect(p).resolves.toBe('ok');
	});

	it('retries 5xx and thrown errors, then succeeds', async () => {
		const fn = vi.fn().mockResolvedValueOnce(http_error(503)).mockRejectedValueOnce(new Error('socket hang up')).mockRejectedValueOnce('boom').mockResolvedValueOnce('ok');
		const p = client.request('x', fn);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(p).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(4);
	});

	it('drops after four transient failures', async () => {
		const fn = vi.fn().mockResolvedValue(http_error(500));
		const p = client.request('lookup', fn);
		const assertion = expect(p).rejects.toThrow(/lookup: gave up after 4 attempts/);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await assertion;
		expect(fn).toHaveBeenCalledTimes(4);
	});

	it('drops other 4xx without retrying', async () => {
		const fn = vi.fn().mockResolvedValue(http_error(400));
		await expect(client.request('x', fn)).rejects.toThrow('x: HTTP 400');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('rejects with a stopped error when stopped before the call', async () => {
		client.stop();
		const fn = vi.fn();
		await expect(client.request('x', fn)).rejects.toBeInstanceOf(ITunesStoppedError);
		expect(fn).not.toHaveBeenCalled();
	});

	it('cuts a backoff sleep short on stop', async () => {
		const fn = vi.fn().mockResolvedValue(http_error(429));
		const p = client.request('x', fn);
		const assertion = expect(p).rejects.toBeInstanceOf(ITunesStoppedError);
		await vi.advanceTimersByTimeAsync(1000);
		client.stop();
		await assertion;
		expect(fn).toHaveBeenCalledTimes(1);
		client.start();
		await expect(client.request('y', async () => 'again')).resolves.toBe('again');
	});
});

describe('ITunesClient request spacing', () => {
	it('waits the configured interval between requests', async () => {
		vi.resetModules();
		vi.doMock('../../config', () => ({ config: { ITUNES_REQUEST_INTERVAL_MS: 1000, ITUNES_ABORT_MS: 1, ITUNES_COUNTRY: 'US' } }));
		vi.useFakeTimers();
		try {
			const { ITunesClient: Spaced } = await import('./client.js');
			const c = new Spaced();
			c.start();
			const fn = vi.fn().mockResolvedValue('ok');
			await c.request('a', fn);
			const second = c.request('b', fn);
			await vi.advanceTimersByTimeAsync(900);
			expect(fn).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(200);
			await second;
			expect(fn).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
			vi.doUnmock('../../config');
		}
	});
});

describe('ITunesClient queries', () => {
	let client: ITunesClient;
	beforeEach(() => {
		itunes.search.mockReset();
		itunes.lookup.mockReset();
		client = new ITunesClient();
		client.start();
	});

	it('search_artists keeps only artists, passes options and caches by normalized name', async () => {
		itunes.search.mockResolvedValue({ results: [artist(1), { wrapperType: 'collection', collectionId: 5 }, artist(2)] });
		const first = await client.search_artists('Daft Punk');
		expect(first.map(a => a.artistId)).toEqual([1, 2]);
		expect(itunes.search).toHaveBeenCalledWith(expect.objectContaining({
			term: 'Daft Punk', entity: 'musicArtist', country: 'US', limit: 25, fetch_opts: { abort_ms: 1234 }
		}));
		await client.search_artists('daft  punk!');
		expect(itunes.search).toHaveBeenCalledTimes(1);
	});

	it('search_artists propagates a dropped request', async () => {
		itunes.search.mockResolvedValue(http_error(404));
		await expect(client.search_artists('x')).rejects.toBeInstanceOf(ITunesDropError);
	});

	it('artist_albums splits the artist from its collections and caches', async () => {
		itunes.lookup.mockResolvedValue({ results: [artist(1, 'Me'), artist(9), collection(10), { wrapperType: 'collection' }, collection(11)] });
		const res = await client.artist_albums(1);
		expect(res.artist?.artistName).toBe('Me');
		expect(res.albums.map(a => a.collectionId)).toEqual([10, 11]);
		expect(itunes.lookup).toHaveBeenCalledWith(expect.objectContaining({ id: 1, entity: 'album' }));
		await client.artist_albums(1);
		expect(itunes.lookup).toHaveBeenCalledTimes(1);
	});

	it('artist_albums returns a null artist when the lookup has none', async () => {
		itunes.lookup.mockResolvedValue({ results: [collection(10)] });
		expect((await client.artist_albums(1)).artist).toBeNull();
	});

	it('album_tracks groups tracks per collection and only fetches uncached ids', async () => {
		itunes.lookup.mockResolvedValueOnce({ results: [collection(10), track(100, 10), track(101, 10), collection(11), track(110, 11), track(1, 999), { wrapperType: 'track', trackId: 2 }] });
		const first = await client.album_tracks([10, 11, 12]);
		expect(first.get(10)?.collection?.collectionId).toBe(10);
		expect(first.get(10)?.tracks.map(t => t.trackId)).toEqual([100, 101]);
		expect(first.get(11)?.tracks).toHaveLength(1);
		expect(first.get(12)).toEqual({ collection: null, tracks: [] });
		expect(itunes.lookup).toHaveBeenCalledWith(expect.objectContaining({ id: [10, 11, 12], entity: 'song' }));

		const second = await client.album_tracks([10, 12]);
		expect([...second.keys()]).toEqual([10, 12]);
		expect(itunes.lookup).toHaveBeenCalledTimes(1);

		itunes.lookup.mockResolvedValueOnce({ results: [collection(13)] });
		await client.album_tracks([10, 13]);
		expect(itunes.lookup).toHaveBeenLastCalledWith(expect.objectContaining({ id: [13] }));
	});

	it('lookup_ids returns the raw results', async () => {
		itunes.lookup.mockResolvedValue({ results: [artist(1)] });
		await expect(client.lookup_ids(['1', '2'])).resolves.toEqual([artist(1)]);
		expect(itunes.lookup).toHaveBeenCalledWith(expect.objectContaining({ id: ['1', '2'] }));
	});
});
