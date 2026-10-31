import { and, asc, eq } from 'drizzle-orm';
import { resolve_playlist_tracks } from '@illusive/playlist_resolution';
import type { ResolvablePlaylist } from '@illusive/playlist_resolution';
import type { InheritedPlaylist, InheritedSearch, Track } from '@illusive/types';
import { all_queries, db } from '../../db';
import type { Executor } from '../../db';
import {
	playlist_inherited_playlists_table, playlist_inherited_searches_table, playlist_tracks_table, playlists_table, user_tracks_table
} from '../../db/schema';
import { on } from '../../core/events';
import { to_inheritance_mode, to_sort_type } from './enums';
import { load_track_rows } from './load_tracks';
import { row_to_track } from './track_adapter';

/** A playlist's structure, before its tracks are hydrated. */
export interface PlaylistShape {
	/** Own non-deleted track ids, oldest first */
	track_ids: string[];
	inherited_playlists: InheritedPlaylist[];
	inherited_searchs: InheritedSearch[];
	sort: ResolvablePlaylist['sort'];
}

/** Playlists reachable from `root` through inherited playlists (including `root`), and whether any has a search. */
export function reachable_playlists(root: string, shapes: ReadonlyMap<string, PlaylistShape>): { ids: Set<string>; needs_library: boolean } {
	const ids = new Set<string>();
	let needs_library = false;
	const stack = [root];
	while (stack.length > 0) {
		const id = stack.pop()!;
		const shape = shapes.get(id);
		if (shape === undefined || ids.has(id)) continue;
		ids.add(id);
		if (shape.inherited_searchs.length > 0) needs_library = true;
		for (const inherited of shape.inherited_playlists) stack.push(inherited.uuid);
	}
	return { ids, needs_library };
}

/** Every non-deleted playlist of the user, with its own tracks and inheritance rows. Other users' playlists are never loaded. */
async function load_user_playlist_shapes(ex: Executor, user_id: string): Promise<{ shapes: Map<string, PlaylistShape>; added_at: Map<string, Date> }> {
	const [playlists, tracks, inherited_playlists, inherited_searches] = await all_queries(ex, [
		ex.select({ id: playlists_table.id, sort_mode: playlists_table.sort_mode })
			.from(playlists_table)
			.where(and(eq(playlists_table.user_id, user_id), eq(playlists_table.deleted, false))),
		ex.select({ playlist_id: playlist_tracks_table.playlist_id, track_id: playlist_tracks_table.track_id, created_at: playlist_tracks_table.created_at })
			.from(playlist_tracks_table)
			.innerJoin(playlists_table, eq(playlists_table.id, playlist_tracks_table.playlist_id))
			.where(and(eq(playlists_table.user_id, user_id), eq(playlists_table.deleted, false), eq(playlist_tracks_table.deleted, false)))
			.orderBy(asc(playlist_tracks_table.created_at), asc(playlist_tracks_table.track_id)),
		ex.select({ playlist_id: playlist_inherited_playlists_table.playlist_id, ref_id: playlist_inherited_playlists_table.ref_id, mode: playlist_inherited_playlists_table.mode })
			.from(playlist_inherited_playlists_table)
			.innerJoin(playlists_table, eq(playlists_table.id, playlist_inherited_playlists_table.playlist_id))
			.where(and(eq(playlists_table.user_id, user_id), eq(playlist_inherited_playlists_table.deleted, false)))
			.orderBy(asc(playlist_inherited_playlists_table.id)),
		ex.select({ playlist_id: playlist_inherited_searches_table.playlist_id, query: playlist_inherited_searches_table.query, mode: playlist_inherited_searches_table.mode })
			.from(playlist_inherited_searches_table)
			.innerJoin(playlists_table, eq(playlists_table.id, playlist_inherited_searches_table.playlist_id))
			.where(and(eq(playlists_table.user_id, user_id), eq(playlist_inherited_searches_table.deleted, false)))
			.orderBy(asc(playlist_inherited_searches_table.id))
	]);

	const shapes = new Map<string, PlaylistShape>(playlists.map(p => [p.id, { track_ids: [], inherited_playlists: [], inherited_searchs: [], sort: to_sort_type(p.sort_mode) }]));
	const added_at = new Map<string, Date>();
	for (const t of tracks) {
		shapes.get(t.playlist_id)?.track_ids.push(t.track_id);
		if (!added_at.has(t.track_id)) added_at.set(t.track_id, t.created_at);
	}
	for (const i of inherited_playlists) {
		const mode = to_inheritance_mode(i.mode);
		if (mode !== undefined) shapes.get(i.playlist_id)?.inherited_playlists.push({ uuid: i.ref_id, mode });
	}
	for (const s of inherited_searches) {
		const mode = to_inheritance_mode(s.mode);
		if (mode !== undefined && s.query !== null) shapes.get(s.playlist_id)?.inherited_searchs.push({ query: s.query, mode });
	}
	return { shapes, added_at };
}

/** The user's non-deleted library track ids, in the client's library order (added date, then id). */
async function load_library_ids(ex: Executor, user_id: string): Promise<string[]> {
	const rows = await ex.select({ track_id: user_tracks_table.track_id })
		.from(user_tracks_table)
		.where(and(eq(user_tracks_table.user_id, user_id), eq(user_tracks_table.deleted, false)))
		.orderBy(asc(user_tracks_table.created_at), asc(user_tracks_table.track_id));
	return rows.map(r => r.track_id);
}

/** Resolves a playlist with lib-origin's pure resolver. Returns [] for playlists the user doesn't own. */
export async function resolve_playlist(ex: Executor, user_id: string, playlist_id: string): Promise<Track[]> {
	const { shapes, added_at } = await load_user_playlist_shapes(ex, user_id);
	if (!shapes.has(playlist_id)) return [];
	const { ids, needs_library } = reachable_playlists(playlist_id, shapes);

	const library_ids = needs_library ? await load_library_ids(ex, user_id) : [];
	const wanted = new Set(library_ids);
	for (const id of ids) for (const track_id of shapes.get(id)!.track_ids) wanted.add(track_id);
	const rows = await load_track_rows(ex, user_id, [...wanted], added_at);
	const tracks = new Map<string, Track>();
	for (const [id, row] of rows) tracks.set(id, row_to_track(row));
	const hydrate = (track_ids: readonly string[]) => track_ids.flatMap(id => tracks.get(id) ?? []);

	return resolve_playlist_tracks(playlist_id, {
		get_playlist: (uuid) => {
			if (!ids.has(uuid)) return undefined;
			const shape = shapes.get(uuid)!;
			return { tracks: hydrate(shape.track_ids), inherited_playlists: shape.inherited_playlists, inherited_searchs: shape.inherited_searchs, sort: shape.sort };
		},
		library_tracks: () => hydrate(library_ids)
	});
}

const CACHE_MAX_ENTRIES = 2000;
/** `user_id` → playlist_id → resolved track ids. Map order doubles as LRU order over users. */
const cache = new Map<string, Map<string, string[]>>();
/** Bumped on every invalidation so a resolution that raced an invalidation isn't cached. */
const generations = new Map<string, number>();
/** Bumped when every user's entries are invalidated at once. */
let global_generation = 0;
let cached_entries = 0;

export function invalidate_user_cache(user_id: string) {
	generations.set(user_id, (generations.get(user_id) ?? 0) + 1);
	const entry = cache.get(user_id);
	if (entry) {
		cached_entries -= entry.size;
		cache.delete(user_id);
	}
}

/** Drops every cached resolution, e.g. after a merge changed which ids tracks resolve to. */
export function invalidate_all_caches() {
	global_generation++;
	cache.clear();
	cached_entries = 0;
}

on('user_library_changed', ({ user_id }) => { invalidate_user_cache(user_id); });
on('ids_redirected', () => { invalidate_all_caches(); });

function cache_put(user_id: string, playlist_id: string, track_ids: string[]) {
	let entry = cache.get(user_id);
	if (entry) cache.delete(user_id);
	else entry = new Map();
	cache.set(user_id, entry);
	if (!entry.has(playlist_id)) cached_entries++;
	entry.set(playlist_id, track_ids);
	for (const [oldest_user, oldest] of cache) {
		if (cached_entries <= CACHE_MAX_ENTRIES || oldest_user === user_id) break;
		cached_entries -= oldest.size;
		cache.delete(oldest_user);
	}
}

/** Full resolved track id list of a playlist, including inheritance. Cached per user + playlist. */
export async function resolve_playlist_track_ids(user_id: string, playlist_id: string): Promise<string[]> {
	const hit = cache.get(user_id)?.get(playlist_id);
	if (hit) return hit.slice();
	const generation = generations.get(user_id) ?? 0;
	const global = global_generation;
	const ids = (await resolve_playlist(db, user_id, playlist_id)).map(t => t.uid);
	if ((generations.get(user_id) ?? 0) === generation && global_generation === global) cache_put(user_id, playlist_id, ids);
	return ids.slice();
}
