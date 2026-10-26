/**
 * Pure parts of the new-releases feature: the window, which client services exist, which
 * artist checks are due, and scoping a FETCH_NEW_RELEASES submission to its one target artist.
 */
import type { ServiceIdColumn } from '../../core/service_ids';
import type { Graph, Rejection } from '../entities';
import type { Batch } from '../soundcloud';

/** Client-side services a user can be logged into, and the `service_ids_table` column holding an artist's id there. */
export const RELEASE_SERVICES = {
	applemusic: 'applemusic_id',
	spotify: 'spotify_id',
	soundcloud: 'soundcloud_id',
	youtube_music: 'youtube_id',
	deezer: 'deezer_id',
	tidal: 'tidal_id',
	amazonmusic: 'amazonmusic_id',
	audiomack: 'audiomack_id',
	bandlab: 'bandlab_id',
	pandora: 'pandora_id'
} as const satisfies Record<string, ServiceIdColumn>;

export type ReleaseService = keyof typeof RELEASE_SERVICES;

export const is_release_service = (value: string): value is ReleaseService => Object.hasOwn(RELEASE_SERVICES, value);

/** `services=spotify,soundcloud` (or repeated `services=`) → known services, deduped, in the given order. */
export function parse_services(raw: unknown): ReleaseService[] {
	const parts = (Array.isArray(raw) ? raw : [raw])
		.filter((v): v is string => typeof v === 'string')
		.flatMap(v => v.split(','))
		.map(v => v.trim().toLowerCase());
	return [...new Set(parts.filter(is_release_service))];
}

export interface ReleaseWindow { since: Date; until: Date }

/** The last `days` days up to `now`. Future (pre-release) dates are outside the window. */
export function release_window(now: Date, days: number): ReleaseWindow {
	return { since: new Date(now.getTime() - days * 86_400_000), until: now };
}

export interface CheckPolicy {
	recheck_after_ms: number;
	request_cooldown_ms: number;
}

export interface CheckCandidate {
	artist_id: string;
	service: ReleaseService;
	service_artist_id: string;
	requested_at: Date | null;
	checked_at: Date | null;
}

/** A check is due when it was never done (or is stale) and wasn't just handed out to someone. */
export function is_check_due(c: Pick<CheckCandidate, 'requested_at' | 'checked_at'>, now: Date, policy: CheckPolicy): boolean {
	if (c.checked_at && now.getTime() - c.checked_at.getTime() < policy.recheck_after_ms) return false;
	if (c.requested_at && now.getTime() - c.requested_at.getTime() < policy.request_cooldown_ms) return false;
	return true;
}

const staleness = (c: CheckCandidate) => c.checked_at?.getTime() ?? -Infinity;

/**
 * Picks at most `limit` due checks, taking turns between services so one service with many artists
 * can't crowd out the others. Within a service, never-checked artists go first, then the stalest.
 */
export function pick_checks(candidates: readonly CheckCandidate[], services: readonly ReleaseService[], now: Date, policy: CheckPolicy, limit: number): CheckCandidate[] {
	const queues = services.map(service => candidates
		.filter(c => c.service === service && is_check_due(c, now, policy))
		.sort((a, b) => staleness(a) - staleness(b)));
	const picked: CheckCandidate[] = [];
	for (let round = 0; picked.length < limit; round++) {
		let any = false;
		for (const queue of queues) {
			if (round < queue.length && picked.length < limit) {
				picked.push(queue[round]);
				any = true;
			}
		}
		if (!any) break;
	}
	return picked;
}

/**
 * Keeps only what a FETCH_NEW_RELEASES submission may say about its target artist:
 * - albums credited to the artist (`artist_ref` or an `artist_albums` relation)
 * - tracks on those albums
 * - artists credited on those albums/tracks (features), and the target itself
 * - relations between kept entities. `similar_artists` is never about a release, so it's dropped.
 * The target is referenced by its `illusi_id`, which is a valid ref.
 */
export function scope_graph(graph: Graph, artist_id: string): { graph: Graph; rejected: Rejection[] } {
	const rejected: Rejection[] = [];
	const credited = new Set(graph.relations.artist_albums.filter(r => r.artist_ref === artist_id).map(r => r.album_ref));
	const albums = new Set(graph.albums.filter(a => a.artist_ref === artist_id || credited.has(a.ref)).map(a => a.ref));
	const on_album = new Set(graph.relations.album_tracks.filter(r => albums.has(r.album_ref)).map(r => r.track_ref));
	const tracks = new Set(graph.tracks.filter(t => (t.album_ref != null && albums.has(t.album_ref)) || on_album.has(t.ref)).map(t => t.ref));
	const artists = new Set([artist_id]);
	for (const r of graph.relations.tracks_artists) if (tracks.has(r.track_ref)) artists.add(r.artist_ref);
	for (const r of graph.relations.artist_albums) if (albums.has(r.album_ref)) artists.add(r.artist_ref);
	for (const a of graph.albums) if (albums.has(a.ref) && a.artist_ref) artists.add(a.artist_ref);

	const keep = <T extends { ref: string }>(kind: 'artist' | 'album' | 'track', items: T[], allowed: Set<string>) => items.filter((item, index) => {
		if (allowed.has(item.ref)) return true;
		rejected.push({ kind, index, ref: item.ref, reason: 'not a release of the target artist' });
		return false;
	});
	const scoped: Graph = {
		artists: keep('artist', graph.artists, artists),
		albums: keep('album', graph.albums, albums),
		tracks: keep('track', graph.tracks, tracks),
		relations: {
			tracks_artists: graph.relations.tracks_artists.filter(r => tracks.has(r.track_ref)),
			album_tracks: graph.relations.album_tracks.filter(r => albums.has(r.album_ref) && tracks.has(r.track_ref)),
			artist_albums: graph.relations.artist_albums.filter(r => albums.has(r.album_ref)),
			similar_artists: []
		}
	};
	for (const [index] of graph.relations.similar_artists.entries()) rejected.push({ kind: 'similar_artists', index, reason: 'not a release of the target artist' });
	return { graph: scoped, rejected };
}

/** Keeps the target SoundCloud user and only the tracks/playlists they uploaded. Returns how many items were dropped. */
export function scope_soundcloud_batch(batch: Batch, sc_user_id: number): { batch: Batch; dropped: number } {
	const scoped: Batch = { users: new Map(), tracks: new Map(), playlists: new Map() };
	let dropped = 0;
	for (const [id, row] of batch.users) {
		if (id === sc_user_id) scoped.users.set(id, row);
		else dropped++;
	}
	for (const [id, entry] of batch.tracks) {
		if (entry.row.user_id === sc_user_id) scoped.tracks.set(id, entry);
		else dropped++;
	}
	for (const [id, entry] of batch.playlists) {
		if (entry.row.user_id === sc_user_id) scoped.playlists.set(id, entry);
		else dropped++;
	}
	return { batch: scoped, dropped };
}

export interface AlbumRow {
	id: string;
	name: string;
	album_type: string | null;
	release_date: Date | string;
	track_count: number | null;
	explicit: boolean | null;
	artist_id: string | null;
	artist_name: string | null;
	thumbnail_url: string | null;
	thumbnail_width: number | null;
	thumbnail_height: number | null;
}

export interface Release {
	id: string;
	name: string;
	album_type: string | null;
	release_date: string;
	track_count: number | null;
	explicit: boolean | null;
	artists: { id: string; name: string }[];
	thumbnails: { url: string; width: number | null; height: number | null }[];
}

const iso = (value: Date | string) => new Date(value).toISOString();

/** Folds one row per (album, artist, thumbnail) into albums, keeping the query's order. */
export function group_album_rows(rows: readonly AlbumRow[]): Release[] {
	const out = new Map<string, Release>();
	for (const row of rows) {
		let release = out.get(row.id);
		if (!release) {
			release = {
				id: row.id,
				name: row.name,
				album_type: row.album_type,
				release_date: iso(row.release_date),
				track_count: row.track_count,
				explicit: row.explicit,
				artists: [],
				thumbnails: []
			};
			out.set(row.id, release);
		}
		if (row.artist_id && row.artist_name && !release.artists.some(a => a.id === row.artist_id)) release.artists.push({ id: row.artist_id, name: row.artist_name });
		if (row.thumbnail_url && !release.thumbnails.some(t => t.url === row.thumbnail_url)) {
			release.thumbnails.push({ url: row.thumbnail_url, width: row.thumbnail_width, height: row.thumbnail_height });
		}
	}
	return [...out.values()];
}
