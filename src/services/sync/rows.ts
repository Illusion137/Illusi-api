/** Row loaders shared by pull (changed rows) and push (authoritative rows it touched). */
import { and, eq, getColumns, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { all_queries } from '../../db';
import type { Executor } from '../../db';
import {
	album_tracks_table, albums_table, artist_albums_table, artists_table, genius_artists_table, itunes_artists_table, itunes_collections_table,
	itunes_tracks_table, service_ids_table, thumbnails_table, track_sample_data_table, tracks_artists_table, tracks_producers_table, tracks_table, users_table
} from '../../db/schema';
import type { ItunesFields, SyncRows, SyncUser } from './types';

/** Every column except `password_hash`, which is never synced. */
export const user_columns = {
	id: users_table.id,
	username: users_table.username,
	email: users_table.email,
	role: users_table.role,
	edited_at: users_table.edited_at,
	created_at: users_table.created_at,
	modified_at: users_table.modified_at
};

export async function load_user(ex: Executor, user_id: string): Promise<SyncUser | null> {
	const [row] = await ex.select(user_columns).from(users_table).where(eq(users_table.id, user_id));
	return row ?? null;
}

/** `applemusic_id` is the link to iTunes rows; it's normalized numeric, guarded so a bad value can't fail the cast. */
const applemusic_bigint = sql`case when ${service_ids_table.applemusic_id} ~ '^[0-9]{1,18}$' then ${service_ids_table.applemusic_id}::bigint end`;

async function common_rows(ex: Executor, ids: string[], into: SyncRows) {
	const [service_ids, thumbnails] = await all_queries(ex, [
		ex.select().from(service_ids_table).where(inArray(service_ids_table.illusi_id, ids)),
		ex.select().from(thumbnails_table).where(inArray(thumbnails_table.id, ids))
	]);
	into.service_ids.push(...service_ids);
	into.thumbnails.push(...thumbnails);
}

function itunes_row(entity_type: ItunesFields['entity_type'], r: { id: string; explicitness?: string | null; release_date?: Date | null; primary_genre_name: string | null; a600?: string | null; a100?: string | null }): ItunesFields {
	return { id: r.id, entity_type, explicitness: r.explicitness ?? null, release_date: r.release_date ?? null, primary_genre_name: r.primary_genre_name, artwork_url: r.a600 ?? r.a100 ?? null };
}

// The folded search columns are server-side lookup helpers, not part of the synced rows.
const { search_title: _track_search, ...track_columns } = getColumns(tracks_table);
const {
	version: _version, tempo_confidence: _tempo_confidence, rms_energy: _rms_energy, spectral_rolloff: _spectral_rolloff,
	zero_crossing_rate: _zero_crossing_rate, mfccs: _mfccs, chroma: _chroma, mood_scores: _mood_scores, source_duration_ms: _source_duration_ms,
	...sample_columns
} = getColumns(track_sample_data_table);
const { search_name: _album_search, ...album_columns } = getColumns(albums_table);
const { search_name: _artist_search, ...artist_columns } = getColumns(artists_table);

/** Track rows with joins, service ids, thumbnails, sample data and selected iTunes fields. Lyrics are added by the caller. */
export async function load_track_bundles(ex: Executor, track_ids: readonly string[], into: SyncRows) {
	if (track_ids.length === 0) return;
	const ids = [...track_ids];
	const [tracks, tracks_artists, album_tracks, producers, sample_data, itunes] = await all_queries(ex, [
		ex.select(track_columns).from(tracks_table).where(inArray(tracks_table.id, ids)),
		ex.select().from(tracks_artists_table).where(inArray(tracks_artists_table.track_id, ids)),
		ex.select().from(album_tracks_table).where(inArray(album_tracks_table.track_id, ids)),
		ex.select({ track_id: tracks_producers_table.track_id, producer_id: tracks_producers_table.producer_id, name: genius_artists_table.name })
			.from(tracks_producers_table).leftJoin(genius_artists_table, eq(genius_artists_table.id, tracks_producers_table.producer_id))
			.where(inArray(tracks_producers_table.track_id, ids)),
		ex.select(sample_columns).from(track_sample_data_table).where(inArray(track_sample_data_table.id, ids)),
		ex.select({
			id: service_ids_table.illusi_id,
			explicitness: itunes_tracks_table.explicitness,
			release_date: itunes_tracks_table.release_date,
			primary_genre_name: itunes_tracks_table.primary_genre_name,
			a600: itunes_tracks_table.artwork_url_600,
			a100: itunes_tracks_table.artwork_url_100
		}).from(service_ids_table).innerJoin(itunes_tracks_table, sql`${itunes_tracks_table.id} = ${applemusic_bigint}`).where(inArray(service_ids_table.illusi_id, ids))
	]);
	into.tracks.push(...tracks);
	into.tracks_artists.push(...tracks_artists);
	into.album_tracks.push(...album_tracks);
	into.tracks_producers.push(...producers);
	into.sample_data.push(...sample_data);
	into.itunes.push(...itunes.map(r => itunes_row('track', r)));
	await common_rows(ex, ids, into);
}

export async function load_album_bundles(ex: Executor, album_ids: readonly string[], into: SyncRows) {
	if (album_ids.length === 0) return;
	const ids = [...album_ids];
	const [albums, artist_albums, itunes] = await all_queries(ex, [
		ex.select(album_columns).from(albums_table).where(inArray(albums_table.id, ids)),
		ex.select().from(artist_albums_table).where(inArray(artist_albums_table.album_id, ids)),
		ex.select({
			id: service_ids_table.illusi_id,
			explicitness: itunes_collections_table.explicitness,
			release_date: itunes_collections_table.release_date,
			primary_genre_name: itunes_collections_table.primary_genre_name,
			a600: itunes_collections_table.artwork_url_600,
			a100: itunes_collections_table.artwork_url_100
		}).from(service_ids_table).innerJoin(itunes_collections_table, sql`${itunes_collections_table.id} = ${applemusic_bigint}`).where(inArray(service_ids_table.illusi_id, ids))
	]);
	into.albums.push(...albums);
	into.artist_albums.push(...artist_albums);
	into.itunes.push(...itunes.map(r => itunes_row('album', r)));
	await common_rows(ex, ids, into);
}

export async function load_artist_bundles(ex: Executor, artist_ids: readonly string[], into: SyncRows) {
	if (artist_ids.length === 0) return;
	const ids = [...artist_ids];
	const [artists, itunes] = await all_queries(ex, [
		ex.select(artist_columns).from(artists_table).where(inArray(artists_table.id, ids)),
		ex.select({ id: service_ids_table.illusi_id, primary_genre_name: itunes_artists_table.primary_genre_name })
			.from(service_ids_table).innerJoin(itunes_artists_table, sql`${itunes_artists_table.id} = ${applemusic_bigint}`).where(inArray(service_ids_table.illusi_id, ids))
	]);
	into.artists.push(...artists);
	into.itunes.push(...itunes.map(r => itunes_row('artist', r)));
	await common_rows(ex, ids, into);
}

/** `col = any(ids)` that is false (not a SQL error) for an empty list. */
export function in_ids(column: Parameters<typeof inArray>[0], ids: readonly string[]): SQL {
	return ids.length === 0 ? sql`false` : inArray(column, [...ids]);
}

export const and_all = (...conditions: (SQL | undefined)[]) => and(...conditions) ?? sql`true`;
