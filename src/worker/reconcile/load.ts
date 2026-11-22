import { asc, count, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../../db';
import {
	albums_table, album_tracks_table, artists_table, genius_artists_table, genius_songs_table, itunes_artists_table,
	itunes_collections_table, itunes_tracks_table, playlist_tracks_table, service_id_conflicts_table, service_ids_table,
	soundcloud_tracks_table, soundcloud_users_table, track_plays_table, track_vectors_table, tracks_artists_table,
	tracks_table, user_tracks_table
} from '../../db/schema';
import {
	normalize_applemusic_id, normalize_soundcloud_permalink, normalize_spotify_id, normalize_youtube_id, SERVICE_ID_COLUMNS
} from '../../core/service_ids';
import { normalize_name } from '../../core/normalize';
import type { ServiceIdColumn } from '../../core/service_ids';
import type { ConflictInfo, EntityKind, Facet, ReconcileNode } from './types';

const CHUNK = 5000;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function in_chunks<T, R>(items: readonly T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
	const out: R[] = [];
	for (const chunk of chunks([...new Set(items)])) {
		if (chunk.length > 0) out.push(...await fn(chunk));
	}
	return out;
}

const year_of = (v: Date | string | null | undefined): number | null => {
	if (v == null) return null;
	const y = (v instanceof Date ? v : new Date(v)).getUTCFullYear();
	return Number.isFinite(y) ? y : null;
};

const defined = <T>(values: (T | null | undefined)[]): T[] => values.filter((v): v is T => v != null);

function reported(pairs: [ServiceIdColumn, string | null][]): Partial<Record<ServiceIdColumn, string>> {
	const out: Partial<Record<ServiceIdColumn, string>> = {};
	for (const [column, value] of pairs) if (value) out[column] = value;
	return out;
}

/** Open (and optionally deferred) conflicts, oldest first. */
export async function load_conflicts(ex: Executor, statuses: readonly ('open' | 'deferred')[]): Promise<ConflictInfo[]> {
	const rows = await ex.select().from(service_id_conflicts_table)
		.where(inArray(service_id_conflicts_table.status, [...statuses]))
		.orderBy(asc(service_id_conflicts_table.id));
	return rows.map(r => ({
		id: r.id,
		illusi_id: r.illusi_id,
		column: r.column as ServiceIdColumn,
		existing_value: r.existing_value,
		incoming_value: r.incoming_value,
		other_illusi_id: r.other_illusi_id,
		source: r.source,
		status: r.status as 'open' | 'deferred'
	}));
}

/**
 * Loads `service_ids_table` rows (all of them when `ids` is null) with their entity rows, the
 * service rows their ids point at, and user-data counts, as resolver nodes. Vectors are loaded
 * separately (`load_vectors`) and only for groups that need them.
 */
export async function load_nodes(ex: Executor, ids: readonly string[] | null): Promise<ReconcileNode[]> {
	const sid_rows = ids === null
		? await ex.select().from(service_ids_table)
		: await in_chunks(ids, c => ex.select().from(service_ids_table).where(inArray(service_ids_table.illusi_id, c)));
	if (sid_rows.length === 0) return [];
	const all_ids = sid_rows.map(r => r.illusi_id);

	const tracks = await in_chunks(all_ids, c => ex.select().from(tracks_table).where(inArray(tracks_table.id, c)));
	const albums = await in_chunks(all_ids, c => ex.select().from(albums_table).where(inArray(albums_table.id, c)));
	const artists = await in_chunks(all_ids, c => ex.select().from(artists_table).where(inArray(artists_table.id, c)));
	const track_ids = tracks.map(t => t.id);

	const track_artist = new Map<string, string>();
	for (const r of await in_chunks(track_ids, c => ex.select({ track_id: tracks_artists_table.track_id, name: artists_table.name })
		.from(tracks_artists_table).innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
		.where(inArray(tracks_artists_table.track_id, c)).orderBy(asc(tracks_artists_table.created_at)))) {
		if (!track_artist.has(r.track_id)) track_artist.set(r.track_id, r.name);
	}
	const album_ids = defined(tracks.map(t => t.album_id));
	const album_info = new Map((await in_chunks(album_ids, c => ex.select({ id: albums_table.id, name: albums_table.name, release_date: albums_table.release_date })
		.from(albums_table).where(inArray(albums_table.id, c)))).map(a => [a.id, a]));
	const track_number = new Map<string, number>();
	for (const r of await in_chunks(track_ids, c => ex.select({ track_id: album_tracks_table.track_id, track_number: album_tracks_table.track_number })
		.from(album_tracks_table).where(inArray(album_tracks_table.track_id, c)))) {
		if (r.track_number != null && !track_number.has(r.track_id)) track_number.set(r.track_id, r.track_number);
	}
	const album_tracks = new Map<string, string[]>();
	for (const r of await in_chunks(albums.map(a => a.id), c => ex.select({ album_id: album_tracks_table.album_id, title: tracks_table.title })
		.from(album_tracks_table).innerJoin(tracks_table, eq(tracks_table.id, album_tracks_table.track_id))
		.where(inArray(album_tracks_table.album_id, c)))) {
		const list = album_tracks.get(r.album_id);
		if (list) list.push(normalize_name(r.title));
		else album_tracks.set(r.album_id, [normalize_name(r.title)]);
	}
	const artist_names = new Map((await in_chunks(defined(albums.map(a => a.artist_id)), c => ex.select({ id: artists_table.id, name: artists_table.name })
		.from(artists_table).where(inArray(artists_table.id, c)))).map(a => [a.id, a.name]));

	const user_data = new Map<string, number>();
	const add_counts = (rows: { id: string; n: number }[]) => { for (const r of rows) user_data.set(r.id, (user_data.get(r.id) ?? 0) + r.n); };
	add_counts(await in_chunks(track_ids, c => ex.select({ id: user_tracks_table.track_id, n: count() }).from(user_tracks_table).where(inArray(user_tracks_table.track_id, c)).groupBy(user_tracks_table.track_id)));
	add_counts(await in_chunks(track_ids, c => ex.select({ id: playlist_tracks_table.track_id, n: count() }).from(playlist_tracks_table).where(inArray(playlist_tracks_table.track_id, c)).groupBy(playlist_tracks_table.track_id)));
	add_counts(await in_chunks(track_ids, c => ex.select({ id: track_plays_table.track_id, n: count() }).from(track_plays_table).where(inArray(track_plays_table.track_id, c)).groupBy(track_plays_table.track_id)));

	const kind_of = new Map<string, EntityKind>();
	for (const t of tracks) kind_of.set(t.id, 'track');
	for (const a of albums) kind_of.set(a.id, 'album');
	for (const a of artists) kind_of.set(a.id, 'artist');
	const ids_of_kind = (kind: EntityKind, column: 'applemusic_id' | 'genius_id' | 'soundcloud_id') =>
		defined(sid_rows.filter(r => kind_of.get(r.illusi_id) === kind).map(r => r[column] == null ? null : Number(r[column])))
			.filter(n => Number.isSafeInteger(n));

	const itunes_tracks = new Map((await in_chunks(ids_of_kind('track', 'applemusic_id'), c => ex.select({
		t: itunes_tracks_table, artist: itunes_artists_table.name, album: itunes_collections_table.name
	}).from(itunes_tracks_table)
		.leftJoin(itunes_artists_table, eq(itunes_artists_table.id, itunes_tracks_table.artist_id))
		.leftJoin(itunes_collections_table, eq(itunes_collections_table.id, itunes_tracks_table.collection_id))
		.where(inArray(itunes_tracks_table.id, c)))).map(r => [String(r.t.id), r]));
	const itunes_albums = new Map((await in_chunks(ids_of_kind('album', 'applemusic_id'), c => ex.select({ c: itunes_collections_table, artist: itunes_artists_table.name })
		.from(itunes_collections_table).leftJoin(itunes_artists_table, eq(itunes_artists_table.id, itunes_collections_table.artist_id))
		.where(inArray(itunes_collections_table.id, c)))).map(r => [String(r.c.id), r]));
	const itunes_artists = new Map((await in_chunks(ids_of_kind('artist', 'applemusic_id'), c => ex.select().from(itunes_artists_table)
		.where(inArray(itunes_artists_table.id, c)))).map(r => [String(r.id), r]));
	const sc_tracks = new Map((await in_chunks(ids_of_kind('track', 'soundcloud_id'), c => ex.select({ t: soundcloud_tracks_table, user_permalink: soundcloud_users_table.permalink, username: soundcloud_users_table.username })
		.from(soundcloud_tracks_table).leftJoin(soundcloud_users_table, eq(soundcloud_users_table.id, soundcloud_tracks_table.user_id))
		.where(inArray(soundcloud_tracks_table.id, c)))).map(r => [String(r.t.id), r]));
	const genius_songs = new Map((await in_chunks(ids_of_kind('track', 'genius_id'), c => ex.select().from(genius_songs_table)
		.where(inArray(genius_songs_table.id, c)))).map(r => [String(r.id), r]));
	const genius_artists = new Map((await in_chunks(ids_of_kind('artist', 'genius_id'), c => ex.select().from(genius_artists_table)
		.where(inArray(genius_artists_table.id, c)))).map(r => [String(r.id), r]));

	const track_by_id = new Map(tracks.map(t => [t.id, t]));
	const album_by_id = new Map(albums.map(a => [a.id, a]));
	const artist_by_id = new Map(artists.map(a => [a.id, a]));

	return sid_rows.map((row) => {
		const node_ids: Partial<Record<ServiceIdColumn, string>> = {};
		for (const column of SERVICE_ID_COLUMNS) {
			const v = row[column];
			if (v != null) node_ids[column] = String(v);
		}
		const kind = kind_of.get(row.illusi_id) ?? 'unknown';
		const facets: Facet[] = [];
		let meta: Facet = { source: 'entity', columns: [] };
		let entity_filled = 0;
		const count_filled = (r: object) => Object.values(r).filter(v => v != null).length;

		if (kind === 'track') {
			const t = track_by_id.get(row.illusi_id)!;
			const album = t.album_id ? album_info.get(t.album_id) : undefined;
			meta = { source: 'entity', columns: [], title: t.title, artist: track_artist.get(t.id) ?? null, album: album?.name ?? null, duration_ms: t.duration_ms, explicit: t.explicit, track_number: track_number.get(t.id) ?? null, release_year: year_of(album?.release_date) };
			entity_filled = count_filled(t);
			const it = node_ids.applemusic_id ? itunes_tracks.get(node_ids.applemusic_id) : undefined;
			if (it) {
				facets.push({
					source: 'itunes', columns: ['applemusic_id'], title: it.t.name, artist: it.artist, album: it.album, duration_ms: it.t.track_time_millis,
					explicit: it.t.explicitness == null ? null : it.t.explicitness === 'explicit', track_number: it.t.track_number, release_year: year_of(it.t.release_date),
					thumbnails: defined([it.t.artwork_url_30, it.t.artwork_url_60, it.t.artwork_url_100, it.t.artwork_url_600])
				});
			}
			const sc = node_ids.soundcloud_id ? sc_tracks.get(node_ids.soundcloud_id) : undefined;
			if (sc) {
				const permalink = sc.user_permalink && sc.t.permalink ? normalize_soundcloud_permalink(`${sc.user_permalink}/${sc.t.permalink}`) : null;
				const columns: ServiceIdColumn[] = ['soundcloud_id'];
				if (permalink && permalink === node_ids.soundcloud_permalink) columns.push('soundcloud_permalink');
				facets.push({
					source: 'soundcloud', columns, title: sc.t.title, artist: sc.t.publisher_artist ?? sc.username, album: sc.t.album_title,
					duration_ms: sc.t.full_duration ?? sc.t.duration, isrc: sc.t.isrc ? sc.t.isrc.replace(/[-\s]/gu, '').toUpperCase() : null,
					explicit: sc.t.explicit, release_year: year_of(sc.t.release_date),
					reported: columns.includes('soundcloud_permalink') ? {} : reported([['soundcloud_permalink', permalink]]),
					thumbnails: defined([sc.t.artwork_url])
				});
			}
			const g = node_ids.genius_id ? genius_songs.get(node_ids.genius_id) : undefined;
			if (g) {
				facets.push({
					source: 'genius', columns: ['genius_id'], title: g.title, artist: g.primary_artist_names ?? g.artist_names, explicit: g.explicit, release_year: year_of(g.release_date),
					reported: reported([
						['applemusic_id', g.apple_music_id ? normalize_applemusic_id(g.apple_music_id) : null],
						['spotify_id', g.spotify_uuid ? normalize_spotify_id(g.spotify_uuid) : null],
						['youtube_id', g.youtube_url ? normalize_youtube_id(g.youtube_url) : null],
						['soundcloud_permalink', g.soundcloud_url ? normalize_soundcloud_permalink(g.soundcloud_url) : null]
					]),
					thumbnails: defined([g.song_art_image_url, g.header_image_url])
				});
			}
		} else if (kind === 'album') {
			const a = album_by_id.get(row.illusi_id)!;
			meta = { source: 'entity', columns: [], title: a.name, artist: a.artist_id ? artist_names.get(a.artist_id) ?? null : null, explicit: a.explicit, release_year: year_of(a.release_date), tracks: album_tracks.get(a.id) ?? [] };
			entity_filled = count_filled(a);
			const ic = node_ids.applemusic_id ? itunes_albums.get(node_ids.applemusic_id) : undefined;
			if (ic) {
				facets.push({
					source: 'itunes', columns: ['applemusic_id'], title: ic.c.name, artist: ic.artist, release_year: year_of(ic.c.release_date),
					explicit: ic.c.explicitness == null ? null : ic.c.explicitness === 'explicit',
					thumbnails: defined([ic.c.artwork_url_30, ic.c.artwork_url_60, ic.c.artwork_url_100, ic.c.artwork_url_600])
				});
			}
		} else if (kind === 'artist') {
			const a = artist_by_id.get(row.illusi_id)!;
			meta = { source: 'entity', columns: [], title: a.name };
			entity_filled = count_filled(a);
			const ia = node_ids.applemusic_id ? itunes_artists.get(node_ids.applemusic_id) : undefined;
			if (ia) facets.push({ source: 'itunes', columns: ['applemusic_id'], title: ia.name });
			const ga = node_ids.genius_id ? genius_artists.get(node_ids.genius_id) : undefined;
			if (ga) facets.push({ source: 'genius', columns: ['genius_id'], title: ga.name, thumbnails: defined([ga.image_url, ga.header_image_url]) });
		}

		return {
			illusi_id: row.illusi_id,
			kind,
			has_entity: kind !== 'unknown',
			created_at: row.created_at.getTime(),
			ids: node_ids,
			meta,
			facets,
			user_data: user_data.get(row.illusi_id) ?? 0,
			filled: Object.keys(node_ids).length + entity_filled,
			vector: null
		};
	});
}

/** Feature vectors for the given tracks, when analyzed. */
export async function load_vectors(ex: Executor, track_ids: readonly string[]): Promise<Map<string, number[]>> {
	const rows = await in_chunks(track_ids, c => ex.select({ id: track_vectors_table.track_id, embedding: track_vectors_table.embedding })
		.from(track_vectors_table).where(inArray(track_vectors_table.track_id, c)));
	return new Map(rows.map(r => [r.id, r.embedding]));
}
