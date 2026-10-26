import { and, asc, count, eq, inArray, max } from 'drizzle-orm';
import { all_queries } from '../../db';
import type { Executor } from '../../db';
import {
	albums_table, artists_table, genius_artists_table, service_ids_table, track_plays_table, track_sample_data_table,
	tracks_artists_table, tracks_producers_table, tracks_table, user_tracks_table
} from '../../db/schema';
import type { TrackRow } from './track_adapter';

const CHUNK = 5000;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Loads `TrackRow`s for `track_ids` joined with `user_id`'s library row and plays. Unknown ids are dropped.
 * `fallback_added_at` supplies the added date for tracks that aren't in the user's library (e.g. playlist rows).
 */
export async function load_track_rows(ex: Executor, user_id: string, track_ids: readonly string[], fallback_added_at = new Map<string, Date>()): Promise<Map<string, TrackRow>> {
	const result = new Map<string, TrackRow>();
	for (const ids of chunks([...new Set(track_ids)])) {
		const [base, artists, producers, plays] = await all_queries(ex, [
			ex.select({
				track_id: tracks_table.id,
				title: tracks_table.title,
				duration_ms: tracks_table.duration_ms,
				explicit: tracks_table.explicit,
				imported: tracks_table.imported,
				album_id: albums_table.id,
				album_name: albums_table.name,
				youtube_id: service_ids_table.youtube_id,
				spotify_id: service_ids_table.spotify_id,
				soundcloud_id: service_ids_table.soundcloud_id,
				soundcloud_permalink: service_ids_table.soundcloud_permalink,
				amazonmusic_id: service_ids_table.amazonmusic_id,
				applemusic_id: service_ids_table.applemusic_id,
				bandlab_id: service_ids_table.bandlab_id,
				audiomack_id: service_ids_table.audiomack_id,
				deezer_id: service_ids_table.deezer_id,
				pandora_id: service_ids_table.pandora_id,
				tidal_id: service_ids_table.tidal_id,
				user_title: user_tracks_table.title,
				user_added_at: user_tracks_table.created_at,
				user_deleted: user_tracks_table.deleted,
				downloaded_at: user_tracks_table.downloaded_at,
				start_at: user_tracks_table.start_at,
				end_at: user_tracks_table.end_at,
				acousticness: track_sample_data_table.acousticness,
				danceability: track_sample_data_table.danceability,
				energy: track_sample_data_table.arousal,
				instrumentalness: track_sample_data_table.instrumentalness,
				liveness: track_sample_data_table.liveness,
				speechiness: track_sample_data_table.speechiness,
				valence: track_sample_data_table.valence,
				sampled_at: track_sample_data_table.created_at
			})
				.from(tracks_table)
				.leftJoin(service_ids_table, eq(service_ids_table.illusi_id, tracks_table.id))
				.leftJoin(albums_table, eq(albums_table.id, tracks_table.album_id))
				.leftJoin(user_tracks_table, and(eq(user_tracks_table.track_id, tracks_table.id), eq(user_tracks_table.user_id, user_id)))
				.leftJoin(track_sample_data_table, eq(track_sample_data_table.id, tracks_table.id))
				.where(inArray(tracks_table.id, ids)),
			ex.select({ track_id: tracks_artists_table.track_id, id: artists_table.id, name: artists_table.name })
				.from(tracks_artists_table)
				.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
				.where(inArray(tracks_artists_table.track_id, ids))
				.orderBy(asc(tracks_artists_table.created_at), asc(artists_table.name)),
			ex.select({ track_id: tracks_producers_table.track_id, name: genius_artists_table.name })
				.from(tracks_producers_table)
				.innerJoin(genius_artists_table, eq(genius_artists_table.id, tracks_producers_table.producer_id))
				.where(inArray(tracks_producers_table.track_id, ids))
				.orderBy(asc(tracks_producers_table.created_at)),
			ex.select({ track_id: track_plays_table.track_id, plays: count(), last_played_at: max(track_plays_table.created_at) })
				.from(track_plays_table)
				.where(and(eq(track_plays_table.user_id, user_id), inArray(track_plays_table.track_id, ids)))
				.groupBy(track_plays_table.track_id)
		]);

		const artists_by_track = group(artists, r => r.track_id);
		const producers_by_track = group(producers, r => r.track_id);
		const plays_by_track = new Map(plays.map(p => [p.track_id, p]));

		for (const r of base) {
			const in_library = r.user_deleted === false;
			const play = plays_by_track.get(r.track_id);
			result.set(r.track_id, {
				track_id: r.track_id,
				title: r.title,
				duration_ms: r.duration_ms,
				explicit: r.explicit,
				imported: r.imported,
				album: r.album_id !== null && r.album_name !== null ? { id: r.album_id, name: r.album_name } : null,
				artists: (artists_by_track.get(r.track_id) ?? []).map(a => ({ id: a.id, name: a.name })),
				producers: (producers_by_track.get(r.track_id) ?? []).map(p => p.name),
				service_ids: {
					youtube_id: r.youtube_id, spotify_id: r.spotify_id, soundcloud_id: r.soundcloud_id,
					soundcloud_permalink: r.soundcloud_permalink, amazonmusic_id: r.amazonmusic_id, applemusic_id: r.applemusic_id,
					bandlab_id: r.bandlab_id, audiomack_id: r.audiomack_id, deezer_id: r.deezer_id, pandora_id: r.pandora_id, tidal_id: r.tidal_id
				},
				sample: r.sampled_at === null
					? null
					: {
							acousticness: r.acousticness ?? 0, danceability: r.danceability ?? 0, energy: r.energy ?? 0,
							instrumentalness: r.instrumentalness ?? 0, liveness: r.liveness ?? 0, speechiness: r.speechiness ?? 0,
							valence: r.valence ?? 0, sampled_at: r.sampled_at
						},
				user_title: in_library ? r.user_title : null,
				added_at: in_library ? r.user_added_at : (fallback_added_at.get(r.track_id) ?? null),
				downloaded_at: in_library ? r.downloaded_at : null,
				start_at: in_library ? r.start_at : null,
				end_at: in_library ? r.end_at : null,
				plays: play?.plays ?? 0,
				last_played_at: play?.last_played_at ?? null
			});
		}
	}
	return result;
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
