import { BiniLyrics } from '@origin/binilyrics/binilyrics';
import type { BiniSearchHit } from '@origin/binilyrics/types';
import { GoLyrics } from '@origin/golyrics/golyrics';
import { LRCLib } from '@origin/lrclib/lrclib';
import { Musixmatch } from '@origin/musixmatch/musixmatch';
import { config } from '../../config';
import { durations_match, name_similarity } from '../../core/normalize';
import { logger } from '../../core/log';
import { lrclib_versions, musixmatch_versions, ttml_version } from './formats';
import type { LookupStatus, LyricsVersion, ServerService } from './types';

const log = logger('lyrics');

/** The same inputs go to every service. */
export interface LyricsQuery {
	title: string;
	artist: string;
	album: string | null;
	duration_s: number | null;
}

export interface ServiceOutcome {
	service: ServerService;
	status: LookupStatus;
	versions: LyricsVersion[];
	/** Known end of a service-wide cooldown; `retry_after` is never earlier. */
	cooldown_until?: Date | null;
	error?: string;
}

/** lib-origin returns `{ error }` values instead of throwing; GoLyrics may pass a plain `{ error: string }` through. */
export function error_message(value: unknown): string {
	if (typeof value !== 'object' || value === null || !('error' in value)) return String(value);
	const err = value.error;
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err !== null && 'message' in err) return String(err.message);
	return String(err);
}

const is_error = (value: unknown): value is { error: unknown } => typeof value === 'object' && value !== null && 'error' in value;

const MUSIXMATCH_CAPTCHA_COOLDOWN_MS = 2 * 60 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export interface ErrorClass { status: Extract<LookupStatus, 'NOT_FOUND' | 'ERROR' | 'SKIPPED'>; cooldown_ms?: number }

/** Maps a lib-origin error message to a lookup status. */
export function classify_error(service: ServerService, message: string): ErrorClass {
	const m = message.toLowerCase();
	// Keywords only on the first line: later lines hold the request args (which include the track title).
	const head = m.split('\n')[0];
	if (head.includes('captcha')) return { status: 'SKIPPED', cooldown_ms: service === 'MUSIXMATCH' ? MUSIXMATCH_CAPTCHA_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS };
	if (/not ok \| (429|503)\b/u.test(m) || /status: (429|503)\b/u.test(m) || m.includes('ratelimitexceeded') || head.includes('too many requests')) {
		return { status: 'SKIPPED', cooldown_ms: RATE_LIMIT_COOLDOWN_MS };
	}
	if (/not ok \| 404\b/u.test(m) || /status: 404\b/u.test(m) || /status_code":? ?404\b/u.test(m)
		|| m.includes('tracknotfound') || ['not found', 'no results', 'no ttml', 'no matching track', 'placeholder track', 'failed to find'].some(k => head.includes(k))) {
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

/** Service-wide cooldowns known to this process (Musixmatch captcha, LRCLib `Retry-After`). */
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

async function fetch_golyrics(q: LyricsQuery): Promise<Fetched> {
	const ttml = await GoLyrics.get_ttml({ song: q.title, artist: q.artist, ...(q.album ? { album: q.album } : {}), ...(q.duration_s == null ? {} : { duration: q.duration_s }) }, fetch_opts());
	if (typeof ttml !== 'string') return ttml;
	return { status: 'FOUND', versions: [ttml_version(ttml)] };
}

function macro_body<T>(call: { message: { body: T | [] | '' } } | undefined): T | undefined {
	const body = call?.message.body;
	return body === undefined || Array.isArray(body) || body === '' ? undefined : body;
}

const PLACEHOLDER_TRACK_ID = 115264642;

/**
 * Uses the macro call directly instead of `find_lyrics`, which JSON-parses the richsync body:
 * `richsync_body`, `subtitle_body` and `lyrics_body` are kept exactly as returned.
 */
async function fetch_musixmatch(q: LyricsQuery): Promise<Fetched> {
	const params = { q_track: q.title, q_artist: q.artist, ...(q.album ? { q_album: q.album } : {}), ...(q.duration_s == null ? {} : { q_duration: q.duration_s }) };
	const macro = await Musixmatch.get_macro_subtitles(params, fetch_opts());
	if (is_error(macro)) return macro;
	const track = macro_body(macro.macro_calls['matcher.track.get'])?.track;
	if (track === undefined || track.track_id === PLACEHOLDER_TRACK_ID) return { status: 'NOT_FOUND', versions: [] };
	let richsync_body = macro_body(macro.macro_calls['track.richsync.get'])?.richsync.richsync_body;
	if (!richsync_body && track.has_richsync === 1) {
		// lib-origin only exposes the parsed lines here; re-serializing keeps the same data.
		const lines = await Musixmatch.get_richsync(track.track_id, q.duration_s ?? undefined, fetch_opts());
		if (!is_error(lines)) richsync_body = JSON.stringify(lines);
	}
	const versions = musixmatch_versions({
		richsync_body,
		subtitle_body: macro_body(macro.macro_calls['track.subtitles.get'])?.subtitle_list[0]?.subtitle.subtitle_body,
		lyrics_body: macro_body(macro.macro_calls['track.lyrics.get'])?.lyrics.lyrics_body
	});
	return { status: versions.length > 0 ? 'FOUND' : 'NOT_FOUND', versions };
}

async function fetch_lrclib(q: LyricsQuery): Promise<Fetched> {
	const result = await LRCLib.get({ track_name: q.title, artist_name: q.artist, ...(q.album ? { album_name: q.album } : {}), ...(q.duration_s == null ? {} : { duration: Math.round(q.duration_s) }) });
	if (is_error(result)) return result;
	const versions = lrclib_versions(result);
	if (result.instrumental && versions.length === 0) return { status: 'INSTRUMENTAL', versions };
	return { status: versions.length > 0 ? 'FOUND' : 'NOT_FOUND', versions };
}

const FETCHERS: Record<ServerService, (q: LyricsQuery) => Promise<Fetched>> = {
	BINILYRICS: fetch_bini,
	GOLYRICS: fetch_golyrics,
	MUSIXMATCH: fetch_musixmatch,
	LRCLIB: fetch_lrclib
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
	const cls = classify_error(service, message);
	if (cls.cooldown_ms) cooldowns.set(service, Math.max(cooldowns.get(service) ?? 0, Date.now() + cls.cooldown_ms));
	if (cls.status !== 'NOT_FOUND') log.warn(`${service} ${cls.status}`, { title: q.title, artist: q.artist, error: message.split('\n')[0] });
	return { service, status: cls.status, versions: [], cooldown_until: cooldown_until(service), error: message.split('\n')[0] };
}
