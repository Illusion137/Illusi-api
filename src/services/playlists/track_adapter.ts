import type { ExplicitMode, ISOString, NamedUUID, Track } from '@illusive/types';
import type { ServiceIdColumn } from '../../core/service_ids';

/** Everything the adapter needs about one track, already joined for one user. */
export interface TrackRow {
	track_id: string;
	title: string;
	duration_ms: number | null;
	explicit: boolean | null;
	imported: boolean;
	album: { id: string; name: string } | null;
	/** In credit order */
	artists: { id: string; name: string }[];
	/** Genius producer names */
	producers: string[];
	service_ids: Partial<Record<ServiceIdColumn, string | number | null>>;
	sample: { acousticness: number; danceability: number; energy: number; instrumentalness: number; liveness: number; speechiness: number; valence: number; sampled_at: Date } | null;
	// User-specific
	/** `user_tracks_table.title`, the user's override */
	user_title: string | null;
	/** When the track entered the user's library (or the playlist, if it isn't in the library) */
	added_at: Date | null;
	downloaded_at: Date | null;
	start_at: number | null;
	end_at: number | null;
	plays: number;
	last_played_at: Date | null;
}

const EPOCH = new Date(0);

function iso(date: Date): ISOString {
	return date.toISOString() as ISOString;
}

function explicit_mode(explicit: boolean | null): ExplicitMode {
	return explicit === true ? 'EXPLICIT' : 'NONE';
}

function str(value: string | number | null | undefined): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}

/**
 * DB rows → lib-origin `Track`, filling exactly the fields `TRACK_QUERY_FLAGS`, `track_query_filter` and
 * `sort_playlist_tracks` read. Client-only fields (`thumbnail_uri`, lyrics uris, `youtubemusic_id`, global views,
 * `unreleased`, `meta.unavailable/age_restricted`) have no server source and stay unset, so those flags never match.
 * `media_uri` is set to a marker when the user has downloaded the track so `@dl` works.
 */
export function row_to_track(row: TrackRow): Track {
	const artists: NamedUUID[] = row.artists.map(a => ({ name: a.name, uuid: a.id }));
	const ids = row.service_ids;
	const sample = row.sample;
	return {
		uid: row.track_id,
		illusi_id: row.track_id,
		title: row.user_title ?? row.title,
		artists,
		album: row.album ? { name: row.album.name, uuid: row.album.id } : undefined,
		duration: (row.duration_ms ?? 0) / 1000,
		explicit: explicit_mode(row.explicit),
		prods: row.producers.length > 0 ? row.producers.map(name => ({ name })) : undefined,
		imported_id: row.imported ? row.track_id : undefined,
		youtube_id: str(ids.youtube_id),
		soundcloud_id: typeof ids.soundcloud_id === 'number' ? ids.soundcloud_id : undefined,
		soundcloud_permalink: str(ids.soundcloud_permalink),
		spotify_id: str(ids.spotify_id),
		amazonmusic_id: str(ids.amazonmusic_id),
		applemusic_id: str(ids.applemusic_id),
		bandlab_id: str(ids.bandlab_id),
		audiomack_id: str(ids.audiomack_id),
		deezer_id: str(ids.deezer_id),
		pandora_id: str(ids.pandora_id),
		tidal_id: str(ids.tidal_id),
		media_uri: row.downloaded_at ? 'downloaded' : undefined,
		analysis: sample
			? {
					acousticness: sample.acousticness,
					danceability: sample.danceability,
					energy: sample.energy,
					instrumentalness: sample.instrumentalness,
					liveness: sample.liveness,
					speechiness: sample.speechiness,
					valence: sample.valence
				}
			: undefined,
		meta: {
			plays: row.plays,
			added_date: iso(row.added_at ?? EPOCH),
			last_played_date: iso(row.last_played_at ?? EPOCH),
			downloaded_date: row.downloaded_at ? iso(row.downloaded_at) : undefined,
			last_sampled_date: sample ? iso(sample.sampled_at) : undefined,
			begdur: row.start_at ?? undefined,
			enddur: row.end_at ?? undefined
		}
	};
}
