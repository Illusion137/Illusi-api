/** The view shapes of the read API, built in batches. Every builder drops ids that don't exist. */
import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { all_queries } from '../../db';
import type { Executor } from '../../db';
import type {
	playlists_table } from '../../db/schema';
import {
	albums_table, artist_albums_table, artists_table, media_table, playlist_inherited_playlists_table, playlist_inherited_searches_table, thumbnails_table, track_lyrics_table, track_plays_table, tracks_artists_table, user_tracks_table, users_table
} from '../../db/schema';
import { SERVICE_ID_COLUMNS } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';
import { best_thumbnail } from '../../core/thumbnails';
import { resolve_playlist_track_ids } from '../playlists';
import { load_album_bundles, load_artist_bundles, load_track_bundles } from '../sync/rows';
import { empty_rows } from '../sync/types';
import type { ItunesFields, SyncRows } from '../sync/types';

type TrackRow = SyncRows['tracks'][number];
type AlbumRow = SyncRows['albums'][number];
type ArtistRow = SyncRows['artists'][number];
type PlaylistRow = typeof playlists_table.$inferSelect;
type SampleRow = SyncRows['sample_data'][number];

export interface ArtistRef { id: string; name: string }
export interface AlbumRef { id: string; name: string; album_type: AlbumRow['album_type']; release_date: Date | null }
export interface ViewThumbnail { url: string; width: number | null; height: number | null }
export type ServiceIdValues = Partial<Record<ServiceIdColumn, string | number | null>>;

export interface UserTrackOverlay {
	title: string | null;
	downloaded_at: Date | null;
	start_at: number | null;
	end_at: number | null;
	added_at: Date;
	plays: number;
	last_played_at: Date | null;
}
export interface TrackView extends TrackRow {
	artists: ArtistRef[];
	album: AlbumRef | null;
	track_number: number | null;
	service_ids: ServiceIdValues;
	thumbnails: ViewThumbnail[];
	itunes: ItunesFields | null;
	sample_data: SampleRow | null;
	producers: { id: number; name: string | null }[];
	has_media: boolean;
	/** The track's newest media, streamable through `GET /media/:resource_id` */
	resource_id: string | null;
	has_lyrics: boolean;
	user: UserTrackOverlay | null;
	redirected_from?: string;
}
export interface AlbumView extends AlbumRow {
	artist: ArtistRef | null;
	artists: ArtistRef[];
	service_ids: ServiceIdValues;
	thumbnails: ViewThumbnail[];
	itunes: ItunesFields | null;
	redirected_from?: string;
}
export interface ArtistView extends ArtistRow {
	service_ids: ServiceIdValues;
	thumbnails: ViewThumbnail[];
	itunes: ItunesFields | null;
	album_count: number;
	track_count: number;
	in_library: boolean;
	redirected_from?: string;
}
export interface PlaylistView extends PlaylistRow {
	owner: { id: string; username: string };
	is_owner: boolean;
	track_count: number;
	thumbnails: ViewThumbnail[];
	inherited_searches?: (typeof playlist_inherited_searches_table.$inferSelect)[];
	inherited_playlists?: (typeof playlist_inherited_playlists_table.$inferSelect)[];
}

function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const row of rows) {
		const k = key(row);
		const list = out.get(k);
		if (list) list.push(row);
		else out.set(k, [row]);
	}
	return out;
}

/** Largest first; unknown sizes last. */
export function sort_thumbnails(rows: readonly { url: string; width: number | null; height: number | null }[]): ViewThumbnail[] {
	const area = (t: ViewThumbnail) => (t.width && t.height ? t.width * t.height : 0);
	return rows.map(t => ({ url: t.url, width: t.width, height: t.height })).sort((a, b) => area(b) - area(a) || a.url.localeCompare(b.url));
}

function service_id_values(row: SyncRows['service_ids'][number] | undefined): ServiceIdValues {
	const out: ServiceIdValues = {};
	if (!row) return out;
	for (const column of SERVICE_ID_COLUMNS) out[column] = row[column];
	return out;
}

/** Shared parts every entity view has: service ids, thumbnails and iTunes fields, by illusi_id. */
function common_parts(rows: SyncRows) {
	const service_ids = new Map(rows.service_ids.map(r => [r.illusi_id, r]));
	const thumbnails = group(rows.thumbnails.filter(t => t.id !== null), t => t.id!);
	const itunes = new Map(rows.itunes.map(r => [r.id, r]));
	return (id: string) => ({
		service_ids: service_id_values(service_ids.get(id)),
		thumbnails: sort_thumbnails(thumbnails.get(id) ?? []),
		itunes: itunes.get(id) ?? null
	});
}

async function artist_refs(ex: Executor, ids: readonly string[]): Promise<Map<string, ArtistRef>> {
	if (ids.length === 0) return new Map();
	const rows = await ex.select({ id: artists_table.id, name: artists_table.name }).from(artists_table).where(inArray(artists_table.id, [...new Set(ids)]));
	return new Map(rows.map(r => [r.id, r]));
}

/** `TrackView`s for `track_ids`, with `user_id`'s library overlay. */
export async function track_views(ex: Executor, user_id: string, track_ids: readonly string[]): Promise<Map<string, TrackView>> {
	const out = new Map<string, TrackView>();
	const ids = [...new Set(track_ids)];
	if (ids.length === 0) return out;
	const rows = empty_rows();
	await load_track_bundles(ex, ids, rows);
	if (rows.tracks.length === 0) return out;

	const album_ids = [...new Set(rows.tracks.flatMap(t => (t.album_id ? [t.album_id] : [])))];
	const [artists, albums, overlay, plays, media, lyrics] = await all_queries(ex, [
		artist_refs(ex, rows.tracks_artists.map(r => r.artist_id)),
		album_ids.length === 0
			? Promise.resolve([])
			: ex.select({ id: albums_table.id, name: albums_table.name, album_type: albums_table.album_type, release_date: albums_table.release_date })
					.from(albums_table).where(inArray(albums_table.id, album_ids)),
		ex.select().from(user_tracks_table)
			.where(and(eq(user_tracks_table.user_id, user_id), eq(user_tracks_table.deleted, false), inArray(user_tracks_table.track_id, ids))),
		ex.select({ track_id: track_plays_table.track_id, plays: count(), last_played_at: max(track_plays_table.created_at) })
			.from(track_plays_table)
			.where(and(eq(track_plays_table.user_id, user_id), inArray(track_plays_table.track_id, ids)))
			.groupBy(track_plays_table.track_id),
		ex.select({ track_id: media_table.track_id, resource_id: media_table.resource_id }).from(media_table)
			.where(inArray(media_table.track_id, ids)).orderBy(desc(media_table.created_at), desc(media_table.id)),
		ex.selectDistinct({ track_id: track_lyrics_table.track_id }).from(track_lyrics_table).where(inArray(track_lyrics_table.track_id, ids))
	]);

	const parts = common_parts(rows);
	const credits = group(
		[...rows.tracks_artists].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.artist_id.localeCompare(b.artist_id)),
		r => r.track_id
	);
	const album_by_id = new Map(albums.map(a => [a.id, a]));
	const numbers = group(rows.album_tracks, r => r.track_id);
	const producers = group(rows.tracks_producers, r => r.track_id);
	const samples = new Map(rows.sample_data.map(r => [r.id, r]));
	const overlay_by_track = new Map(overlay.map(r => [r.track_id, r]));
	const plays_by_track = new Map(plays.map(r => [r.track_id, r]));
	const media_by_track = new Map<string, string>();
	for (const row of media) if (!media_by_track.has(row.track_id)) media_by_track.set(row.track_id, row.resource_id);
	const with_lyrics = new Set(lyrics.map(r => r.track_id));

	for (const track of rows.tracks) {
		const library = overlay_by_track.get(track.id);
		const play = plays_by_track.get(track.id);
		const listings = numbers.get(track.id) ?? [];
		out.set(track.id, {
			...track,
			artists: (credits.get(track.id) ?? []).flatMap(c => artists.get(c.artist_id) ?? []),
			album: track.album_id ? (album_by_id.get(track.album_id) ?? null) : null,
			track_number: (listings.find(l => l.album_id === track.album_id) ?? listings[0])?.track_number ?? null,
			...parts(track.id),
			sample_data: samples.get(track.id) ?? null,
			producers: (producers.get(track.id) ?? []).map(p => ({ id: p.producer_id, name: p.name })),
			has_media: media_by_track.has(track.id),
			resource_id: media_by_track.get(track.id) ?? null,
			has_lyrics: with_lyrics.has(track.id),
			user: library
				? {
						title: library.title,
						downloaded_at: library.downloaded_at,
						start_at: library.start_at,
						end_at: library.end_at,
						added_at: library.created_at,
						plays: play?.plays ?? 0,
						last_played_at: play?.last_played_at ?? null
					}
				: null
		});
	}
	return out;
}

export async function album_views(ex: Executor, album_ids: readonly string[]): Promise<Map<string, AlbumView>> {
	const out = new Map<string, AlbumView>();
	const ids = [...new Set(album_ids)];
	if (ids.length === 0) return out;
	const rows = empty_rows();
	await load_album_bundles(ex, ids, rows);
	const artists = await artist_refs(ex, [
		...rows.albums.flatMap(a => (a.artist_id ? [a.artist_id] : [])),
		...rows.artist_albums.map(r => r.artist_id)
	]);
	const parts = common_parts(rows);
	const credits = group(
		[...rows.artist_albums].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.created_at.getTime() - b.created_at.getTime()),
		r => r.album_id
	);
	for (const album of rows.albums) {
		const credited = [...(album.artist_id ? [album.artist_id] : []), ...(credits.get(album.id) ?? []).map(c => c.artist_id)];
		out.set(album.id, {
			...album,
			artist: album.artist_id ? (artists.get(album.artist_id) ?? null) : null,
			artists: [...new Set(credited)].flatMap(id => artists.get(id) ?? []),
			...parts(album.id)
		});
	}
	return out;
}

export async function artist_views(ex: Executor, user_id: string, artist_ids: readonly string[]): Promise<Map<string, ArtistView>> {
	const out = new Map<string, ArtistView>();
	const ids = [...new Set(artist_ids)];
	if (ids.length === 0) return out;
	const rows = empty_rows();
	await load_artist_bundles(ex, ids, rows);
	const stats = await ex.select({
		id: artists_table.id,
		album_count: sql<number>`(select count(*) from (
			select ${artist_albums_table.album_id} from ${artist_albums_table} where ${artist_albums_table.artist_id} = ${artists_table.id}
			union select ${albums_table.id} from ${albums_table} where ${albums_table.artist_id} = ${artists_table.id}
		) credited)`.mapWith(Number),
		track_count: sql<number>`(select count(*) from ${tracks_artists_table} where ${tracks_artists_table.artist_id} = ${artists_table.id})`.mapWith(Number),
		in_library: sql<boolean>`exists (
			select 1 from ${tracks_artists_table} join ${user_tracks_table} on ${user_tracks_table.track_id} = ${tracks_artists_table.track_id}
			where ${tracks_artists_table.artist_id} = ${artists_table.id} and ${user_tracks_table.user_id} = ${user_id} and not ${user_tracks_table.deleted}
		)`
	}).from(artists_table).where(inArray(artists_table.id, ids));
	const stats_by_id = new Map(stats.map(s => [s.id, s]));
	const parts = common_parts(rows);
	for (const artist of rows.artists) {
		const s = stats_by_id.get(artist.id);
		out.set(artist.id, { ...artist, ...parts(artist.id), album_count: s?.album_count ?? 0, track_count: s?.track_count ?? 0, in_library: s?.in_library ?? false });
	}
	return out;
}

/** Number of resolved tracks whose best thumbnails make up a playlist's artwork. */
const PLAYLIST_ARTWORK_TRACKS = 4;

/**
 * `PlaylistView`s seen by `viewer_id`. Track lists resolve as their owner sees them; inheritance rows
 * are attached only for playlists the viewer owns.
 */
export async function playlist_views(ex: Executor, viewer_id: string, playlists: readonly PlaylistRow[]): Promise<PlaylistView[]> {
	if (playlists.length === 0) return [];
	const ids = playlists.map(p => p.id);
	const owned = playlists.filter(p => p.user_id === viewer_id).map(p => p.id);
	const [owners, searches, inherited] = await all_queries(ex, [
		ex.select({ id: users_table.id, username: users_table.username }).from(users_table).where(inArray(users_table.id, [...new Set(playlists.map(p => p.user_id))])),
		owned.length === 0
			? Promise.resolve([])
			: ex.select().from(playlist_inherited_searches_table)
					.where(and(inArray(playlist_inherited_searches_table.playlist_id, owned), eq(playlist_inherited_searches_table.deleted, false)))
					.orderBy(asc(playlist_inherited_searches_table.id)),
		owned.length === 0
			? Promise.resolve([])
			: ex.select().from(playlist_inherited_playlists_table)
					.where(and(inArray(playlist_inherited_playlists_table.playlist_id, owned), eq(playlist_inherited_playlists_table.deleted, false)))
					.orderBy(asc(playlist_inherited_playlists_table.id))
	]);

	const resolved = new Map<string, string[]>();
	for (const p of playlists) resolved.set(p.id, p.deleted ? [] : await resolve_playlist_track_ids(p.user_id, p.id));
	const cover_ids = [...new Set(ids.flatMap(id => resolved.get(id)!.slice(0, PLAYLIST_ARTWORK_TRACKS)))];
	const thumbnails = cover_ids.length === 0
		? new Map<string, ViewThumbnail[]>()
		: group(await ex.select().from(thumbnails_table).where(inArray(thumbnails_table.id, cover_ids)), t => t.id!);

	const owner_by_id = new Map(owners.map(o => [o.id, o]));
	const searches_by_playlist = group(searches, r => r.playlist_id);
	const inherited_by_playlist = group(inherited, r => r.playlist_id);
	return playlists.map((p) => {
		const track_ids = resolved.get(p.id)!;
		const is_owner = p.user_id === viewer_id;
		const view: PlaylistView = {
			...p,
			owner: owner_by_id.get(p.user_id) ?? { id: p.user_id, username: '' },
			is_owner,
			track_count: track_ids.length,
			thumbnails: track_ids.slice(0, PLAYLIST_ARTWORK_TRACKS).flatMap((id) => {
				const best = best_thumbnail(thumbnails.get(id) ?? []);
				return best ? [{ url: best.url, width: best.width, height: best.height }] : [];
			})
		};
		if (is_owner) {
			view.inherited_searches = searches_by_playlist.get(p.id) ?? [];
			view.inherited_playlists = inherited_by_playlist.get(p.id) ?? [];
		}
		return view;
	});
}

/** Views in `ids` order, skipping ids with no view. */
export function in_order<T>(ids: readonly string[], views: ReadonlyMap<string, T>): T[] {
	return ids.flatMap(id => views.get(id) ?? []);
}
