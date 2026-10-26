/** Thin database side of metadata matching: fetches candidates in the shape the pure evaluators take. */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { all_queries } from '../../db';
import type { Executor } from '../../db';
import { album_tracks_table, albums_table, artist_albums_table, artists_table, tracks_artists_table, tracks_table } from '../../db/schema';
import { names_match, primary_artist_name } from '../../core/normalize';
import type { AlbumCandidate, ArtistCandidate, TrackCandidate } from './matching';

const MAX_SCAN = 5_000;
const MAX_NAMED = 50;

/**
 * Candidate prefilter on the indexed `illusi_name_key` (accents, case and punctuation folded in SQL), so
 * spellings like "Beyoncé" / "Beyonce" reach the fuzzy matcher at all.
 */
const name_key_eq = (column: typeof artists_table.name | typeof albums_table.name, values: readonly string[]) =>
	or(...[...new Set(values.map(v => v.trim()).filter(Boolean))].map(v => sql`illusi_name_key(${column}) = illusi_name_key(${v})`));

function group<K, V>(rows: readonly { k: K; v: V }[]): Map<K, V[]> {
	const out = new Map<K, V[]>();
	for (const { k, v } of rows) {
		const list = out.get(k);
		if (list) list.push(v);
		else out.set(k, [v]);
	}
	return out;
}

export async function artist_ids_by_name(ex: Executor, name: string): Promise<string[]> {
	const where = name_key_eq(artists_table.name, [name, primary_artist_name(name)]);
	if (!where) return [];
	const rows = await ex.select({ id: artists_table.id }).from(artists_table).where(where).limit(MAX_NAMED);
	return rows.map(r => r.id);
}

/** Tracks by any of these artists or on any of these albums whose title matches, hydrated. */
export async function track_candidates(ex: Executor, title: string, artist_ids: readonly string[], album_ids: readonly string[]): Promise<TrackCandidate[]> {
	if (artist_ids.length === 0 && album_ids.length === 0) return [];
	const conditions = [];
	if (artist_ids.length > 0) {
		conditions.push(inArray(tracks_table.id, ex.select({ id: tracks_artists_table.track_id }).from(tracks_artists_table).where(inArray(tracks_artists_table.artist_id, [...artist_ids]))));
	}
	if (album_ids.length > 0) {
		conditions.push(inArray(tracks_table.album_id, [...album_ids]));
		conditions.push(inArray(tracks_table.id, ex.select({ id: album_tracks_table.track_id }).from(album_tracks_table).where(inArray(album_tracks_table.album_id, [...album_ids]))));
	}
	const scanned = await ex.select({ id: tracks_table.id, title: tracks_table.title }).from(tracks_table).where(or(...conditions)).limit(MAX_SCAN);
	const ids = scanned.filter(r => names_match(title, r.title)).map(r => r.id);
	return hydrate_tracks(ex, ids);
}

export async function hydrate_tracks(ex: Executor, ids: readonly string[]): Promise<TrackCandidate[]> {
	if (ids.length === 0) return [];
	const list = [...ids];
	const [tracks, artists, joined_albums, own_albums] = await all_queries(ex, [
		ex.select({ id: tracks_table.id, title: tracks_table.title, duration_ms: tracks_table.duration_ms }).from(tracks_table).where(inArray(tracks_table.id, list)),
		ex.select({ k: tracks_artists_table.track_id, id: artists_table.id, name: artists_table.name }).from(tracks_artists_table)
			.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id)).where(inArray(tracks_artists_table.track_id, list)),
		ex.select({ k: album_tracks_table.track_id, id: albums_table.id, name: albums_table.name }).from(album_tracks_table)
			.innerJoin(albums_table, eq(albums_table.id, album_tracks_table.album_id)).where(inArray(album_tracks_table.track_id, list)),
		ex.select({ k: tracks_table.id, id: albums_table.id, name: albums_table.name }).from(tracks_table)
			.innerJoin(albums_table, eq(albums_table.id, tracks_table.album_id)).where(inArray(tracks_table.id, list))
	]);
	const by_artist = group(artists.map(r => ({ k: r.k, v: r })));
	const by_album = group([...joined_albums, ...own_albums].map(r => ({ k: r.k, v: r })));
	return tracks.map(t => ({
		id: t.id,
		title: t.title,
		duration_ms: t.duration_ms,
		artist_ids: (by_artist.get(t.id) ?? []).map(a => a.id),
		artist_names: (by_artist.get(t.id) ?? []).map(a => a.name),
		album_ids: [...new Set((by_album.get(t.id) ?? []).map(a => a.id))],
		album_names: [...new Set((by_album.get(t.id) ?? []).map(a => a.name))]
	}));
}

/** Albums by these artists, plus albums with the same name (any artist, to detect unclear matches). */
export async function album_candidates(ex: Executor, name: string, artist_ids: readonly string[]): Promise<AlbumCandidate[]> {
	const conditions = [];
	if (artist_ids.length > 0) {
		conditions.push(inArray(albums_table.artist_id, [...artist_ids]));
		conditions.push(inArray(albums_table.id, ex.select({ id: artist_albums_table.album_id }).from(artist_albums_table).where(inArray(artist_albums_table.artist_id, [...artist_ids]))));
	}
	const named = name_key_eq(albums_table.name, [name]);
	if (named) conditions.push(named);
	if (conditions.length === 0) return [];
	const scanned = await ex.select({ id: albums_table.id, name: albums_table.name }).from(albums_table).where(or(...conditions)).limit(MAX_SCAN);
	const matching = scanned.filter(r => names_match(name, r.name));
	if (matching.length === 0) return [];
	const ids = matching.map(r => r.id);
	const [owners, linked] = await all_queries(ex, [
		ex.select({ k: albums_table.id, id: artists_table.id, name: artists_table.name }).from(albums_table)
			.innerJoin(artists_table, eq(artists_table.id, albums_table.artist_id)).where(inArray(albums_table.id, ids)),
		ex.select({ k: artist_albums_table.album_id, id: artists_table.id, name: artists_table.name }).from(artist_albums_table)
			.innerJoin(artists_table, eq(artists_table.id, artist_albums_table.artist_id)).where(inArray(artist_albums_table.album_id, ids))
	]);
	const by_album = group([...owners, ...linked].map(r => ({ k: r.k, v: r })));
	return matching.map(a => ({
		id: a.id,
		name: a.name,
		artist_ids: [...new Set((by_album.get(a.id) ?? []).map(r => r.id))],
		artist_names: [...new Set((by_album.get(a.id) ?? []).map(r => r.name))]
	}));
}

/** Artists with this name, plus artists linked to these known works, hydrated with their works. */
export async function artist_candidates(ex: Executor, name: string, work_ids: readonly string[]): Promise<ArtistCandidate[]> {
	const conditions = [];
	const named = name_key_eq(artists_table.name, [name]);
	if (named) conditions.push(named);
	if (work_ids.length > 0) {
		const works = [...work_ids];
		conditions.push(inArray(artists_table.id, ex.select({ id: tracks_artists_table.artist_id }).from(tracks_artists_table).where(inArray(tracks_artists_table.track_id, works))));
		conditions.push(inArray(artists_table.id, ex.select({ id: artist_albums_table.artist_id }).from(artist_albums_table).where(inArray(artist_albums_table.album_id, works))));
		conditions.push(inArray(artists_table.id, ex.select({ id: albums_table.artist_id }).from(albums_table).where(and(inArray(albums_table.id, works), sql`${albums_table.artist_id} is not null`))));
	}
	if (conditions.length === 0) return [];
	const scanned = await ex.select({ id: artists_table.id, name: artists_table.name }).from(artists_table).where(or(...conditions)).limit(MAX_SCAN);
	const matching = scanned.filter(r => names_match(name, r.name));
	if (matching.length === 0) return [];
	const ids = matching.map(r => r.id);
	const [own_albums, linked_albums, tracks] = await all_queries(ex, [
		ex.select({ k: albums_table.artist_id, id: albums_table.id, name: albums_table.name }).from(albums_table).where(inArray(albums_table.artist_id, ids)).limit(MAX_SCAN),
		ex.select({ k: artist_albums_table.artist_id, id: albums_table.id, name: albums_table.name }).from(artist_albums_table)
			.innerJoin(albums_table, eq(albums_table.id, artist_albums_table.album_id)).where(inArray(artist_albums_table.artist_id, ids)).limit(MAX_SCAN),
		ex.select({ k: tracks_artists_table.artist_id, id: tracks_table.id, name: tracks_table.title }).from(tracks_artists_table)
			.innerJoin(tracks_table, eq(tracks_table.id, tracks_artists_table.track_id)).where(inArray(tracks_artists_table.artist_id, ids)).limit(MAX_SCAN)
	]);
	const albums = group([...own_albums, ...linked_albums].filter(r => r.k != null).map(r => ({ k: r.k!, v: r })));
	const by_track = group(tracks.map(r => ({ k: r.k, v: r })));
	return matching.map(a => ({
		id: a.id,
		name: a.name,
		work_ids: [...(albums.get(a.id) ?? []), ...(by_track.get(a.id) ?? [])].map(w => w.id),
		album_names: [...new Set((albums.get(a.id) ?? []).map(w => w.name))],
		track_titles: [...new Set((by_track.get(a.id) ?? []).map(w => w.name))]
	}));
}
