/**
 * `GET /search`. Candidates come from indexed SQL (trigram matches on the searched column, artists by
 * exact name key, service ids from links), then every candidate is ranked here: exact, prefix, contains, then
 * trigram similarity, ties broken by total plays.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { all_queries } from '../../db';
import type { Executor } from '../../db';
import {
	album_tracks_table, albums_table, artist_albums_table, artists_table, playlists_table, service_ids_table, track_plays_table,
	tracks_artists_table, tracks_table, user_tracks_table
} from '../../db/schema';
import {
	normalize_applemusic_id, normalize_isrc, normalize_soundcloud_permalink, normalize_spotify_id, normalize_youtube_id
} from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';

export const SEARCH_TYPES = ['track', 'album', 'artist', 'playlist'] as const;
export type SearchType = typeof SEARCH_TYPES[number];
export type SearchScope = 'global' | 'library';

/** Candidates fetched per source; results are only paged within these. */
const CANDIDATES_PER_SOURCE = 300;
/** Longest run of query words tried as an artist name ("tyler the creator"). */
const MAX_ARTIST_WORDS = 4;

/** Same folding as SQL `illusi_search_text`: lowercase, accents removed. */
export function search_text(value: string): string {
	return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** pg_trgm's trigram set: each alphanumeric word padded with two leading spaces and one trailing. */
export function trigrams(value: string): Set<string> {
	const out = new Set<string>();
	for (const word of search_text(value).split(/[^\p{L}\p{N}]+/u)) {
		if (!word) continue;
		const padded = `  ${word} `;
		for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
	}
	return out;
}

/** pg_trgm `similarity()`: shared trigrams over all trigrams. */
export function trigram_similarity(a: string, b: string): number {
	const ta = trigrams(a);
	const tb = trigrams(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let shared = 0;
	for (const t of ta) if (tb.has(t)) shared++;
	return shared / (ta.size + tb.size - shared);
}

/** Collapses whitespace after folding, so "  Hotline   Bling" and "hotline bling" compare equal. */
function folded(value: string): string {
	return search_text(value).replace(/\s+/gu, ' ').trim();
}

/** Best score of `query` against any of `texts`: exact 3, prefix 2, contains 1, otherwise trigram similarity (< 1). */
export function match_score(query: string, texts: readonly string[]): number {
	const q = folded(query);
	let best = 0;
	for (const text of texts) {
		const t = folded(text);
		if (!t) continue;
		const score = t === q ? 3 : t.startsWith(q) ? 2 : t.includes(q) ? 1 : trigram_similarity(q, t) * 0.99;
		if (score > best) best = score;
	}
	return best;
}

/** Contiguous runs of 1..MAX_ARTIST_WORDS query words, each a possible artist name. */
export function artist_name_candidates(query: string): string[] {
	const words = query.trim().split(/\s+/u).filter(Boolean);
	const out = new Set<string>();
	for (let n = 1; n <= Math.min(MAX_ARTIST_WORDS, words.length); n++) {
		for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
	}
	return [...out];
}

export interface ServiceIdQuery { column: ServiceIdColumn; value: string }

function url_of(value: string): URL | null {
	if (!/^[a-z]+:\/\//iu.test(value) && !/^(?:www\.|m\.|music\.|open\.)?[a-z0-9-]+\.[a-z]{2,}\//iu.test(value)) return null;
	try {
		return new URL(value.includes('://') ? value : `https://${value}`);
	} catch {
		return null;
	}
}

/**
 * A service id when `query` is a recognisable link or ISRC. Bare ids are only accepted where they can't be
 * mistaken for words (Spotify URIs, ISRCs); everything else must be a link.
 */
export function detect_service_id(query: string): ServiceIdQuery | null {
	const q = query.trim();
	if (/^spotify:(?:track|album|artist):/u.test(q)) {
		const id = normalize_spotify_id(q);
		return id ? { column: 'spotify_id', value: id } : null;
	}
	const isrc = /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/u.test(q) ? normalize_isrc(q) : null;
	if (isrc) return { column: 'isrc', value: isrc };

	const url = url_of(q);
	if (!url) return null;
	const host = url.hostname.toLowerCase().replace(/^www\./u, '');
	if (host.endsWith('spotify.com')) {
		const id = normalize_spotify_id(q);
		return id ? { column: 'spotify_id', value: id } : null;
	}
	if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
		const id = normalize_youtube_id(q);
		return id ? { column: 'youtube_id', value: id } : null;
	}
	if (host.endsWith('soundcloud.com')) {
		const permalink = normalize_soundcloud_permalink(q);
		return permalink ? { column: 'soundcloud_permalink', value: permalink } : null;
	}
	if (host.endsWith('music.apple.com') || host.endsWith('itunes.apple.com')) {
		const id = normalize_applemusic_id(q);
		return id ? { column: 'applemusic_id', value: id } : null;
	}
	const numeric = /\/(?:track|album|artist)\/(\d+)/u.exec(url.pathname)?.[1];
	if (numeric && host.endsWith('deezer.com')) return { column: 'deezer_id', value: numeric };
	if (numeric && host.endsWith('tidal.com')) return { column: 'tidal_id', value: numeric };
	return null;
}

export interface Candidate {
	id: string;
	/** Texts the query is ranked against */
	texts: string[];
	plays: number;
	/** Found through a service id link; always ranked first */
	linked: boolean;
}

/** Ranked ids: linked first, then by score, plays, first text, id. Candidates scoring 0 are dropped. */
export function rank_candidates(query: string, candidates: readonly Candidate[]): string[] {
	const merged = new Map<string, Candidate>();
	for (const c of candidates) {
		const existing = merged.get(c.id);
		if (!existing) merged.set(c.id, { ...c, texts: [...c.texts] });
		else {
			existing.texts.push(...c.texts);
			existing.linked ||= c.linked;
			existing.plays = Math.max(existing.plays, c.plays);
		}
	}
	return [...merged.values()]
		.map(c => ({ c, score: c.linked ? Infinity : match_score(query, c.texts) }))
		.filter(r => r.score > 0)
		.sort((a, b) => b.score - a.score || b.c.plays - a.c.plays || (a.c.texts[0] ?? '').localeCompare(b.c.texts[0] ?? '') || a.c.id.localeCompare(b.c.id))
		.map(r => r.c.id);
}

const like_escape = (value: string) => value.replace(/[\\%_]/gu, m => `\\${m}`);

/** Indexed trigram or substring match of `illusi_search_text(column)` against the query. */
function text_matches(column: SQL | Parameters<typeof eq>[0], query: string): SQL {
	return sql`(illusi_search_text(${column}) % illusi_search_text(${query}) or illusi_search_text(${column}) like '%' || illusi_search_text(${like_escape(query)}) || '%')`;
}

/** Artist ids whose name key equals any run of query words (uses `artists_name_key_idx`). */
function artists_named_in(query: string): SQL {
	const names = artist_name_candidates(query);
	if (names.length === 0) return sql`false`;
	return sql`illusi_name_key(${artists_table.name}) in (select illusi_name_key(n) from unnest(array[${sql.join(names.map(n => sql`${n}`), sql`, `)}]::text[]) n)`;
}

const total_plays = sql<number>`(select count(*) from ${track_plays_table} where ${track_plays_table.track_id} = ${tracks_table.id})`.mapWith(Number);

function in_library(user_id: string): SQL {
	return sql`exists (select 1 from ${user_tracks_table} where ${user_tracks_table.user_id} = ${user_id} and ${user_tracks_table.track_id} = ${tracks_table.id} and not ${user_tracks_table.deleted})`;
}

async function linked_ids(ex: Executor, link: ServiceIdQuery | null): Promise<string[]> {
	if (!link) return [];
	const column = service_ids_table[link.column];
	const value = link.column === 'soundcloud_id' || link.column === 'genius_id' ? Number(link.value) : link.value;
	const rows = await ex.select({ id: service_ids_table.illusi_id }).from(service_ids_table).where(eq(column, value as never)).limit(CANDIDATES_PER_SOURCE);
	return rows.map(r => r.id);
}

/** Artist names per track, in credit order. */
async function track_artist_names(ex: Executor, track_ids: readonly string[]): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	if (track_ids.length === 0) return out;
	const rows = await ex.select({ track_id: tracks_artists_table.track_id, name: artists_table.name })
		.from(tracks_artists_table)
		.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
		.where(inArray(tracks_artists_table.track_id, [...new Set(track_ids)]))
		.orderBy(tracks_artists_table.created_at);
	for (const r of rows) out.set(r.track_id, [...(out.get(r.track_id) ?? []), r.name]);
	return out;
}

export async function search_tracks(ex: Executor, user_id: string, query: string, scope: SearchScope, link: ServiceIdQuery | null): Promise<string[]> {
	const scoped = scope === 'library' ? in_library(user_id) : undefined;
	const select = { id: tracks_table.id, title: tracks_table.title, plays: total_plays };
	const linked = await linked_ids(ex, link);
	const [by_title, by_artist, by_link] = await all_queries(ex, [
		ex.select(select).from(tracks_table).where(and(text_matches(tracks_table.title, query), scoped)).limit(CANDIDATES_PER_SOURCE),
		ex.select(select).from(tracks_table)
			.where(and(sql`exists (
				select 1 from ${tracks_artists_table} join ${artists_table} on ${artists_table.id} = ${tracks_artists_table.artist_id}
				where ${tracks_artists_table.track_id} = ${tracks_table.id} and ${artists_named_in(query)}
			)`, scoped))
			.limit(CANDIDATES_PER_SOURCE),
		linked.length === 0 ? Promise.resolve([]) : ex.select(select).from(tracks_table).where(and(inArray(tracks_table.id, linked), scoped))
	]);
	const linked_set = new Set(by_link.map(r => r.id));
	const rows = [...by_title, ...by_artist, ...by_link];
	const artists = await track_artist_names(ex, rows.map(r => r.id));
	return rank_candidates(query, rows.map((r) => {
		const names = artists.get(r.id) ?? [];
		return { id: r.id, plays: r.plays, linked: linked_set.has(r.id), texts: [r.title, ...names.flatMap(a => [`${a} ${r.title}`, `${r.title} ${a}`])] };
	}));
}

export async function search_albums(ex: Executor, user_id: string, query: string, scope: SearchScope, link: ServiceIdQuery | null): Promise<string[]> {
	const scoped = scope === 'library'
		? sql`exists (
			select 1 from ${tracks_table} join ${user_tracks_table} on ${user_tracks_table.track_id} = ${tracks_table.id}
			where ${user_tracks_table.user_id} = ${user_id} and not ${user_tracks_table.deleted}
				and (${tracks_table.album_id} = ${albums_table.id} or exists (
					select 1 from ${album_tracks_table} where ${album_tracks_table.album_id} = ${albums_table.id} and ${album_tracks_table.track_id} = ${tracks_table.id}
				))
		)`
		: undefined;
	const plays = sql<number>`(select count(*) from ${track_plays_table} join ${tracks_table} on ${tracks_table.id} = ${track_plays_table.track_id} where ${tracks_table.album_id} = ${albums_table.id})`.mapWith(Number);
	const select = { id: albums_table.id, name: albums_table.name, artist: artists_table.name, plays };
	const linked = await linked_ids(ex, link);
	const credited_artist = sql`exists (
		select 1 from ${artist_albums_table} join ${artists_table} on ${artists_table.id} = ${artist_albums_table.artist_id}
		where ${artist_albums_table.album_id} = ${albums_table.id} and ${artists_named_in(query)}
	)`;
	const [by_name, by_artist, by_link] = await all_queries(ex, [
		ex.select(select).from(albums_table).leftJoin(artists_table, eq(artists_table.id, albums_table.artist_id))
			.where(and(text_matches(albums_table.name, query), scoped)).limit(CANDIDATES_PER_SOURCE),
		ex.select(select).from(albums_table).leftJoin(artists_table, eq(artists_table.id, albums_table.artist_id))
			.where(and(or(artists_named_in(query), credited_artist), scoped)).limit(CANDIDATES_PER_SOURCE),
		linked.length === 0
			? Promise.resolve([])
			: ex.select(select).from(albums_table).leftJoin(artists_table, eq(artists_table.id, albums_table.artist_id))
					.where(and(inArray(albums_table.id, linked), scoped))
	]);
	const linked_set = new Set(by_link.map(r => r.id));
	return rank_candidates(query, [...by_name, ...by_artist, ...by_link].map(r => ({
		id: r.id,
		plays: r.plays,
		linked: linked_set.has(r.id),
		texts: [r.name, ...(r.artist ? [`${r.artist} ${r.name}`, `${r.name} ${r.artist}`] : [])]
	})));
}

export async function search_artists(ex: Executor, user_id: string, query: string, scope: SearchScope, link: ServiceIdQuery | null): Promise<string[]> {
	const scoped = scope === 'library'
		? sql`exists (
			select 1 from ${tracks_artists_table} join ${user_tracks_table} on ${user_tracks_table.track_id} = ${tracks_artists_table.track_id}
			where ${tracks_artists_table.artist_id} = ${artists_table.id} and ${user_tracks_table.user_id} = ${user_id} and not ${user_tracks_table.deleted}
		)`
		: undefined;
	const plays = sql<number>`(select count(*) from ${track_plays_table} join ${tracks_artists_table} on ${tracks_artists_table.track_id} = ${track_plays_table.track_id} where ${tracks_artists_table.artist_id} = ${artists_table.id})`.mapWith(Number);
	const select = { id: artists_table.id, name: artists_table.name, plays };
	const linked = await linked_ids(ex, link);
	const [by_name, by_key, by_link] = await all_queries(ex, [
		ex.select(select).from(artists_table).where(and(text_matches(artists_table.name, query), scoped)).limit(CANDIDATES_PER_SOURCE),
		ex.select(select).from(artists_table).where(and(artists_named_in(query), scoped)).limit(CANDIDATES_PER_SOURCE),
		linked.length === 0 ? Promise.resolve([]) : ex.select(select).from(artists_table).where(and(inArray(artists_table.id, linked), scoped))
	]);
	const linked_set = new Set(by_link.map(r => r.id));
	return rank_candidates(query, [...by_name, ...by_key, ...by_link].map(r => ({ id: r.id, plays: r.plays, linked: linked_set.has(r.id), texts: [r.name] })));
}

/** Library scope: the caller's own playlists. Global: public playlists plus the caller's own. Never deleted ones. */
export async function search_playlists(ex: Executor, user_id: string, query: string, scope: SearchScope): Promise<string[]> {
	const visible = scope === 'library'
		? eq(playlists_table.user_id, user_id)
		: or(eq(playlists_table.public, true), eq(playlists_table.user_id, user_id));
	const rows = await ex.select({ id: playlists_table.id, title: playlists_table.title })
		.from(playlists_table)
		.where(and(text_matches(playlists_table.title, query), eq(playlists_table.deleted, false), visible))
		.limit(CANDIDATES_PER_SOURCE);
	return rank_candidates(query, rows.map(r => ({ id: r.id, plays: 0, linked: false, texts: [r.title] })));
}
