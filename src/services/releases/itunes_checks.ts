/**
 * The server's own new release checks on Apple Music, so new releases don't depend on a client being logged into a
 * service. Every artist in someone's library with an Apple Music id is looked up on iTunes once per
 * NEW_RELEASES_RECHECK_HOURS; albums, singles and EPs it released in the window are added with their songs through
 * the contribution engine. Checks share `artist_release_checks_table` with client checks (service `applemusic`),
 * so a client is never asked for one the server just did.
 */
import type { ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { config } from '../../config';
import { db } from '../../db';
import { logger } from '../../core/log';
import { ProvenanceLog } from '../../core/provenance';
import { itunes_thumbnails } from '../../core/thumbnails';
import { apply_graph, flush_engine_events, validate_graph } from '../entities';
import type { RawGraph } from '../entities';
import { itunes_lookups } from '../itunes';
import type { ITunesLookups } from '../itunes';
import { collection_album } from '../itunes/album_link';
import { ITunesStoppedError } from '../itunes/client';
import { artwork_600 } from '../itunes/mapping';
import { release_window, scope_graph } from './logic';
import type { ReleaseWindow } from './logic';
import { due_applemusic_artists, linked_applemusic_albums, mark_checked } from './query';

const log = logger('releases');

/** Releases added per artist and check, newest first: a back catalog suddenly dated this week stays bounded. */
const MAX_RELEASES_PER_ARTIST = 6;

function released_in(value: string | undefined, window: ReleaseWindow): boolean {
	const time = value ? new Date(value).getTime() : NaN;
	return time >= window.since.getTime() && time <= window.until.getTime();
}

/** The artist's own collections released in the window, newest first. Pre-orders (future dates) wait for release day. */
export function recent_collections(albums: readonly ITunesCollection[], applemusic_artist_id: number, window: ReleaseWindow): ITunesCollection[] {
	return albums
		.filter(c => c.collectionId != null && c.artistId === applemusic_artist_id && released_in(c.releaseDate, window))
		.sort((a, b) => new Date(b.releaseDate!).getTime() - new Date(a.releaseDate!).getTime());
}

const explicit = (value: string | undefined) => (value === 'explicit' ? true : value === 'notExplicit' || value === 'cleaned' ? false : null);

/**
 * A contribution graph for `collections` and their songs, credited to the catalog artist `artist_id` (an existing
 * id, a valid ref). Songs by someone else (a feature listed first) credit that artist by Apple Music id and name.
 */
export function itunes_release_graph(artist_id: string, applemusic_artist_id: number, collections: readonly ITunesCollection[], songs: ReadonlyMap<number, readonly ITunesTrack[]>): RawGraph {
	const graph = {
		artists: [] as NonNullable<RawGraph['artists']>,
		albums: [] as NonNullable<RawGraph['albums']>,
		tracks: [] as NonNullable<RawGraph['tracks']>,
		relations: { tracks_artists: [], album_tracks: [], artist_albums: [], similar_artists: [] } as Required<NonNullable<RawGraph['relations']>>
	};
	const others = new Set<number>();
	for (const c of collections) {
		const album_ref = `album:${c.collectionId}`;
		const { name, album_type } = collection_album(c.collectionName ?? c.collectionCensoredName ?? '', c.trackCount ?? null);
		graph.albums.push({
			ref: album_ref, name, artist_ref: artist_id, album_type, release_date: c.releaseDate ?? null, track_count: c.trackCount ?? null,
			explicit: explicit(c.collectionExplicitness), service_ids: { applemusic_id: String(c.collectionId) },
			thumbnails: itunes_thumbnails({ artwork_url_100: c.artworkUrl100, artwork_url_600: artwork_600(c.artworkUrl600, c.artworkUrl100) })
		});
		graph.relations.artist_albums.push({ artist_ref: artist_id, album_ref, position: 0 });
		for (const t of songs.get(c.collectionId!) ?? []) {
			if (t.trackId == null || !t.trackName || (t.kind !== undefined && t.kind !== 'song')) continue;
			const track_ref = `track:${t.trackId}`;
			graph.tracks.push({
				ref: track_ref, title: t.trackName, album_ref, duration_ms: t.trackTimeMillis ?? null, explicit: explicit(t.trackExplicitness),
				source: 'Apple Music', service_ids: { applemusic_id: String(t.trackId) }
			});
			graph.relations.album_tracks.push({ album_ref, track_ref, track_number: t.trackNumber ?? null });
			const by_other = t.artistId != null && t.artistId !== applemusic_artist_id && !!t.artistName;
			const artist_ref = by_other ? `artist:${t.artistId}` : artist_id;
			if (by_other && !others.has(t.artistId!)) {
				others.add(t.artistId!);
				graph.artists.push({ ref: artist_ref, name: t.artistName!, service_ids: { applemusic_id: String(t.artistId) } });
			}
			graph.relations.tracks_artists.push({ track_ref, artist_ref });
		}
	}
	return graph;
}

/**
 * Looks up one artist's recent releases and adds the ones the catalog doesn't have, then records the check (also
 * when there was nothing new). Returns how many albums were added.
 */
export async function check_artist(lookups: ITunesLookups, artist_id: string, applemusic_id: string, now = new Date()): Promise<number> {
	const am_id = Number(applemusic_id);
	const window = release_window(now, config.NEW_RELEASES_WINDOW_DAYS);
	const recent = Number.isSafeInteger(am_id) ? recent_collections((await lookups.artist_albums(am_id)).albums, am_id, window) : [];
	const known = await linked_applemusic_albums(db, recent.map(c => String(c.collectionId)));
	const fresh = recent.filter(c => !known.has(String(c.collectionId))).slice(0, MAX_RELEASES_PER_ARTIST);
	const songs = new Map<number, ITunesTrack[]>();
	if (fresh.length > 0) for (const [id, album] of await lookups.album_tracks(fresh.map(c => c.collectionId!))) songs.set(id, album.tracks);

	const result = await db.transaction(async (tx) => {
		let created = 0;
		let events: Parameters<typeof flush_engine_events>[0]['events'] = [];
		if (fresh.length > 0) {
			const validated = validate_graph(itunes_release_graph(artist_id, am_id, fresh, songs));
			const scoped = scope_graph(validated.graph, artist_id);
			const provenance = new ProvenanceLog('itunes', null);
			const applied = await apply_graph(tx, scoped.graph, { user_id: null, source: 'itunes', provenance });
			const rejected = [...validated.rejected, ...scoped.rejected, ...applied.rejected];
			if (rejected.length > 0) log.warn(`releases of ${artist_id}: rejected parts`, { rejected });
			await provenance.write(tx, { refs: applied.refs, created: applied.created, matched: applied.matched });
			created = applied.created.filter(c => c.type === 'album').length;
			events = applied.events;
		}
		await mark_checked(tx, artist_id, 'applemusic', null, now);
		return { created, events };
	});
	flush_engine_events(result);
	return result.created;
}

let running = false;
let loop: Promise<void> | null = null;
let wake: (() => void) | null = null;

function idle(ms: number) {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => { wake = null; resolve(); }, ms);
		wake = () => { clearTimeout(timer); wake = null; resolve(); };
	});
}

/** One pass over the due artists, oldest check first. An artist that fails is retried on a later pass. */
export async function check_due_artists(lookups: ITunesLookups = itunes_lookups, now = new Date()): Promise<void> {
	const checked_before = new Date(now.getTime() - config.NEW_RELEASES_RECHECK_HOURS * 3_600_000);
	for (const { artist_id, applemusic_id } of await due_applemusic_artists(db, checked_before, config.NEW_RELEASES_SERVER_BATCH)) {
		if (!running && lookups === itunes_lookups) return;
		try {
			const added = await check_artist(lookups, artist_id, applemusic_id, now);
			if (added > 0) log.info(`added ${added} new release(s) of artist ${artist_id}`);
		} catch (err) {
			if (err instanceof ITunesStoppedError) throw err;
			log.warn(`release check of artist ${artist_id} failed`, err instanceof Error ? err.message : err);
		}
	}
}

/** Starts the background loop. Runs after the iTunes service, whose request gate it uses. */
export async function start(): Promise<void> {
	if (running || config.NEW_RELEASES_SERVER_INTERVAL_MIN <= 0 || config.NEW_RELEASES_SERVER_BATCH <= 0) return;
	running = true;
	loop = (async () => {
		while (running) {
			try {
				await check_due_artists();
			} catch (err) {
				if (err instanceof ITunesStoppedError) break;
				log.error('release check pass failed', err);
			}
			if (running) await idle(config.NEW_RELEASES_SERVER_INTERVAL_MIN * 60_000);
		}
	})();
}

export async function stop(): Promise<void> {
	running = false;
	wake?.();
	await loop;
	loop = null;
}
