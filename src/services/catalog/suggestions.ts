/**
 * `GET /search/suggestions`: a handful of tracks, artists and albums plus text completions, cheap enough to ask on
 * every keystroke. Catalog candidates come from the trigram indexes, ordered in SQL by match tier then plays and
 * cut to a few dozen; the final order is decided here, where the caller's library is known. The catalog part is
 * shared by every user and cached briefly per (catalog version, query, limit).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { all_queries } from '../../db';
import type { Executor } from '../../db';
import {
	albums_table, artists_table, thumbnails_table, track_play_counts_table, tracks_artists_table, tracks_table,
	user_recent_searches, user_tracks_table
} from '../../db/schema';
import { artist_name_candidates, search_text, trigram_similarity } from './search';

/** Shorter (folded) queries suggest nothing. */
export const MIN_QUERY_LENGTH = 2;
/** Catalog suggestions start here: below three characters the trigram indexes can't narrow anything down. */
export const MIN_CATALOG_QUERY_LENGTH = 3;
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 10;
/** Candidates fetched per source before the final ranking. */
const CANDIDATES = 25;
/** Thumbnails at least this wide are preferred; suggestion rows are small. */
const THUMBNAIL_MIN_WIDTH = 120;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 2_000;

export interface SuggestionThumbnail { url: string; width: number | null; height: number | null }
export interface SuggestionRef { id: string; name: string }
export interface TrackSuggestion {
	id: string;
	title: string;
	artists: SuggestionRef[];
	album: SuggestionRef | null;
	duration_ms: number | null;
	explicit: boolean | null;
	thumbnail: SuggestionThumbnail | null;
	in_library: boolean;
}
export interface ArtistSuggestion { id: string; name: string; thumbnail: SuggestionThumbnail | null; in_library: boolean }
export interface AlbumSuggestion {
	id: string;
	name: string;
	artists: SuggestionRef[];
	album_type: string | null;
	release_date: string | null;
	track_count: number | null;
	explicit: boolean | null;
	thumbnail: SuggestionThumbnail | null;
	in_library: boolean;
}
export type TextSuggestionKind = 'recent' | 'artist' | 'track' | 'album';
export interface TextSuggestion { text: string; kind: TextSuggestionKind }
export interface Suggestions {
	tracks: TrackSuggestion[];
	artists: ArtistSuggestion[];
	albums: AlbumSuggestion[];
	text: TextSuggestion[];
}

/** Folded and whitespace-collapsed, like the ranking compares. */
export function fold(value: string): string {
	return search_text(value).replace(/\s+/gu, ' ').trim();
}

/** Match tier of `text` for `q` (both folded): exact 3, prefix 2, word prefix or contains 1, trigram-only 0, none -1. */
export function match_tier(q: string, text: string): number {
	if (!q || !text) return -1;
	if (text === q) return 3;
	if (text.startsWith(q)) return 2;
	if (text.includes(q)) return 1;
	return trigram_similarity(q, text) > 0 ? 0 : -1;
}

export interface RankInput {
	id: string;
	/** Texts the query is ranked against; the best one counts. */
	texts: string[];
	plays: number;
	in_library: boolean;
}

/** Best tier, library, trigram similarity, plays, then text and id. Candidates that don't match at all are dropped. */
export function rank_suggestions<T extends RankInput>(query: string, candidates: readonly T[]): T[] {
	const q = fold(query);
	const scored = new Map<string, { c: T; tier: number; similarity: number }>();
	for (const c of candidates) {
		let tier = -1;
		let similarity = 0;
		for (const raw of c.texts) {
			const text = fold(raw);
			const t = match_tier(q, text);
			// Within a tier the closer text wins: "hotline bling" over "hotline bling remix" for "hotline bl".
			const s = trigram_similarity(q, text);
			if (t > tier || (t === tier && s > similarity)) {
				tier = t;
				similarity = s;
			}
		}
		if (tier < 0) continue;
		const existing = scored.get(c.id);
		if (!existing || tier > existing.tier || (tier === existing.tier && similarity > existing.similarity)) scored.set(c.id, { c, tier, similarity });
	}
	return [...scored.values()]
		.sort((a, b) => b.tier - a.tier
			|| Number(b.c.in_library) - Number(a.c.in_library)
			|| b.similarity - a.similarity
			|| b.c.plays - a.c.plays
			|| (a.c.texts[0] ?? '').localeCompare(b.c.texts[0] ?? '')
			|| a.c.id.localeCompare(b.c.id))
		.map(r => r.c);
}

/**
 * Text completions: recent searches first (most recent first), then entity names and "artist title" combos in
 * ranked order, de-duplicated by folded text, never the query itself.
 */
export function text_completions(query: string, recent: readonly string[], ranked: readonly TextSuggestion[], limit: number): TextSuggestion[] {
	const q = fold(query);
	const seen = new Set<string>([q]);
	const out: TextSuggestion[] = [];
	const push = (s: TextSuggestion) => {
		const key = fold(s.text);
		if (!key || seen.has(key) || out.length >= limit) return;
		seen.add(key);
		out.push({ text: s.text.trim(), kind: s.kind });
	};
	for (const text of recent) if (match_tier(q, fold(text)) >= 1) push({ text, kind: 'recent' });
	const candidates = ranked.map(s => ({ s, tier: match_tier(q, fold(s.text)) })).filter(r => r.tier >= 0);
	// Stable: within a tier, the caller's ranked order stands.
	candidates.sort((a, b) => b.tier - a.tier);
	for (const { s } of candidates) push(s);
	return out;
}

/** Smallest thumbnail at least THUMBNAIL_MIN_WIDTH wide, else the largest known, else any. */
export function pick_thumbnail(rows: readonly SuggestionThumbnail[]): SuggestionThumbnail | null {
	if (rows.length === 0) return null;
	const wide = rows.filter(t => (t.width ?? 0) >= THUMBNAIL_MIN_WIDTH).sort((a, b) => (a.width ?? 0) - (b.width ?? 0) || a.url.localeCompare(b.url));
	if (wide.length > 0) return { url: wide[0].url, width: wide[0].width, height: wide[0].height };
	const sized = [...rows].sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || a.url.localeCompare(b.url));
	return { url: sized[0].url, width: sized[0].width, height: sized[0].height };
}

const like_escape = (value: string) => value.replace(/[\\%_]/gu, m => `\\${m}`);

/**
 * Rows matching the folded column, best match kind first: prefix, then substring, then trigram similarity. A
 * later, broader (and costlier) kind only runs while fewer than MAX_LIMIT rows were found: it can't outrank the
 * earlier ones, so with enough of them it would never show. Each kind orders by cheap columns (no re-folding per
 * row): an exact-length match first, then popularity, then the shortest text, which is the closest completion.
 */
async function staged<T extends { id: string }>(
	q: string,
	folded: SQL,
	raw: SQL,
	popularity: SQL | null,
	fetch: (where: SQL, order: SQL[], n: number) => Promise<T[]>
): Promise<T[]> {
	const escaped = like_escape(q);
	const closest = [sql`(char_length(${raw}) = ${q.length}) desc`, ...(popularity ? [sql`${popularity} desc`] : []), sql`char_length(${raw})`];
	const out: T[] = [];
	const seen = new Set<string>();
	const add = (rows: readonly T[]) => {
		for (const r of rows) {
			if (out.length >= CANDIDATES) return;
			if (!seen.has(r.id)) {
				seen.add(r.id);
				out.push(r);
			}
		}
	};
	add(await fetch(sql`${folded} like ${escaped} || '%'`, closest, CANDIDATES));
	if (out.length >= MAX_LIMIT) return out;
	// Prefix rows match again here; asking for that many more keeps the slots for new ones.
	add(await fetch(sql`${folded} like '%' || ${escaped} || '%'`, closest, CANDIDATES + out.length));
	if (out.length >= MAX_LIMIT) return out;
	add(await fetch(sql`${folded} % ${q}`, [sql`similarity(${folded}, ${q}) desc`, ...(popularity ? [sql`${popularity} desc`] : [])], CANDIDATES + out.length));
	return out;
}

type TrackFields = Pick<TrackSuggestion, 'album' | 'duration_ms' | 'explicit'>;
type AlbumFields = Pick<AlbumSuggestion, 'album_type' | 'release_date' | 'track_count' | 'explicit'>;
interface CatalogTrack extends TrackFields { id: string; title: string; plays: number; artists: SuggestionRef[] }
interface CatalogArtist { id: string; name: string; plays: number }
interface CatalogAlbum extends AlbumFields { id: string; name: string; plays: number; artists: SuggestionRef[] }
interface CatalogCandidates {
	tracks: CatalogTrack[];
	artists: CatalogArtist[];
	albums: CatalogAlbum[];
	thumbnails: Map<string, SuggestionThumbnail>;
}

const track_fields = {
	id: tracks_table.id, title: tracks_table.title, album_id: tracks_table.album_id, duration_ms: tracks_table.duration_ms, explicit: tracks_table.explicit
};
const album_fields = {
	id: albums_table.id, name: albums_table.name, album_type: albums_table.album_type, release_date: albums_table.release_date, track_count: albums_table.track_count,
	explicit: albums_table.explicit
};

async function catalog_candidates(ex: Executor, query: string): Promise<CatalogCandidates> {
	const q = fold(query);
	const track_text = sql`${tracks_table.search_title}`;
	const track_plays = sql<number>`coalesce(${track_play_counts_table.plays}, 0)`.mapWith(Number);

	// "drake hotl": a leading run of words naming an artist, the rest matched against that artist's titles.
	const words = q.split(' ');
	const splits = words.length < 2
		? []
		: artist_name_candidates(q)
				.filter(name => q.startsWith(`${name} `))
				.map(name => ({ name, rest: q.slice(name.length + 1) }));

	const [by_title, artists, albums, ...by_artist] = await Promise.all([
		staged(q, track_text, sql`${tracks_table.title}`, sql`coalesce(${track_play_counts_table.plays}, 0)`, (where, order, n) => ex
			.select({ ...track_fields, plays: track_plays })
			.from(tracks_table)
			.leftJoin(track_play_counts_table, eq(track_play_counts_table.track_id, tracks_table.id))
			.where(where)
			.orderBy(...order)
			.limit(n)),
		staged(q, sql`${artists_table.search_name}`, sql`${artists_table.name}`, null, (where, order, n) => ex
			.select({ id: artists_table.id, name: artists_table.name })
			.from(artists_table)
			.where(where)
			.orderBy(...order)
			.limit(n)),
		staged(q, sql`${albums_table.search_name}`, sql`${albums_table.name}`, null, (where, order, n) => ex
			.select({ ...album_fields, artist_id: artists_table.id, artist: artists_table.name })
			.from(albums_table)
			.leftJoin(artists_table, eq(artists_table.id, albums_table.artist_id))
			.where(where)
			.orderBy(...order)
			.limit(n)),
		...splits.map(({ name, rest }) => ex.select({ ...track_fields, plays: track_plays })
			.from(tracks_table)
			.innerJoin(tracks_artists_table, eq(tracks_artists_table.track_id, tracks_table.id))
			.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
			.leftJoin(track_play_counts_table, eq(track_play_counts_table.track_id, tracks_table.id))
			.where(and(
				sql`illusi_name_key(${artists_table.name}) = illusi_name_key(${name})`,
				sql`${track_text} like '%' || ${like_escape(rest)} || '%'`
			))
			.orderBy(desc(track_plays), sql`char_length(${tracks_table.title})`)
			.limit(CANDIDATES))
	]);

	const track_rows = new Map<string, (typeof by_title)[number]>();
	for (const r of [...by_title, ...by_artist.flat()]) if (!track_rows.has(r.id)) track_rows.set(r.id, r);
	const track_ids = [...track_rows.keys()];
	const album_ids = albums.map(a => a.id);
	const track_album_ids = [...new Set([...track_rows.values()].flatMap(r => (r.album_id === null ? [] : [r.album_id])))];
	const thumbnail_ids = [...track_ids, ...artists.map(a => a.id), ...album_ids];

	// Play totals for artists and albums only for the kept candidates: in the select list above they would be
	// computed for every match before the sort.
	const artist_ids = artists.map(a => a.id);
	const [credits, thumbnail_rows, artist_plays, album_plays, track_albums] = await all_queries(ex, [
		track_ids.length === 0
			? Promise.resolve([])
			: ex.select({ track_id: tracks_artists_table.track_id, id: artists_table.id, name: artists_table.name })
					.from(tracks_artists_table)
					.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
					.where(inArray(tracks_artists_table.track_id, track_ids))
					.orderBy(tracks_artists_table.created_at),
		thumbnail_ids.length === 0
			? Promise.resolve([])
			: ex.select().from(thumbnails_table).where(inArray(thumbnails_table.id, thumbnail_ids)),
		artist_ids.length === 0
			? Promise.resolve([])
			: ex.select({ id: tracks_artists_table.artist_id, plays: sql<number>`sum(${track_play_counts_table.plays})`.mapWith(Number) })
					.from(tracks_artists_table)
					.innerJoin(track_play_counts_table, eq(track_play_counts_table.track_id, tracks_artists_table.track_id))
					.where(inArray(tracks_artists_table.artist_id, artist_ids))
					.groupBy(tracks_artists_table.artist_id),
		album_ids.length === 0
			? Promise.resolve([])
			: ex.select({ id: tracks_table.album_id, plays: sql<number>`sum(${track_play_counts_table.plays})`.mapWith(Number) })
					.from(tracks_table)
					.innerJoin(track_play_counts_table, eq(track_play_counts_table.track_id, tracks_table.id))
					.where(inArray(tracks_table.album_id, album_ids))
					.groupBy(tracks_table.album_id),
		track_album_ids.length === 0
			? Promise.resolve([])
			: ex.select({ id: albums_table.id, name: albums_table.name }).from(albums_table).where(inArray(albums_table.id, track_album_ids))
	]);
	const plays_of = new Map<string, number>();
	for (const r of [...artist_plays, ...album_plays]) if (r.id) plays_of.set(r.id, r.plays);
	const credited = new Map<string, SuggestionRef[]>();
	for (const c of credits) credited.set(c.track_id, [...(credited.get(c.track_id) ?? []), { id: c.id, name: c.name }]);
	const album_refs = new Map(track_albums.map(a => [a.id, { id: a.id, name: a.name }]));
	const grouped = new Map<string, SuggestionThumbnail[]>();
	for (const t of thumbnail_rows) if (t.id) grouped.set(t.id, [...(grouped.get(t.id) ?? []), { url: t.url, width: t.width, height: t.height }]);
	const thumbnails = new Map<string, SuggestionThumbnail>();
	for (const [id, rows] of grouped) {
		const picked = pick_thumbnail(rows);
		if (picked) thumbnails.set(id, picked);
	}

	return {
		tracks: track_ids.map((id) => {
			const r = track_rows.get(id)!;
			return {
				id, title: r.title, plays: r.plays, artists: credited.get(id) ?? [],
				album: r.album_id === null ? null : album_refs.get(r.album_id) ?? null, duration_ms: r.duration_ms, explicit: r.explicit
			};
		}),
		artists: artists.map(a => ({ id: a.id, name: a.name, plays: plays_of.get(a.id) ?? 0 })),
		albums: albums.map(a => ({
			id: a.id, name: a.name, plays: plays_of.get(a.id) ?? 0, artists: a.artist_id && a.artist ? [{ id: a.artist_id, name: a.artist }] : [],
			album_type: a.album_type, release_date: a.release_date?.toISOString() ?? null, track_count: a.track_count, explicit: a.explicit
		})),
		thumbnails
	};
}

/** Short-lived cache of the catalog part, keyed by catalog version so a write never serves stale candidates for long. */
const cache = new Map<string, { at: number; value: Promise<CatalogCandidates> }>();

async function cached_catalog_candidates(ex: Executor, query: string, catalog_version: number): Promise<CatalogCandidates> {
	const key = `${catalog_version}|${fold(query)}`;
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && now - hit.at < CACHE_TTL_MS) {
		// Refresh LRU position.
		cache.delete(key);
		cache.set(key, hit);
		return hit.value;
	}
	const value = catalog_candidates(ex, query);
	cache.set(key, { at: now, value });
	value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
	while (cache.size > CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return value;
}

export function clear_suggestion_cache() {
	cache.clear();
}

async function library_flags(ex: Executor, user_id: string, catalog: CatalogCandidates): Promise<{ tracks: Set<string>; artists: Set<string>; albums: Set<string> }> {
	const track_ids = catalog.tracks.map(t => t.id);
	const artist_ids = catalog.artists.map(a => a.id);
	const album_ids = catalog.albums.map(a => a.id);
	const [tracks, artists, albums] = await all_queries(ex, [
		track_ids.length === 0
			? Promise.resolve([])
			: ex.select({ id: user_tracks_table.track_id }).from(user_tracks_table)
					.where(and(eq(user_tracks_table.user_id, user_id), eq(user_tracks_table.deleted, false), inArray(user_tracks_table.track_id, track_ids))),
		artist_ids.length === 0
			? Promise.resolve([])
			: ex.selectDistinct({ id: tracks_artists_table.artist_id }).from(tracks_artists_table)
					.innerJoin(user_tracks_table, and(eq(user_tracks_table.track_id, tracks_artists_table.track_id), eq(user_tracks_table.user_id, user_id), eq(user_tracks_table.deleted, false)))
					.where(inArray(tracks_artists_table.artist_id, artist_ids)),
		album_ids.length === 0
			? Promise.resolve([])
			: ex.selectDistinct({ id: tracks_table.album_id }).from(tracks_table)
					.innerJoin(user_tracks_table, and(eq(user_tracks_table.track_id, tracks_table.id), eq(user_tracks_table.user_id, user_id), eq(user_tracks_table.deleted, false)))
					.where(inArray(tracks_table.album_id, album_ids))
	]);
	return {
		tracks: new Set(tracks.map(r => r.id)),
		artists: new Set(artists.map(r => r.id)),
		albums: new Set(albums.map(r => r.id).filter((id): id is string => id !== null))
	};
}

/** The caller's recent searches containing the query, most recent first. */
async function recent_searches(ex: Executor, user_id: string, query: string, limit: number): Promise<string[]> {
	const rows = await ex.select({ text: user_recent_searches.text }).from(user_recent_searches)
		.where(and(
			eq(user_recent_searches.user_id, user_id),
			sql`illusi_search_text(${user_recent_searches.text}) like '%' || ${like_escape(fold(query))} || '%'`
		))
		.orderBy(desc(user_recent_searches.created_at), desc(user_recent_searches.id))
		.limit(limit * 4);
	return rows.map(r => r.text).filter((t): t is string => !!t);
}

export async function suggest(ex: Executor, user_id: string, query: string, limit: number, catalog_version: number): Promise<Suggestions> {
	const q = fold(query);
	if (q.length < MIN_QUERY_LENGTH) return { tracks: [], artists: [], albums: [], text: [] };
	const empty: CatalogCandidates = { tracks: [], artists: [], albums: [], thumbnails: new Map() };
	const [catalog, recent] = await Promise.all([
		q.length < MIN_CATALOG_QUERY_LENGTH ? Promise.resolve(empty) : cached_catalog_candidates(ex, q, catalog_version),
		recent_searches(ex, user_id, q, limit)
	]);
	const library = await library_flags(ex, user_id, catalog);

	const tracks = rank_suggestions(q, catalog.tracks.map(t => ({
		...t,
		in_library: library.tracks.has(t.id),
		texts: [t.title, ...t.artists.flatMap(a => [`${a.name} ${t.title}`, `${t.title} ${a.name}`])]
	})));
	const artists = rank_suggestions(q, catalog.artists.map(a => ({ ...a, in_library: library.artists.has(a.id), texts: [a.name] })));
	const albums = rank_suggestions(q, catalog.albums.map(a => ({
		...a,
		in_library: library.albums.has(a.id),
		texts: [a.name, ...a.artists.flatMap(n => [`${n.name} ${a.name}`, `${a.name} ${n.name}`])]
	})));

	// Completions follow the entity order: artists, then "artist title", then titles, then albums.
	const ranked_text: TextSuggestion[] = [
		...artists.map(a => ({ text: a.name, kind: 'artist' as const })),
		...tracks.flatMap(t => [
			...(t.artists[0] ? [{ text: `${t.artists[0].name} ${t.title}`, kind: 'track' as const }] : []),
			{ text: t.title, kind: 'track' as const }
		]),
		...albums.map(a => ({ text: a.name, kind: 'album' as const }))
	];

	const thumb = (id: string) => catalog.thumbnails.get(id) ?? null;
	return {
		tracks: tracks.slice(0, limit).map(t => ({
			id: t.id, title: t.title, artists: t.artists, album: t.album, duration_ms: t.duration_ms, explicit: t.explicit, thumbnail: thumb(t.id), in_library: t.in_library
		})),
		artists: artists.slice(0, limit).map(a => ({ id: a.id, name: a.name, thumbnail: thumb(a.id), in_library: a.in_library })),
		albums: albums.slice(0, limit).map(a => ({
			id: a.id, name: a.name, artists: a.artists, album_type: a.album_type, release_date: a.release_date, track_count: a.track_count, explicit: a.explicit,
			thumbnail: thumb(a.id), in_library: a.in_library
		})),
		text: text_completions(q, recent, ranked_text, limit)
	};
}
