/**
 * `GET /search`. Candidates come from indexed SQL (trigram, word-similarity and substring matches on the searched
 * column, the tracks and albums of artists the query names, service ids from links), then every candidate is ranked
 * here: how much of the query its name and artists explain (see `match_score`), plus a small boost for plays, saves,
 * release metadata, the caller's library and the artist's catalog.
 */
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import { all_queries } from '../../db';
import type { Executor } from '../../db';
import {
	album_tracks_table, albums_table, artist_albums_table, artists_table, playlists_table, service_ids_table, track_play_counts_table,
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

/** Folded words: case and accents removed, split on anything but letters and digits ("...Baby One More Time"). */
export function search_words(value: string): string[] {
	return search_text(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Optimal string alignment distance (edits plus adjacent swaps), or `max + 1` as soon as it must exceed `max`. */
export function edit_distance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let before: number[] = [];
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let row_min = i;
		for (let j = 1; j <= b.length; j++) {
			let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
			cur.push(d);
			row_min = Math.min(row_min, d);
		}
		if (row_min > max) return max + 1;
		before = prev;
		prev = cur;
	}
	return Math.min(prev[b.length], max + 1);
}

/** Weight of a query word matching a text word. A typo only counts in long words: "love" must not find "lose". */
const WORD_EXACT = 1;
/** The last query word is often still being typed */
const WORD_TYPING = 0.85;
const WORD_TYPO = 0.7;
const WORD_PREFIX = 0.6;

function word_weight(q: string, t: string, last: boolean): number {
	if (q === t) return WORD_EXACT;
	if (t.startsWith(q)) return last ? WORD_TYPING : q.length >= 3 ? WORD_PREFIX : 0;
	if (q.length >= 5 && t.length >= 5 && edit_distance(q, t, q.length >= 8 ? 2 : 1) <= (q.length >= 8 ? 2 : 1)) return WORD_TYPO;
	return 0;
}

/** Index and weight of the best unused word of `words` for `q`, or null. */
function best_word(q: string, words: readonly string[], used: readonly boolean[], last: boolean, min = Number.MIN_VALUE): { at: number; weight: number } | null {
	let best: { at: number; weight: number } | null = null;
	for (let j = 0; j < words.length; j++) {
		if (used[j]) continue;
		const weight = word_weight(q, words[j], last);
		if (weight >= min && weight > (best?.weight ?? 0)) best = { at: j, weight };
	}
	return best;
}

/** Below this share of the query explained by words, only the substring and trigram fallbacks score. */
const MIN_RECALL = 0.5;
/** Fallbacks for queries that don't split into matching words (unspaced scripts, heavy typos) rank under word matches. */
const FALLBACK_WEIGHT = 0.45;
/** A result credited to an artist the query names in full ("drake hotline bling") edges out one that only has the words. */
const NAMED_BONUS = 0.05;
/** Title score of a result matched only through its artist ("lelo" → Lelo's songs): close to, but under, an exact title. */
const ONLY_ARTIST_TITLE = 0.85;

function word_score(q: readonly string[], name: readonly string[], credits: readonly (readonly string[])[], credits_first: boolean): number {
	const last = q.length - 1;
	const weight: number[] = q.map(() => 0);
	const name_used: boolean[] = name.map(() => false);
	const positions: number[] = [];
	let name_weight = 0;
	let named = false;

	// An artist counts as named only when every word of the name is in the query; longest names claim words first.
	const claim_credits = () => {
		for (const credit of [...credits].sort((a, b) => b.length - a.length)) {
			const taken: boolean[] = weight.map(w => w > 0);
			const picks: { at: number; weight: number }[] = [];
			for (const word of credit) {
				let pick: { at: number; weight: number } | null = null;
				for (let i = 0; i < q.length; i++) {
					if (taken[i]) continue;
					const w = word_weight(q[i], word, i === last);
					if (w >= WORD_TYPO && w > (pick?.weight ?? 0)) pick = { at: i, weight: w };
				}
				if (!pick) break;
				taken[pick.at] = true;
				picks.push(pick);
			}
			if (picks.length !== credit.length) continue;
			for (const p of picks) weight[p.at] = p.weight;
			named = true;
		}
	};
	const claim_name = () => {
		for (let i = 0; i < q.length; i++) {
			if (weight[i] > 0) continue;
			const best = best_word(q[i], name, name_used, i === last);
			if (!best) continue;
			weight[i] = best.weight;
			name_used[best.at] = true;
			name_weight += best.weight;
			positions.push(best.at);
		}
	};
	if (credits_first) {
		claim_credits();
		claim_name();
	} else {
		claim_name();
		claim_credits();
	}
	// Leftover words found in part of an artist's name count for half.
	const credit_words = credits.flat();
	for (let i = 0; i < q.length; i++) {
		if (weight[i] > 0) continue;
		weight[i] = (best_word(q[i], credit_words, [], i === last)?.weight ?? 0) / 2;
	}

	const recall = weight.reduce((a, b) => a + b, 0) / q.length;
	if (recall < MIN_RECALL) return 0;
	let title: number;
	if (positions.length === 0) title = named ? ONLY_ARTIST_TITLE : 0;
	else {
		// How much of the name the query covers ("Hotline Bling (Cover)" covers less), and whether it's in order.
		const coverage = name_weight / name.length;
		const phrase = positions.every((p, k) => k === 0 || p === positions[k - 1] + 1) ? 1 : 0;
		title = 0.8 * coverage + 0.2 * phrase;
	}
	// Squared, so a query fully found ("love" in "Love Hurts") beats one partly found ("love" typed into "Loverboy").
	return recall * recall * (0.5 + 0.5 * title) + (named ? NAMED_BONUS : 0);
}

/**
 * How well `query` matches a result named `name` and credited to `credits` (artists), about 0..1.05. Each query word
 * finds its best word in the name or an artist; the score is the share of the query found, times how much of the
 * name it covers and in what order. Exact 1, extra words in the name or missing query words lower it.
 */
export function match_score(query: string, name: string, credits: readonly string[] = []): number {
	const q = search_words(query);
	if (q.length === 0) return 0;
	const n = search_words(name);
	const c = credits.map(search_words).filter(w => w.length > 0);
	const q_key = q.join('');
	const n_key = n.join('');
	// "acdc" for "AC/DC", "hotlinebling"
	if (q_key === n_key) return 1;
	const words = Math.max(word_score(q, n, c, true), word_score(q, n, c, false));
	const fallback = n_key.includes(q_key)
		? FALLBACK_WEIGHT
		: FALLBACK_WEIGHT * Math.max(trigram_similarity(query, name), ...credits.map(a => trigram_similarity(query, `${a} ${name}`)));
	return Math.max(words, fallback);
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
	name: string;
	/** Artist names credited on it */
	credits: string[];
	/** Plays plus saves */
	popularity: number;
	/** Catalog size of its best-known artist; separates equal matches (Drake's "Hotline Bling" from a namesake's) */
	presence: number;
	/** Has release metadata (an album or store ids) rather than being a bare upload */
	official: boolean;
	/** In the caller's library, or the caller's own playlist */
	mine: boolean;
	/** Found through a service id link; always ranked first */
	linked: boolean;
}

/** Ordering on top of the match: at most about a third of a match step, so popularity reorders close matches only. */
export function rank_boost(c: Candidate): number {
	return 0.1 * Math.min(Math.log10(1 + c.popularity), 2)
		+ 0.02 * Math.min(Math.log10(1 + c.presence), 2)
		+ (c.official ? 0.04 : 0)
		+ (c.mine ? 0.08 : 0);
}

/** Ranked ids: linked first, then match plus boost, popularity, presence, name, id. Candidates that don't match are dropped. */
export function rank_candidates(query: string, candidates: readonly Candidate[]): string[] {
	const merged = new Map<string, Candidate>();
	for (const c of candidates) {
		const existing = merged.get(c.id);
		if (existing) existing.linked ||= c.linked;
		else merged.set(c.id, { ...c });
	}
	return [...merged.values()]
		.map((c) => {
			const match = match_score(query, c.name, c.credits);
			return { c, match, score: c.linked ? Infinity : match + rank_boost(c) };
		})
		.filter(r => r.c.linked || r.match > 0)
		.sort((a, b) => b.score - a.score || b.c.popularity - a.c.popularity || b.c.presence - a.c.presence
			|| a.c.name.localeCompare(b.c.name) || a.c.id.localeCompare(b.c.id))
		.map(r => r.c.id);
}

const like_escape = (value: string) => value.replace(/[\\%_]/gu, m => `\\${m}`);

/**
 * Indexed match of an already folded column (`illusi_search_text`) against the query: trigram similarity, the query
 * fuzzily within the text (`<%`, typos in long titles), or as a substring.
 */
function text_matches(folded: SQL | Parameters<typeof eq>[0], query: string): SQL {
	return sql`(${folded} % illusi_search_text(${query}) or illusi_search_text(${query}) <% ${folded} or ${folded} like '%' || illusi_search_text(${like_escape(query)}) || '%')`;
}

/** Closeness of a folded column to the query, to keep the best matches when there are more than the candidate limit. */
function text_closeness(folded: SQL | Parameters<typeof eq>[0], query: string): SQL {
	return sql`greatest(similarity(${folded}, illusi_search_text(${query})), word_similarity(illusi_search_text(${query}), ${folded}))`;
}

/**
 * Ids of the `limit` rows matching `where` that `rank` puts first. The match runs in a materialized CTE so the planner
 * keeps the trigram index: given the limit directly, it often expects `%` to match early and scans the whole table for
 * rare terms.
 */
async function matching_ids(ex: Executor, table: SQL | AnyPgTable, id: SQL | Parameters<typeof eq>[0], where: SQL | undefined, rank: SQL, limit: number): Promise<string[]> {
	const rows = await ex.execute<{ id: string }>(sql`with m as materialized (select ${id} as id, ${rank} as rank from ${table} where ${where ?? sql`true`}) select id from m order by rank desc limit ${limit}`, 'objects');
	return rows.map(r => r.id);
}

/** Artist ids whose name key equals any run of query words (uses `artists_name_key_idx`). */
function artists_named_in(query: string): SQL {
	const names = artist_name_candidates(query);
	if (names.length === 0) return sql`false`;
	return sql`illusi_name_key(${artists_table.name}) in (select illusi_name_key(n) from unnest(array[${sql.join(names.map(n => sql`${n}`), sql`, `)}]::text[]) n)`;
}

/** Shortest run of query words (letters and digits) tried as a misspelt artist name. */
const MIN_FUZZY_ARTIST_CHARS = 4;
/** Trigram similarity for a run of query words to count as a misspelt artist name ("mobbstar" → MOBBSTARR is 0.73). */
const FUZZY_ARTIST_SIMILARITY = 0.6;
/** Artists looked up per query; their tracks and albums are candidates. */
const NAMED_ARTISTS = 100;

/**
 * Artists a run of query words names: by name key, or misspelt, as a close trigram match about as long as the run (so
 * "tyler" alone doesn't name "Tyler, The Creator") for runs long enough to tell apart.
 */
async function named_artist_ids(ex: Executor, query: string): Promise<string[]> {
	const fuzzy = artist_name_candidates(query).filter(r => r.replace(/[^\p{L}\p{N}]+/gu, '').length >= MIN_FUZZY_ARTIST_CHARS);
	const close = fuzzy.map(r => sql`(
		${artists_table.search_name} % illusi_search_text(${r}) and similarity(${artists_table.search_name}, illusi_search_text(${r})) >= ${FUZZY_ARTIST_SIMILARITY}
		and abs(length(illusi_name_key(${artists_table.name})) - length(illusi_name_key(${r}))) <= greatest(2, length(illusi_name_key(${r})) / 4)
	)`);
	const rows = await ex.select({ id: artists_table.id }).from(artists_table).where(or(artists_named_in(query), ...close)).limit(NAMED_ARTISTS);
	return rows.map(r => r.id);
}

const uuid_array = (ids: readonly string[]) => sql`array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::uuid[]`;

const total_plays = sql<number>`coalesce((select ${track_play_counts_table.plays} from ${track_play_counts_table} where ${track_play_counts_table.track_id} = ${tracks_table.id}), 0)`.mapWith(Number);
const track_saves = sql<number>`(select count(*) from ${user_tracks_table} where ${user_tracks_table.track_id} = ${tracks_table.id} and not ${user_tracks_table.deleted})`.mapWith(Number);

/** A store id beyond YouTube/SoundCloud: the row came from release metadata, not a bare upload. */
function has_store_ids(id: SQL | Parameters<typeof eq>[0]): SQL<boolean> {
	return sql<boolean>`exists (
		select 1 from ${service_ids_table} where ${service_ids_table.illusi_id} = ${id}
			and coalesce(${service_ids_table.spotify_id}, ${service_ids_table.applemusic_id}, ${service_ids_table.isrc}, ${service_ids_table.deezer_id}, ${service_ids_table.tidal_id}) is not null
	)`;
}

/** Tracks credited to an artist. */
function artist_track_count(artist_id: SQL | Parameters<typeof eq>[0]): SQL<number> {
	return sql<number>`(select count(*) from ${tracks_artists_table} where ${tracks_artists_table.artist_id} = ${artist_id})`.mapWith(Number);
}

function in_library(user_id: string): SQL<boolean> {
	return sql<boolean>`exists (select 1 from ${user_tracks_table} where ${user_tracks_table.user_id} = ${user_id} and ${user_tracks_table.track_id} = ${tracks_table.id} and not ${user_tracks_table.deleted})`;
}

async function linked_ids(ex: Executor, link: ServiceIdQuery | null): Promise<string[]> {
	if (!link) return [];
	const column = service_ids_table[link.column];
	const value = link.column === 'soundcloud_id' || link.column === 'genius_id' ? Number(link.value) : link.value;
	const rows = await ex.select({ id: service_ids_table.illusi_id }).from(service_ids_table).where(eq(column, value as never)).limit(CANDIDATES_PER_SOURCE);
	return rows.map(r => r.id);
}

/** Artist names per track in credit order, and the largest catalog among them. */
async function track_credits(ex: Executor, track_ids: readonly string[]): Promise<Map<string, { names: string[]; presence: number }>> {
	const out = new Map<string, { names: string[]; presence: number }>();
	if (track_ids.length === 0) return out;
	const rows = await ex.select({ track_id: tracks_artists_table.track_id, name: artists_table.name, tracks: artist_track_count(artists_table.id) })
		.from(tracks_artists_table)
		.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
		.where(inArray(tracks_artists_table.track_id, [...new Set(track_ids)]))
		.orderBy(tracks_artists_table.created_at);
	for (const r of rows) {
		const credits = out.get(r.track_id) ?? { names: [], presence: 0 };
		credits.names.push(r.name);
		credits.presence = Math.max(credits.presence, r.tracks);
		out.set(r.track_id, credits);
	}
	return out;
}

export async function search_tracks(ex: Executor, user_id: string, query: string, scope: SearchScope, link: ServiceIdQuery | null): Promise<string[]> {
	const scoped = scope === 'library' ? in_library(user_id) : undefined;
	const select = {
		id: tracks_table.id,
		title: tracks_table.title,
		plays: total_plays,
		saves: track_saves,
		official: sql<boolean>`(${tracks_table.album_id} is not null or ${has_store_ids(tracks_table.id)})`,
		mine: in_library(user_id)
	};
	interface Row { id: string; title: string; plays: number; saves: number; official: boolean; mine: boolean }
	const [linked, artist_ids] = await all_queries(ex, [linked_ids(ex, link), named_artist_ids(ex, query)]);
	const title_matches = async (): Promise<Row[]> => {
		const ids = await matching_ids(ex, tracks_table, tracks_table.id, and(text_matches(tracks_table.search_title, query), scoped), text_closeness(tracks_table.search_title, query), CANDIDATES_PER_SOURCE);
		return ids.length === 0 ? [] : ex.select(select).from(tracks_table).where(inArray(tracks_table.id, ids));
	};
	// The named artists' most played tracks.
	const artist_matches = async (): Promise<Row[]> => {
		if (artist_ids.length === 0) return [];
		return ex.select(select).from(tracks_table)
			.where(and(sql`exists (
				select 1 from ${tracks_artists_table} where ${tracks_artists_table.track_id} = ${tracks_table.id} and ${tracks_artists_table.artist_id} = any(${uuid_array(artist_ids)})
			)`, scoped))
			.orderBy(desc(total_plays), desc(track_saves))
			.limit(CANDIDATES_PER_SOURCE);
	};
	const [by_title, by_artist, by_link] = await all_queries(ex, [
		title_matches(),
		artist_matches(),
		linked.length === 0 ? Promise.resolve([]) : ex.select(select).from(tracks_table).where(and(inArray(tracks_table.id, linked), scoped))
	]);
	const linked_set = new Set(by_link.map(r => r.id));
	const rows = [...by_title, ...by_artist, ...by_link];
	const credits = await track_credits(ex, rows.map(r => r.id));
	return rank_candidates(query, rows.map((r) => {
		const c = credits.get(r.id);
		return {
			id: r.id, name: r.title, credits: c?.names ?? [], popularity: r.plays + r.saves, presence: c?.presence ?? 0,
			official: r.official, mine: r.mine, linked: linked_set.has(r.id)
		};
	}));
}

export async function search_albums(ex: Executor, user_id: string, query: string, scope: SearchScope, link: ServiceIdQuery | null): Promise<string[]> {
	const album_tracks = sql`(
		select ${tracks_table.id} from ${tracks_table} where ${tracks_table.album_id} = ${albums_table.id}
		union select ${album_tracks_table.track_id} from ${album_tracks_table} where ${album_tracks_table.album_id} = ${albums_table.id}
	)`;
	const in_my_library = sql<boolean>`exists (
		select 1 from ${user_tracks_table}
		where ${user_tracks_table.user_id} = ${user_id} and not ${user_tracks_table.deleted} and ${user_tracks_table.track_id} in ${album_tracks}
	)`;
	const scoped = scope === 'library' ? in_my_library : undefined;
	const plays = sql<number>`coalesce((select sum(${track_play_counts_table.plays}) from ${track_play_counts_table} join ${tracks_table} on ${tracks_table.id} = ${track_play_counts_table.track_id} where ${tracks_table.album_id} = ${albums_table.id}), 0)`.mapWith(Number);
	const saves = sql<number>`(select count(*) from ${user_tracks_table} join ${tracks_table} on ${tracks_table.id} = ${user_tracks_table.track_id} where ${tracks_table.album_id} = ${albums_table.id} and not ${user_tracks_table.deleted})`.mapWith(Number);
	const select = {
		id: albums_table.id,
		name: albums_table.name,
		artist: artists_table.name,
		plays,
		saves,
		presence: sql<number>`coalesce(${artist_track_count(artists_table.id)}, 0)`.mapWith(Number),
		official: has_store_ids(albums_table.id),
		mine: in_my_library
	};
	interface Row { id: string; name: string; artist: string | null; plays: number; saves: number; presence: number; official: boolean; mine: boolean }
	const albums = () => ex.select(select).from(albums_table).leftJoin(artists_table, eq(artists_table.id, albums_table.artist_id));
	const [linked, artist_ids] = await all_queries(ex, [linked_ids(ex, link), named_artist_ids(ex, query)]);
	const name_matches = async (): Promise<Row[]> => {
		const ids = await matching_ids(ex, albums_table, albums_table.id, and(text_matches(albums_table.search_name, query), scoped), text_closeness(albums_table.search_name, query), CANDIDATES_PER_SOURCE);
		return ids.length === 0 ? [] : albums().where(inArray(albums_table.id, ids));
	};
	// Albums whose primary or credited artist the query names. Resolving the artist ids first keeps both lookups on
	// indexes; as one OR over the joined artist, every album and artist row was scanned.
	const artist_matches = async (): Promise<Row[]> => {
		if (artist_ids.length === 0) return [];
		const ids = uuid_array(artist_ids);
		const album_ids = sql`array(
			select ${albums_table.id} from ${albums_table} where ${albums_table.artist_id} = any(${ids})
			union select ${artist_albums_table.album_id} from ${artist_albums_table} where ${artist_albums_table.artist_id} = any(${ids})
		)`;
		return albums().where(and(sql`${albums_table.id} = any(${album_ids})`, scoped)).orderBy(desc(plays), desc(saves)).limit(CANDIDATES_PER_SOURCE);
	};
	const [by_name, by_artist, by_link] = await all_queries(ex, [
		name_matches(),
		artist_matches(),
		linked.length === 0 ? Promise.resolve([]) : albums().where(and(inArray(albums_table.id, linked), scoped))
	]);
	const linked_set = new Set(by_link.map(r => r.id));
	return rank_candidates(query, [...by_name, ...by_artist, ...by_link].map(r => ({
		id: r.id, name: r.name, credits: r.artist ? [r.artist] : [], popularity: r.plays + r.saves, presence: r.presence,
		official: r.official, mine: r.mine, linked: linked_set.has(r.id)
	})));
}

export async function search_artists(ex: Executor, user_id: string, query: string, scope: SearchScope, link: ServiceIdQuery | null): Promise<string[]> {
	const in_my_library = sql<boolean>`exists (
		select 1 from ${tracks_artists_table} join ${user_tracks_table} on ${user_tracks_table.track_id} = ${tracks_artists_table.track_id}
		where ${tracks_artists_table.artist_id} = ${artists_table.id} and ${user_tracks_table.user_id} = ${user_id} and not ${user_tracks_table.deleted}
	)`;
	const scoped = scope === 'library' ? in_my_library : undefined;
	const plays = sql<number>`coalesce((select sum(${track_play_counts_table.plays}) from ${track_play_counts_table} join ${tracks_artists_table} on ${tracks_artists_table.track_id} = ${track_play_counts_table.track_id} where ${tracks_artists_table.artist_id} = ${artists_table.id}), 0)`.mapWith(Number);
	const saves = sql<number>`(select count(*) from ${user_tracks_table} join ${tracks_artists_table} on ${tracks_artists_table.track_id} = ${user_tracks_table.track_id} where ${tracks_artists_table.artist_id} = ${artists_table.id} and not ${user_tracks_table.deleted})`.mapWith(Number);
	const select = { id: artists_table.id, name: artists_table.name, plays, saves, presence: artist_track_count(artists_table.id), official: has_store_ids(artists_table.id), mine: in_my_library };
	interface Row { id: string; name: string; plays: number; saves: number; presence: number; official: boolean; mine: boolean }
	const [linked, artist_ids] = await all_queries(ex, [linked_ids(ex, link), named_artist_ids(ex, query)]);
	const name_matches = async (): Promise<Row[]> => {
		const ids = await matching_ids(ex, artists_table, artists_table.id, and(text_matches(artists_table.search_name, query), scoped), text_closeness(artists_table.search_name, query), CANDIDATES_PER_SOURCE);
		return ids.length === 0 ? [] : ex.select(select).from(artists_table).where(inArray(artists_table.id, ids));
	};
	const [by_name, by_key, by_link] = await all_queries(ex, [
		name_matches(),
		artist_ids.length === 0 ? Promise.resolve([]) : ex.select(select).from(artists_table).where(and(inArray(artists_table.id, artist_ids), scoped)),
		linked.length === 0 ? Promise.resolve([]) : ex.select(select).from(artists_table).where(and(inArray(artists_table.id, linked), scoped))
	]);
	const linked_set = new Set(by_link.map(r => r.id));
	return rank_candidates(query, [...by_name, ...by_key, ...by_link].map(r => ({
		id: r.id, name: r.name, credits: [], popularity: r.plays + r.saves, presence: r.presence, official: r.official, mine: r.mine, linked: linked_set.has(r.id)
	})));
}

/** Library scope: the caller's own playlists. Global: public playlists plus the caller's own, which rank higher. Never deleted ones. */
export async function search_playlists(ex: Executor, user_id: string, query: string, scope: SearchScope): Promise<string[]> {
	const visible = scope === 'library'
		? eq(playlists_table.user_id, user_id)
		: or(eq(playlists_table.public, true), eq(playlists_table.user_id, user_id));
	const folded = sql`illusi_search_text(${playlists_table.title})`;
	const rows = await ex.select({ id: playlists_table.id, title: playlists_table.title, user_id: playlists_table.user_id })
		.from(playlists_table)
		.where(and(text_matches(folded, query), eq(playlists_table.deleted, false), visible))
		.orderBy(desc(text_closeness(folded, query)))
		.limit(CANDIDATES_PER_SOURCE);
	return rank_candidates(query, rows.map(r => ({
		id: r.id, name: r.title, credits: [], popularity: 0, presence: 0, official: false, mine: r.user_id === user_id, linked: false
	})));
}
