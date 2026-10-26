import type { ResponseError } from '@common/types';
import { ITunes } from '@origin/itunes/itunes';
import type { ITunesArtist, ITunesCollection, ITunesResult, ITunesTrack } from '@origin/itunes/itunes';
import { config } from '../../config';
import { logger } from '../../core/log';
import { normalize_name } from '../../core/normalize';
import { classify_error, decide, DEFAULT_BACKOFF, initial_backoff_state } from './backoff';
import { ITUNES_LOOKUP_LIMIT } from './batching';

const log = logger('itunes');

/** The item can't be fetched (other 4xx, or retries exhausted): drop it and record ERROR. */
export class ITunesDropError extends Error {}
/** The service is stopping; abandon the item without recording anything. */
export class ITunesStoppedError extends Error {}

const is_error = (v: unknown): v is ResponseError => typeof v === 'object' && v !== null && 'error' in v;

/** Small TTL map so a burst of tracks by one artist costs one search and one albums lookup. */
export class TtlCache<K, V> {
	private map = new Map<K, { value: V; expires: number }>();
	constructor(private readonly ttl_ms: number, private readonly max_entries = 2000) {}

	get(key: K): V | undefined {
		const hit = this.map.get(key);
		if (!hit) return undefined;
		if (hit.expires <= Date.now()) {
			this.map.delete(key);
			return undefined;
		}
		return hit.value;
	}

	set(key: K, value: V) {
		if (this.map.size >= this.max_entries) {
			const now = Date.now();
			for (const [k, v] of this.map) if (v.expires <= now) this.map.delete(k);
			while (this.map.size >= this.max_entries) this.map.delete(this.map.keys().next().value as K);
		}
		this.map.set(key, { value, expires: Date.now() + this.ttl_ms });
	}

	clear() { this.map.clear(); }
}

const CACHE_TTL_MS = 10 * 60_000;

export interface ArtistAlbums { artist: ITunesArtist | null; albums: ITunesCollection[] }
export interface AlbumTracks { collection: ITunesCollection | null; tracks: ITunesTrack[] }

/**
 * The single HTTP gate: one request at a time, spaced by `ITUNES_REQUEST_INTERVAL_MS`,
 * with the backoff decision table applied. A rate-limited request is retried until it succeeds, which
 * keeps the whole queue paused because the queue awaits it.
 */
export class ITunesClient {
	private last_request_at = 0;
	private backoff = initial_backoff_state();
	private stopped = false;
	private wake: (() => void) | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	readonly artist_search_cache = new TtlCache<string, ITunesArtist[]>(CACHE_TTL_MS);
	readonly artist_albums_cache = new TtlCache<number, ArtistAlbums>(CACHE_TTL_MS);
	readonly album_tracks_cache = new TtlCache<number, AlbumTracks>(CACHE_TTL_MS, 5000);

	start() { this.stopped = false; }

	stop() {
		this.stopped = true;
		this.wake?.();
	}

	private async sleep(ms: number) {
		if (ms <= 0) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
			this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
		});
		if (this.stopped) throw new ITunesStoppedError('stopped');
	}

	/** Runs `fn` through the gate; requests are serialized even if callers overlap. */
	request<T>(what: string, fn: () => Promise<ResponseError | T>): Promise<T> {
		const run = this.chain.then(() => this.run(what, fn), () => this.run(what, fn));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async run<T>(what: string, fn: () => Promise<ResponseError | T>): Promise<T> {
		let transient_attempts = 0;
		for (;;) {
			if (this.stopped) throw new ITunesStoppedError('stopped');
			await this.sleep(this.last_request_at + config.ITUNES_REQUEST_INTERVAL_MS - Date.now());
			this.last_request_at = Date.now();
			let result: ResponseError | T;
			try {
				result = await fn();
			} catch (err) {
				result = { error: err instanceof Error ? err : new Error(String(err)) };
			}
			const outcome = is_error(result) ? classify_error(result) : { kind: 'ok' as const };
			if (outcome.kind === 'transient') transient_attempts++;
			const decision = decide(outcome, this.backoff, transient_attempts, DEFAULT_BACKOFF);
			if (decision.action === 'done') return result as T;
			if (decision.action === 'drop') throw new ITunesDropError(`${what}: ${decision.reason}`);
			log.warn(`${what}: ${decision.reason}, retrying in ${Math.round(decision.delay_ms / 1000)}s`, outcome);
			await this.sleep(decision.delay_ms);
		}
	}

	private fetch_opts() {
		return { fetch_opts: { abort_ms: config.ITUNES_ABORT_MS } };
	}

	async search_artists(artist_name: string): Promise<ITunesArtist[]> {
		const key = normalize_name(artist_name);
		const cached = this.artist_search_cache.get(key);
		if (cached) return cached;
		const res = await this.request(`search artist "${artist_name}"`, () => ITunes.search({
			term: artist_name, media: 'music', entity: 'musicArtist', country: config.ITUNES_COUNTRY, limit: 25, ...this.fetch_opts()
		}));
		const artists = res.results.filter((r): r is ITunesArtist => r.wrapperType === 'artist');
		this.artist_search_cache.set(key, artists);
		return artists;
	}

	async artist_albums(artist_id: number): Promise<ArtistAlbums> {
		const cached = this.artist_albums_cache.get(artist_id);
		if (cached) return cached;
		const res = await this.request(`albums of artist ${artist_id}`, () => ITunes.lookup({
			id: artist_id, entity: 'album', limit: ITUNES_LOOKUP_LIMIT, country: config.ITUNES_COUNTRY, ...this.fetch_opts()
		}));
		const results = res.results as ITunesResult[];
		const value: ArtistAlbums = {
			artist: (results.find(r => r.wrapperType === 'artist' && r.artistId === artist_id) as ITunesArtist | undefined) ?? null,
			albums: results.filter((r): r is ITunesCollection => r.wrapperType === 'collection' && (r as ITunesCollection).collectionId != null)
		};
		this.artist_albums_cache.set(artist_id, value);
		return value;
	}

	/** Album-track lookup for one batch of collection ids; every collection's result is cached. */
	async album_tracks(collection_ids: readonly number[]): Promise<Map<number, AlbumTracks>> {
		const out = new Map<number, AlbumTracks>();
		const missing: number[] = [];
		for (const id of collection_ids) {
			const cached = this.album_tracks_cache.get(id);
			if (cached) out.set(id, cached);
			else missing.push(id);
		}
		if (missing.length === 0) return out;
		const res = await this.request(`tracks of ${missing.length} album(s)`, () => ITunes.lookup({
			id: missing, entity: 'song', limit: ITUNES_LOOKUP_LIMIT, country: config.ITUNES_COUNTRY, ...this.fetch_opts()
		}));
		for (const id of missing) out.set(id, { collection: null, tracks: [] });
		for (const r of res.results as ITunesResult[]) {
			if (r.wrapperType === 'collection') {
				const c = r as ITunesCollection;
				const entry = c.collectionId != null ? out.get(c.collectionId) : undefined;
				if (entry) entry.collection = c;
			} else if (r.wrapperType === 'track') {
				const t = r as ITunesTrack;
				const entry = t.collectionId != null ? out.get(t.collectionId) : undefined;
				if (entry) entry.tracks.push(t);
			}
		}
		for (const id of missing) this.album_tracks_cache.set(id, out.get(id)!);
		return out;
	}

	/** Plain `lookup?id=...` for known ids. At most 200 ids per call. */
	async lookup_ids(ids: readonly string[]): Promise<ITunesResult[]> {
		const res = await this.request(`lookup ${ids.length} id(s)`, () => ITunes.lookup({
			id: [...ids], limit: ITUNES_LOOKUP_LIMIT, country: config.ITUNES_COUNTRY, ...this.fetch_opts()
		}));
		return res.results;
	}
}
