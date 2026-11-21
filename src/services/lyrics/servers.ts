import { BiniLyrics } from '@origin/binilyrics/binilyrics';
import type { BiniSearchHit } from '@origin/binilyrics/types';
import { KuGou } from '@origin/kugou/kugou';
import type { KuGouLyricsCandidate } from '@origin/kugou/types';
import { LRCLib } from '@origin/lrclib/lrclib';
import { LRCRed } from '@origin/lrcred/lrcred';
import { QQMusic } from '@origin/qqmusic/qqmusic';
import { Unison } from '@origin/unison/unison';
import { config } from '../../config';
import { durations_match, name_similarity } from '../../core/normalize';
import { logger } from '../../core/log';
import { kugou_version, lrclib_versions, qqmusic_version, ttml_version, unison_version } from './formats';
import type { LookupStatus, LyricsVersion, ServerService } from './types';

const log = logger('lyrics');

/** The same inputs go to every service. */
export interface LyricsQuery {
	title: string;
	artist: string;
	album: string | null;
	duration_s: number | null;
	/** lrc.red is keyed by ISRC; Unison also takes it. */
	isrc: string | null;
	/** Unison's fastest lookup. */
	youtube_id: string | null;
}

export interface ServiceOutcome {
	service: ServerService;
	status: LookupStatus;
	versions: LyricsVersion[];
	/** Known end of a service-wide cooldown; `retry_after` is never earlier. */
	cooldown_until?: Date | null;
	error?: string;
}

/** lib-origin returns `{ error }` values instead of throwing; some pass a plain `{ error: string }` through. */
export function error_message(value: unknown): string {
	if (typeof value !== 'object' || value === null || !('error' in value)) return String(value);
	const err = value.error;
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err !== null && 'message' in err) return String(err.message);
	return String(err);
}

const is_error = (value: unknown): value is { error: unknown } => typeof value === 'object' && value !== null && 'error' in value;

const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** An HTML page where JSON was expected: a block page or a gateway error, either way not worth retrying right away. */
const HTML_RESPONSE_COOLDOWN_MS = 10 * 60_000;

export interface ErrorClass { status: Extract<LookupStatus, 'NOT_FOUND' | 'ERROR' | 'SKIPPED'>; cooldown_ms?: number }

/** Maps a lib-origin error message to a lookup status. */
export function classify_error(message: string): ErrorClass {
	const m = message.toLowerCase();
	// Keywords only on the first line: later lines hold the request args (which include the track title).
	const head = m.split('\n')[0];
	if (head.includes('captcha')) return { status: 'SKIPPED', cooldown_ms: RATE_LIMIT_COOLDOWN_MS };
	// Unison is still resolving this one track: ask again later, without pausing the service.
	if (head.includes('lookup pending')) return { status: 'SKIPPED' };
	if (head.includes('unexpected token \'<\'') || head.includes('<html') || head.includes('<!doctype')) return { status: 'SKIPPED', cooldown_ms: HTML_RESPONSE_COOLDOWN_MS };
	if (/not ok \| (429|503)\b/u.test(m) || /status: (429|503)\b/u.test(m) || m.includes('ratelimitexceeded') || head.includes('too many requests')) {
		return { status: 'SKIPPED', cooldown_ms: RATE_LIMIT_COOLDOWN_MS };
	}
	if (/not ok \| 404\b/u.test(m) || /status: 404\b/u.test(m) || /status_code":? ?404\b/u.test(m)
		|| m.includes('tracknotfound') || ['not found', 'no results', 'no lyrics', 'no ttml', 'no matching track', 'failed to find', 'not a valid isrc'].some(k => head.includes(k))) {
		return { status: 'NOT_FOUND' };
	}
	return { status: 'ERROR' };
}

/** Bini search returns candidates; take the first that looks like this track (title, plus artist or duration). */
export function pick_bini_hit(hits: readonly BiniSearchHit[] | undefined, query: LyricsQuery): BiniSearchHit | null {
	for (const hit of hits ?? []) {
		if (!hit.lyricsUrl) continue;
		if (name_similarity(hit.track_name, query.title) < 0.8) continue;
		const artist_ok = name_similarity(hit.artist_name, query.artist) >= 0.8;
		const duration_ok = query.duration_s != null && typeof hit.duration === 'number' && durations_match(hit.duration * 1000, query.duration_s * 1000);
		if (artist_ok || duration_ok) return hit;
	}
	return null;
}

/** Service-wide cooldowns known to this process (rate limits, HTML block pages). */
const cooldowns = new Map<ServerService, number>();

export function cooldown_until(service: ServerService, now = Date.now()): Date | null {
	const until = cooldowns.get(service);
	return until !== undefined && until > now ? new Date(until) : null;
}

const fetch_opts = () => ({ fetch_opts: { abort_ms: config.LYRICS_SERVICE_TIMEOUT_MS } });

type Fetched = { status: 'FOUND' | 'NOT_FOUND' | 'INSTRUMENTAL'; versions: LyricsVersion[] } | { error: unknown };

async function fetch_bini(q: LyricsQuery): Promise<Fetched> {
	const search = await BiniLyrics.search({ track: q.title, artist: q.artist, ...(q.album ? { album: q.album } : {}), ...(q.duration_s == null ? {} : { duration: q.duration_s }) }, fetch_opts());
	if (is_error(search)) return search;
	const hit = pick_bini_hit(search.results, q);
	if (!hit) return { status: 'NOT_FOUND', versions: [] };
	// get_ttml, not get_lyrics: the raw TTML is stored even when parse_ttml would fail.
	const ttml = await BiniLyrics.get_ttml(hit.lyricsUrl, fetch_opts());
	if (typeof ttml !== 'string') return ttml;
	if (!ttml.trim()) return { status: 'NOT_FOUND', versions: [] };
	return { status: 'FOUND', versions: [ttml_version(ttml, hit.timing_type)] };
}

/** A catalog search result reduced to what matching needs. */
export interface CatalogHit<T> {
	title: string;
	artists: string[];
	duration_ms: number | null;
	item: T;
}

/**
 * First catalog hit that is this track: the title must match, a known duration must agree, and the artist
 * must match unless the duration already confirms it. Catalogs list covers and remixes under the same title.
 */
export function pick_catalog_hit<T>(hits: readonly CatalogHit<T>[], query: LyricsQuery): T | null {
	const query_ms = query.duration_s == null ? null : query.duration_s * 1000;
	for (const hit of hits) {
		if (name_similarity(hit.title, query.title) < 0.8) continue;
		const duration_known = query_ms != null && hit.duration_ms != null && hit.duration_ms > 0;
		if (duration_known && !durations_match(hit.duration_ms, query_ms)) continue;
		const artist_ok = query.artist !== '' && hit.artists.some(a => name_similarity(a, query.artist) >= 0.8);
		if (artist_ok || duration_known) return hit.item;
	}
	return null;
}

/** KuGou's lyrics candidates for one song: synced ones first, then its own score; a known duration must agree. */
export function pick_kugou_candidate(candidates: readonly KuGouLyricsCandidate[], duration_ms: number | null): KuGouLyricsCandidate | null {
	const fitting = candidates.filter(c => duration_ms == null || !c.duration || durations_match(c.duration, duration_ms));
	return [...fitting].sort((a, b) => Number(b.krctype === 1) - Number(a.krctype === 1) || b.score - a.score)[0] ?? null;
}

/** QQ Music and KuGou answer instrumentals with a "pure music, please enjoy" placeholder instead of lyrics. */
const PURE_MUSIC_RE = /纯音乐，请(?:您)?欣赏/u;
const NOT_FOUND: Fetched = { status: 'NOT_FOUND', versions: [] };

async function fetch_lrcred(q: LyricsQuery): Promise<Fetched> {
	if (!q.isrc) return NOT_FOUND;
	const song = await LRCRed.get_song(q.isrc, fetch_opts());
	if (is_error(song)) return song;
	// Model-synced files are left out, as Better Lyrics does.
	if (song.byModel === true || !song.source?.trim()) return NOT_FOUND;
	return { status: 'FOUND', versions: [ttml_version(song.source, song.level)] };
}

async function fetch_unison(q: LyricsQuery): Promise<Fetched> {
	const by_fields = () => Unison.get_lyrics({
		song: q.title, artist: q.artist || undefined, album: q.album ?? undefined, duration: q.duration_s ?? undefined, isrc: q.isrc ?? undefined
	}, fetch_opts());
	let found = q.youtube_id ? await Unison.get_lyrics({ v: q.youtube_id }, fetch_opts()) : await by_fields();
	// A video id lookup doesn't fall back to the other fields by itself.
	if (q.youtube_id && is_error(found) && classify_error(error_message(found)).status === 'NOT_FOUND') found = await by_fields();
	if (is_error(found)) return found;
	const version = unison_version(found);
	return version ? { status: 'FOUND', versions: [version] } : NOT_FOUND;
}

async function fetch_qqmusic(q: LyricsQuery): Promise<Fetched> {
	const songs = await QQMusic.search_songs(`${q.title} ${q.artist}`.trim(), fetch_opts());
	if (is_error(songs)) return songs;
	const song = pick_catalog_hit(songs.map(s => ({ title: s.title, artists: s.singer.map(a => a.name), duration_ms: s.interval * 1000, item: s })), q);
	if (!song) return NOT_FOUND;
	const lyrics = await QQMusic.get_lyrics(song.mid, fetch_opts());
	if (is_error(lyrics)) return lyrics;
	const version = PURE_MUSIC_RE.test(lyrics.text) ? null : qqmusic_version(lyrics);
	return version ? { status: 'FOUND', versions: [version] } : NOT_FOUND;
}

async function fetch_kugou(q: LyricsQuery): Promise<Fetched> {
	const songs = await KuGou.search_songs(`${q.title} ${q.artist}`.trim(), fetch_opts());
	if (is_error(songs)) return songs;
	const song = pick_catalog_hit(songs.map(s => ({ title: s.songname, artists: s.singername.split('、'), duration_ms: s.duration * 1000, item: s })), q);
	if (!song) return NOT_FOUND;
	const candidates = await KuGou.search_lyrics({ keyword: `${song.singername} - ${song.songname}`, duration_ms: song.duration * 1000, hash: song.hash }, fetch_opts());
	if (is_error(candidates)) return candidates;
	const candidate = pick_kugou_candidate(candidates, song.duration * 1000);
	if (!candidate) return NOT_FOUND;
	const lyrics = await KuGou.download_lyrics(candidate, 'krc', fetch_opts());
	if (is_error(lyrics)) return lyrics;
	const version = PURE_MUSIC_RE.test(lyrics.text) ? null : kugou_version(lyrics);
	return version ? { status: 'FOUND', versions: [version] } : NOT_FOUND;
}

async function fetch_lrclib(q: LyricsQuery): Promise<Fetched> {
	const credentials = { ...(config.LRCLIB_APP_ID ? { app_id: config.LRCLIB_APP_ID } : {}), ...(config.LRCLIB_API_KEY ? { api_key: config.LRCLIB_API_KEY } : {}) };
	const params = { track_name: q.title, artist_name: q.artist, ...(q.duration_s == null ? {} : { duration: Math.round(q.duration_s) }) };
	let result = await LRCLib.get(q.album ? { ...params, album_name: q.album } : params, credentials);
	// LRCLib only matches album_name exactly, so an entry with another (or no) album needs asking without it
	if (q.album && is_error(result) && classify_error(error_message(result)).status === 'NOT_FOUND') result = await LRCLib.get(params, credentials);
	if (is_error(result)) return result;
	const versions = lrclib_versions(result);
	if (result.instrumental && versions.length === 0) return { status: 'INSTRUMENTAL', versions };
	return { status: versions.length > 0 ? 'FOUND' : 'NOT_FOUND', versions };
}

const FETCHERS: Record<ServerService, (q: LyricsQuery) => Promise<Fetched>> = {
	BINILYRICS: fetch_bini,
	LRCLIB: fetch_lrclib,
	LRCRED: fetch_lrcred,
	UNISON: fetch_unison,
	QQMUSIC: fetch_qqmusic,
	KUGOU: fetch_kugou
};

/** Queries one service with its own timeout; never throws. A service in cooldown is not called (`SKIPPED`). */
export async function query_service(service: ServerService, q: LyricsQuery, timeout_ms = config.LYRICS_SERVICE_TIMEOUT_MS): Promise<ServiceOutcome> {
	// Integration tests: no outbound calls, every server service answers "not found" (config refuses this in production).
	if (config.LYRICS_SERVERS_STUB === 'not_found') return { service, status: 'NOT_FOUND', versions: [] };
	const cooling = cooldown_until(service);
	if (cooling) return { service, status: 'SKIPPED', versions: [], cooldown_until: cooling };

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<Fetched>((resolve) => {
		timer = setTimeout(() => { resolve({ error: new Error(`timed out after ${timeout_ms}ms`) }); }, timeout_ms);
	});
	let fetched: Fetched;
	try {
		fetched = await Promise.race([FETCHERS[service](q), timeout]);
	} catch (err) {
		fetched = { error: err };
	} finally {
		clearTimeout(timer);
	}

	if (!('error' in fetched)) return { service, status: fetched.status, versions: fetched.versions };
	const message = error_message(fetched);
	const cls = classify_error(message);
	if (cls.cooldown_ms) cooldowns.set(service, Math.max(cooldowns.get(service) ?? 0, Date.now() + cls.cooldown_ms));
	if (cls.status !== 'NOT_FOUND') log.warn(`${service} ${cls.status}`, { title: q.title, artist: q.artist, error: message.split('\n')[0] });
	return { service, status: cls.status, versions: [], cooldown_until: cooldown_until(service), error: message.split('\n')[0] };
}
