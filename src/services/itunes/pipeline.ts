import type { ITunesArtist, ITunesCollection, ITunesResult, ITunesTrack } from '@origin/itunes/itunes';
import type { Tx } from '../../db';
import { name_similarity, primary_artist_name } from '../../core/normalize';
import { batch_collections } from './batching';
import type { ITunesClient } from './client';
import type { LookupRequest } from './matching';
import { is_conclusive_track, pick_track, rank_albums, rank_artists } from './matching';
import {
	persist_artist, persist_collection, persist_track, stored_artists, stored_collection_row, stored_collections, stored_track_row,
	stored_tracks
} from './store';
import type { EntityType } from './store';

export interface Artwork { artwork_url_30?: string | null; artwork_url_60?: string | null; artwork_url_100?: string | null; artwork_url_600?: string | null }

/** What a match stores (inside the caller's transaction) and links to. */
export interface Found {
	itunes_id: number;
	persist: (tx: Tx) => Promise<{ artwork: Artwork | null; preview_url: string | null }>;
}

/** Search pipeline: artist search → artist's albums → album tracks. Returns null when nothing matches. */
export async function resolve_request(client: ITunesClient, req: LookupRequest, threshold: number): Promise<Found | null> {
	switch (req.type) {
		case 'artist': return resolve_artist(client, req.artist_name, threshold);
		case 'album': return resolve_album(client, req, threshold);
		case 'track': return resolve_track(client, req, threshold);
	}
}

async function resolve_artist(client: ITunesClient, artist_name: string, threshold: number): Promise<Found | null> {
	const primary = primary_artist_name(artist_name);
	const stored = (await stored_artists(primary, threshold)).find(a => name_similarity(primary, a.name) === 1);
	if (stored) return { itunes_id: stored.id, persist: async () => ({ artwork: null, preview_url: null }) };
	const [artist] = rank_artists(primary, await client.search_artists(primary), threshold);
	if (!artist) return null;
	return {
		itunes_id: artist.artistId!,
		persist: async (tx) => {
			await persist_artist(tx, artist);
			return { artwork: null, preview_url: null };
		}
	};
}

async function find_artist(client: ITunesClient, artist_name: string, threshold: number): Promise<ITunesArtist | null> {
	const [artist] = rank_artists(artist_name, await client.search_artists(artist_name), threshold);
	return artist ?? null;
}

async function resolve_album(client: ITunesClient, req: Extract<LookupRequest, { type: 'album' }>, threshold: number): Promise<Found | null> {
	const primary = primary_artist_name(req.artist_name);

	const stored = await stored_artists(primary, threshold);
	if (stored.length > 0) {
		const [hit] = rank_albums(req.album_name, await stored_collections(stored.map(a => a.id)), threshold, req.track_count);
		if (hit && name_similarity(req.album_name, hit.collectionName!) === 1) {
			const row = await stored_collection_row(hit.collectionId!);
			if (row) return { itunes_id: row.id, persist: async () => ({ artwork: row, preview_url: null }) };
		}
	}

	const artist = await find_artist(client, primary, threshold);
	if (!artist) return null;
	const { artist: full_artist, albums } = await client.artist_albums(artist.artistId!);
	const [album] = rank_albums(req.album_name, albums, threshold, req.track_count);
	if (!album) return null;
	return {
		itunes_id: album.collectionId!,
		persist: async tx => ({ artwork: await persist_collection(tx, { artist: full_artist ?? artist, collection: album }), preview_url: null })
	};
}

async function resolve_track(client: ITunesClient, req: Extract<LookupRequest, { type: 'track' }>, threshold: number): Promise<Found | null> {
	const primary = primary_artist_name(req.artist_name);

	const stored = await stored_artists(primary, threshold);
	if (stored.length > 0) {
		const hit = pick_track(req, await stored_tracks(stored.map(a => a.id)), threshold);
		if (hit && is_conclusive_track(req, hit)) {
			const row = await stored_track_row(hit.trackId!);
			if (row) return { itunes_id: row.id, persist: async () => ({ artwork: row, preview_url: row.preview_url }) };
		}
	}

	const artist = await find_artist(client, primary, threshold);
	if (!artist) return null;
	const { artist: full_artist, albums } = await client.artist_albums(artist.artistId!);
	const preferred = req.album_name ? rank_albums(req.album_name, albums, threshold) : [];
	const preferred_ids = new Set(preferred.map(a => a.collectionId));
	const rest = albums.filter(a => !preferred_ids.has(a.collectionId));

	const tracks: ITunesTrack[] = [];
	const collections = new Map<number, ITunesCollection>();
	for (const a of albums) collections.set(a.collectionId!, a);

	let best: ITunesTrack | null = null;
	// Matching albums first; the rest only if nothing matched there.
	for (const group of [preferred, rest]) {
		if (group.length === 0) continue;
		for (const batch of batch_collections(group.map(a => ({ id: a.collectionId!, track_count: a.trackCount })))) {
			for (const [id, entry] of await client.album_tracks(batch)) {
				if (entry.collection) collections.set(id, entry.collection);
				tracks.push(...entry.tracks);
			}
			best = pick_track(req, tracks, threshold);
			if (best && is_conclusive_track(req, best)) break;
		}
		if (best) break;
	}
	if (!best) return null;
	const track = best;
	return {
		itunes_id: track.trackId!,
		persist: async (tx) => {
			const row = await persist_track(tx, { artist: full_artist ?? artist, collection: collections.get(track.collectionId!) ?? null, track });
			return { artwork: row, preview_url: row.preview_url ?? null };
		}
	};
}

/** Picks the result for a known id of the given entity type out of a plain `lookup?id=...` response. */
export function result_for_id(results: readonly ITunesResult[], type: EntityType, id: string): ITunesResult | null {
	const n = Number(id);
	for (const r of results) {
		if (type === 'track' && r.wrapperType === 'track' && (r as ITunesTrack).trackId === n) return r;
		if (type === 'album' && r.wrapperType === 'collection' && (r as ITunesCollection).collectionId === n) return r;
		if (type === 'artist' && r.wrapperType === 'artist' && r.artistId === n) return r;
	}
	return null;
}

/** Fast-path persistence for a result found by id: the track/collection row is full, the parents are derived. */
export function found_from_result(type: EntityType, result: ITunesResult): Found {
	switch (type) {
		case 'track': {
			const track = result as ITunesTrack;
			return {
				itunes_id: track.trackId!,
				persist: async (tx) => {
					const row = await persist_track(tx, { track });
					return { artwork: row, preview_url: row.preview_url ?? null };
				}
			};
		}
		case 'album': {
			const collection = result as ITunesCollection;
			return { itunes_id: collection.collectionId!, persist: async tx => ({ artwork: await persist_collection(tx, { collection }), preview_url: null }) };
		}
		case 'artist': {
			const artist = result as ITunesArtist;
			return {
				itunes_id: artist.artistId!,
				persist: async (tx) => {
					await persist_artist(tx, artist);
					return { artwork: null, preview_url: null };
				}
			};
		}
	}
}
