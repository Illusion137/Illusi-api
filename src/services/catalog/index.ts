import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Router } from 'express';
import { sort_playlist_tracks, track_query_filter } from '@illusive/playlist_resolution';
import { z } from 'zod';
import { all_queries, db } from '../../db';
import {
	album_tracks_table, albums_table, artist_albums_table, linked_playlists_table, playlists_table, read_versions_table, similar_artists_table, track_play_counts_table, track_plays_table,
	track_alignment_table, track_vocals_table, tracks_artists_table, tracks_table, user_read_versions_table, user_recent_searches, user_tracks_table, users_table, sort_type, album_type
} from '../../db/schema';
import { unflatten_segments } from '../analyzer/contract';
import { emit } from '../../core/events';
import { HttpError, json_body, parse_body, require_user, uuid_schema } from '../../core/http';
import { RateLimiter, rate_limit_user } from '../../core/rate_limit';
import { resolve_redirect, resolve_redirects } from '../../core/redirects';
import { resolve_playlist_track_ids } from '../playlists';
import { to_sort_type } from '../playlists/enums';
import { load_track_rows } from '../playlists/load_tracks';
import { row_to_track } from '../playlists/track_adapter';
import { load_user } from '../sync/rows';
import { similar_tracks, taste_search } from '../vectors';
import { bool_query, decode_cursor, page_from, page_query_shape, parse_query, slice_page } from './paging';
import { detect_service_id, search_albums, search_artists, search_playlists, search_tracks, SEARCH_TYPES } from './search';
import type { SearchType } from './search';
import { DEFAULT_LIMIT as SUGGESTION_DEFAULT_LIMIT, MAX_LIMIT as SUGGESTION_MAX_LIMIT, suggest } from './suggestions';
import { answer_not_modified, matches_if_none_match, validator_tag } from './validators';
import { album_views, artist_views, in_order, playlist_views, track_views } from './views';

export type { AlbumView, ArtistView, PlaylistView, TrackView } from './views';

/**
 * Mounted after `require_auth`: the read API. Nothing here writes; library and playlist changes
 * go through sync push, catalog additions through `/contribute`.
 */
export const catalog_router = Router();

const read_limit = rate_limit_user('read', 600, 60_000);
const search_limit = rate_limit_user('search', 120, 60_000);
/** Asked on every keystroke, so looser than search (nginx still caps each IP). */
const suggestions_limit = rate_limit_user('search_suggestions', 300, 60_000);
/** Suggestions are cheap to re-ask and go stale fast as the user types; clients may reuse one this long. */
const SUGGESTIONS_MAX_AGE_S = 30;
/**
 * Each alignment analysis costs minutes of CPU, so a user queues at most this many distinct tracks an hour. Asking for
 * the same track again within the hour doesn't count (or queue it again).
 */
const ALIGNMENT_REQUESTS_PER_HOUR = 30;
const alignment_asked = new RateLimiter(1, 3_600_000);
const alignment_budget = new RateLimiter(ALIGNMENT_REQUESTS_PER_HOUR, 3_600_000);

type PlaylistRow = typeof playlists_table.$inferSelect;

function id_param(raw: unknown, what: string): string {
	const parsed = uuid_schema.safeParse(raw);
	if (!parsed.success) throw new HttpError(400, `invalid ${what} id`);
	return parsed.data;
}

/** Follows merges: the surviving id, and the requested one if it differs. */
async function follow(raw: unknown, what: string): Promise<{ id: string; redirected_from?: string }> {
	const requested = id_param(raw, what);
	const id = await resolve_redirect(db, requested);
	return id === requested ? { id } : { id, redirected_from: requested };
}

function with_redirect<T extends object>(view: T, redirected_from: string | undefined): T & { redirected_from?: string } {
	return redirected_from ? { ...view, redirected_from } : view;
}

const limit_only = (max: number, fallback: number) => z.object({ limit: z.coerce.number().int().min(1).max(max).default(fallback) });
const page_query = z.object(page_query_shape);

catalog_router.get('/me', read_limit, async (req, res) => {
	const user = require_user(req);
	const [profile, [tracks], [playlists], [plays]] = await all_queries(db, [
		load_user(db, user.id),
		db.select({ n: count() }).from(user_tracks_table).where(and(eq(user_tracks_table.user_id, user.id), eq(user_tracks_table.deleted, false))),
		db.select({ n: count() }).from(playlists_table).where(and(eq(playlists_table.user_id, user.id), eq(playlists_table.deleted, false))),
		db.select({ n: count() }).from(track_plays_table).where(eq(track_plays_table.user_id, user.id))
	]);
	if (!profile) throw new HttpError(404, 'user not found');
	res.json({ user: profile, stats: { tracks: tracks.n, playlists: playlists.n, plays: plays.n } });
});

const library_query = z.object({
	...page_query_shape,
	sort: z.enum(sort_type.enumValues).default('ADDED_DATE_HILOW'),
	q: z.string().max(256).optional()
});

/** Sorted and filtered with lib-origin, exactly like a search-inherited playlist. */
catalog_router.get('/me/library', read_limit, async (req, res) => {
	const user = require_user(req);
	const query = parse_query(library_query, req);
	const offset = decode_cursor(query.cursor);
	const library = await db.select({ track_id: user_tracks_table.track_id })
		.from(user_tracks_table)
		.where(and(eq(user_tracks_table.user_id, user.id), eq(user_tracks_table.deleted, false)))
		.orderBy(asc(user_tracks_table.created_at), asc(user_tracks_table.track_id));
	const rows = await load_track_rows(db, user.id, library.map(r => r.track_id));
	let tracks = [...rows.values()].map(row_to_track);
	if (query.q?.trim()) tracks = track_query_filter(tracks, query.q);
	const page = slice_page(sort_playlist_tracks(to_sort_type(query.sort), tracks).map(t => t.uid), offset, query.limit);
	res.json({ items: in_order(page.items, await track_views(db, user.id, page.items)), next_cursor: page.next_cursor });
});

const my_playlists_query = z.object({ include_archived: bool_query.default(true), include_deleted: bool_query.default(false) });

catalog_router.get('/me/playlists', read_limit, async (req, res) => {
	const user = require_user(req);
	const query = parse_query(my_playlists_query, req);
	const rows = await db.select().from(playlists_table)
		.where(and(
			eq(playlists_table.user_id, user.id),
			query.include_deleted ? undefined : eq(playlists_table.deleted, false),
			query.include_archived ? undefined : eq(playlists_table.archived, false)
		))
		.orderBy(desc(playlists_table.pinned), asc(playlists_table.created_at), asc(playlists_table.id));
	res.json({ items: await playlist_views(db, user.id, rows) });
});

catalog_router.get('/me/plays', read_limit, async (req, res) => {
	const user = require_user(req);
	const query = parse_query(page_query, req);
	const offset = decode_cursor(query.cursor);
	const rows = await db.select({ id: track_plays_table.id, client_id: track_plays_table.client_id, created_at: track_plays_table.created_at, track_id: track_plays_table.track_id })
		.from(track_plays_table)
		.where(eq(track_plays_table.user_id, user.id))
		.orderBy(desc(track_plays_table.created_at), desc(track_plays_table.id))
		.limit(query.limit + 1)
		.offset(offset);
	const page = page_from(rows, offset, query.limit);
	const views = await track_views(db, user.id, page.items.map(r => r.track_id));
	res.json({
		items: page.items.flatMap((r) => {
			const track = views.get(r.track_id);
			return track ? [{ id: r.id, client_id: r.client_id, created_at: r.created_at, track }] : [];
		}),
		next_cursor: page.next_cursor
	});
});

catalog_router.get('/me/recent_searches', read_limit, async (req, res) => {
	const user = require_user(req);
	const { limit } = parse_query(limit_only(200, 50), req);
	const items = await db.select().from(user_recent_searches)
		.where(eq(user_recent_searches.user_id, user.id))
		.orderBy(desc(user_recent_searches.created_at), desc(user_recent_searches.id))
		.limit(limit);
	res.json({ items });
});

catalog_router.get('/me/linked_playlists', read_limit, async (req, res) => {
	const user = require_user(req);
	const items = await db.select().from(linked_playlists_table)
		.where(and(eq(linked_playlists_table.user_id, user.id), eq(linked_playlists_table.deleted, false)))
		.orderBy(asc(linked_playlists_table.created_at), asc(linked_playlists_table.service_uri));
	res.json({ items });
});

const public_playlists_query = z.object({ ...page_query_shape, q: z.string().trim().max(256).optional() });

async function playlist_page(user_id: string, where: SQL | undefined, offset: number, limit: number, order: SQL[]) {
	const rows = await db.select().from(playlists_table).where(where).orderBy(...order).limit(limit + 1).offset(offset);
	const page = page_from(rows, offset, limit);
	return { items: await playlist_views(db, user_id, page.items), next_cursor: page.next_cursor };
}

// Registered before `/playlists/:id`.
catalog_router.get('/playlists/public', read_limit, async (req, res) => {
	const user = require_user(req);
	const query = parse_query(public_playlists_query, req);
	const q = query.q || undefined;
	const where = and(
		eq(playlists_table.public, true),
		eq(playlists_table.deleted, false),
		q ? sql`illusi_search_text(${playlists_table.title}) like '%' || illusi_search_text(${q.replace(/[\\%_]/gu, m => `\\${m}`)}) || '%'` : undefined
	);
	res.json(await playlist_page(user.id, where, decode_cursor(query.cursor), query.limit, [desc(playlists_table.modified_at), asc(playlists_table.id)]));
});

/** The owner, or anyone for a public non-deleted playlist. Otherwise 404, so a private playlist's existence isn't revealed. */
async function readable_playlist(user_id: string, raw_id: unknown): Promise<PlaylistRow> {
	const id = id_param(raw_id, 'playlist');
	const [playlist] = await db.select().from(playlists_table).where(eq(playlists_table.id, id));
	if (!playlist || (playlist.user_id !== user_id && (!playlist.public || playlist.deleted))) throw new HttpError(404, 'playlist not found');
	return playlist;
}

catalog_router.get('/playlists/:id', read_limit, async (req, res) => {
	const user = require_user(req);
	const playlist = await readable_playlist(user.id, req.params.id);
	const [view] = await playlist_views(db, user.id, [playlist]);
	res.json(view);
});

/** Resolved as the owner sees it; the `user` overlay is the caller's. */
catalog_router.get('/playlists/:id/tracks', read_limit, async (req, res) => {
	const user = require_user(req);
	const playlist = await readable_playlist(user.id, req.params.id);
	const query = parse_query(page_query, req);
	const ids = playlist.deleted ? [] : await resolve_playlist_track_ids(playlist.user_id, playlist.id);
	const page = slice_page(ids, decode_cursor(query.cursor), query.limit);
	res.json({ items: in_order(page.items, await track_views(db, user.id, page.items)), next_cursor: page.next_cursor });
});

catalog_router.get('/users/:id/playlists', read_limit, async (req, res) => {
	const user = require_user(req);
	const owner_id = id_param(req.params.id, 'user');
	const query = parse_query(page_query, req);
	const where = and(eq(playlists_table.user_id, owner_id), eq(playlists_table.deleted, false), owner_id === user.id ? undefined : eq(playlists_table.public, true));
	res.json(await playlist_page(user.id, where, decode_cursor(query.cursor), query.limit, [desc(playlists_table.pinned), asc(playlists_table.created_at), asc(playlists_table.id)]));
});

/** The user, and whether the caller may list their imports: their own, or anyone's who made them public */
async function profile_owner(viewer_id: string, raw_id: unknown) {
	const owner_id = id_param(raw_id, 'user');
	const [owner] = await db.select({ id: users_table.id, username: users_table.username, avatar_id: users_table.avatar_id, public_imports: users_table.public_imports })
		.from(users_table).where(eq(users_table.id, owner_id));
	if (!owner) throw new HttpError(404, 'user not found');
	return { owner, is_self: owner_id === viewer_id, imports_visible: owner_id === viewer_id || owner.public_imports };
}

function imports_of(owner_id: string) {
	return and(eq(user_tracks_table.user_id, owner_id), eq(user_tracks_table.deleted, false), eq(tracks_table.imported, true));
}

/** A user as an artist: their public playlists and, when visible, the tracks they imported. import_count is null when hidden. */
catalog_router.get('/users/:id', read_limit, async (req, res) => {
	const user = require_user(req);
	const { owner, is_self, imports_visible } = await profile_owner(user.id, req.params.id);
	const [[playlists], imports] = await Promise.all([
		db.select({ n: count() }).from(playlists_table).where(and(eq(playlists_table.user_id, owner.id), eq(playlists_table.deleted, false), is_self ? undefined : eq(playlists_table.public, true))),
		imports_visible
			? db.select({ n: count() }).from(user_tracks_table).innerJoin(tracks_table, eq(tracks_table.id, user_tracks_table.track_id)).where(imports_of(owner.id))
			: Promise.resolve(null)
	]);
	res.json({ ...owner, is_self, playlist_count: playlists.n, import_count: imports?.[0].n ?? null });
});

/** Tracks the user imported, newest first. 403 unless they're the caller's or the user made them public. */
catalog_router.get('/users/:id/imports', read_limit, async (req, res) => {
	const user = require_user(req);
	const { owner, imports_visible } = await profile_owner(user.id, req.params.id);
	if (!imports_visible) throw new HttpError(403, 'imports are private', { code: 'IMPORTS_PRIVATE' });
	const query = parse_query(page_query, req);
	const offset = decode_cursor(query.cursor);
	const rows = await db.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
		.innerJoin(tracks_table, eq(tracks_table.id, user_tracks_table.track_id))
		.where(imports_of(owner.id))
		.orderBy(desc(user_tracks_table.created_at), asc(user_tracks_table.track_id))
		.limit(query.limit + 1).offset(offset);
	const page = page_from(rows.map(r => r.track_id), offset, query.limit);
	res.json({ items: in_order(page.items, await track_views(db, user.id, page.items)), next_cursor: page.next_cursor });
});

catalog_router.get('/tracks/:id', read_limit, async (req, res) => {
	const user = require_user(req);
	if (await answer_not_modified(req, res, { user_id: user.id })) return;
	const { id, redirected_from } = await follow(req.params.id, 'track');
	const view = (await track_views(db, user.id, [id])).get(id);
	if (!view) throw new HttpError(404, 'track not found');
	res.json(with_redirect(view, redirected_from));
});

export const TRACK_BATCH_MAX = 500;
const batch_schema = z.object({ ids: z.array(uuid_schema).min(1).max(TRACK_BATCH_MAX) });

catalog_router.post('/tracks/batch', read_limit, json_body('64kb'), async (req, res) => {
	const user = require_user(req);
	const { ids } = parse_body(batch_schema, req.body);
	const current = await resolve_redirects(db, ids);
	const views = await track_views(db, user.id, [...new Set(current.values())]);
	const items = [];
	const missing: string[] = [];
	for (const requested of ids) {
		const id = current.get(requested)!;
		const view = views.get(id);
		if (view) items.push(with_redirect(view, id === requested ? undefined : requested));
		else missing.push(requested);
	}
	res.json({ items, missing });
});

catalog_router.get('/tracks/:id/similar', read_limit, async (req, res) => {
	const user = require_user(req);
	const { id } = await follow(req.params.id, 'track');
	const { limit } = parse_query(limit_only(100, 20), req);
	const similar = await similar_tracks(id, limit, user.id);
	const ids = similar.map(s => s.track_id);
	res.json({ items: in_order(ids, await track_views(db, user.id, ids)) });
});

/** Vocal activity detected in the track's media file (only tracks with uploaded media have it). */
catalog_router.get('/tracks/:id/vocals', read_limit, async (req, res) => {
	const { id, redirected_from } = await follow(req.params.id, 'track');
	const [row] = await db.select().from(track_vocals_table)
		.where(and(eq(track_vocals_table.track_id, id), eq(track_vocals_table.status, 'DONE')));
	if (!row) throw new HttpError(404, 'no vocals detected for this track');
	res.json(with_redirect({
		track_id: id,
		resource_id: row.resource_id,
		model: row.model,
		hop_ms: row.hop_ms,
		window_ms: row.window_ms,
		duration_ms: row.duration_ms,
		voice: row.voice ?? [],
		segments: unflatten_segments(row.segments ?? []),
		rhythm: row.beats === null
			? null
			: {
					model: row.rhythm_model,
					bpm: row.rhythm_bpm,
					confidence: row.rhythm_confidence,
					beats_ms: row.beats,
					bpm_estimates: row.bpm_estimates ?? []
				},
		words: row.words === null
			? null
			: {
					model: row.words_model,
					words: row.words.map((text, i) => ({
						text,
						start_ms: row.word_times?.[2 * i] ?? 0,
						end_ms: row.word_times?.[2 * i + 1] ?? 0,
						probability: row.word_probabilities?.[i] ?? 0
					}))
				},
		speech: row.speech === null ? null : { model: row.speech_model, hop_ms: row.speech_hop_ms, voice: row.speech },
		beat_grid: row.grid_beats === null
			? null
			: { model: row.beat_grid_model, beats_ms: row.grid_beats, downbeats_ms: row.downbeats ?? [] },
		analyzed_at: row.modified_at
	}, redirected_from));
});

/**
 * What the app aligns the track's plain lyrics against, from the separated vocals of its media file. Never a synced
 * version: the app builds that itself. Until the analyzer has stored it, asking queues the analysis, up to
 * `ALIGNMENT_REQUESTS_PER_HOUR` tracks per user (the app only asks while a user plays a track whose lyrics are all
 * unsynced; the job checks that again).
 */
catalog_router.get('/tracks/:id/alignment', read_limit, async (req, res) => {
	const { id, redirected_from } = await follow(req.params.id, 'track');
	const [row] = await db.select().from(track_alignment_table)
		.where(and(eq(track_alignment_table.track_id, id), eq(track_alignment_table.status, 'DONE')));
	if (!row) {
		const user = require_user(req);
		if (await alignment_asked.hit(`${user.id}:${id}`) && await alignment_budget.hit(user.id)) emit('alignment_requested', { track_id: id });
		throw new HttpError(404, 'no alignment analysis for this track yet');
	}
	const repeats = row.repeats ?? [];
	res.json(with_redirect({
		track_id: id,
		resource_id: row.resource_id,
		model: row.model,
		duration_ms: row.duration_ms,
		frame_ms: row.frame_ms,
		alphabet: row.alphabet,
		letter_scale: row.letter_scale,
		letters: row.letters?.toString('base64') ?? '',
		loudness: row.loudness?.toString('base64') ?? '',
		words: {
			model: row.words_model,
			words: (row.words ?? []).map((text, i) => ({
				text,
				start_ms: row.word_times?.[2 * i] ?? 0,
				end_ms: row.word_times?.[2 * i + 1] ?? 0,
				probability: row.word_probabilities?.[i] ?? 0
			}))
		},
		beat_grid: { model: row.beat_grid_model, beats_ms: row.grid_beats ?? [], downbeats_ms: row.downbeats ?? [] },
		repeats: Array.from({ length: Math.floor(repeats.length / 3) }, (_, i) => ({
			start_ms: repeats[3 * i],
			end_ms: repeats[3 * i + 1],
			lag_ms: repeats[3 * i + 2],
			strength: row.repeat_strengths?.[i] ?? 0
		})),
		analyzed_at: row.modified_at
	}, redirected_from));
});

catalog_router.get('/albums/:id', read_limit, async (req, res) => {
	const user = require_user(req);
	if (await answer_not_modified(req, res, { user_id: user.id })) return;
	const { id, redirected_from } = await follow(req.params.id, 'album');
	const album = (await album_views(db, [id])).get(id);
	if (!album) throw new HttpError(404, 'album not found');
	const rows = await db.select({ id: tracks_table.id, title: tracks_table.title, track_number: album_tracks_table.track_number })
		.from(tracks_table)
		.leftJoin(album_tracks_table, and(eq(album_tracks_table.track_id, tracks_table.id), eq(album_tracks_table.album_id, id)))
		.where(or(eq(tracks_table.album_id, id), eq(album_tracks_table.album_id, id)))
		.orderBy(sql`${album_tracks_table.track_number} asc nulls last`, asc(tracks_table.title), asc(tracks_table.id));
	const ids = [...new Set(rows.map(r => r.id))];
	res.json({ album: with_redirect(album, redirected_from), tracks: in_order(ids, await track_views(db, user.id, ids)) });
});

catalog_router.get('/artists/:id', read_limit, async (req, res) => {
	const user = require_user(req);
	if (await answer_not_modified(req, res, { user_id: user.id })) return;
	const { id, redirected_from } = await follow(req.params.id, 'artist');
	const view = (await artist_views(db, user.id, [id])).get(id);
	if (!view) throw new HttpError(404, 'artist not found');
	res.json(with_redirect(view, redirected_from));
});

const artist_albums_query = z.object({ ...page_query_shape, album_type: z.enum(album_type.enumValues).optional() });

catalog_router.get('/artists/:id/albums', read_limit, async (req, res) => {
	require_user(req);
	if (await answer_not_modified(req, res)) return;
	const { id } = await follow(req.params.id, 'artist');
	const query = parse_query(artist_albums_query, req);
	const offset = decode_cursor(query.cursor);
	const rows = await db.select({ id: albums_table.id })
		.from(albums_table)
		.leftJoin(artist_albums_table, and(eq(artist_albums_table.album_id, albums_table.id), eq(artist_albums_table.artist_id, id)))
		.where(and(
			or(eq(albums_table.artist_id, id), eq(artist_albums_table.artist_id, id)),
			query.album_type ? eq(albums_table.album_type, query.album_type) : undefined
		))
		.orderBy(sql`${artist_albums_table.position} asc nulls last`, sql`${albums_table.release_date} desc nulls last`, asc(albums_table.name), asc(albums_table.id))
		.limit(query.limit + 1)
		.offset(offset);
	const page = page_from(rows.map(r => r.id), offset, query.limit);
	res.json({ items: in_order(page.items, await album_views(db, page.items)), next_cursor: page.next_cursor });
});

const artist_tracks_query = z.object({ ...page_query_shape, sort: z.enum(['popular', 'newest', 'title']).default('popular') });

catalog_router.get('/artists/:id/tracks', read_limit, async (req, res) => {
	const user = require_user(req);
	const query = parse_query(artist_tracks_query, req);
	if (await answer_not_modified(req, res, { user_id: user.id, plays: query.sort === 'popular' })) return;
	const { id } = await follow(req.params.id, 'artist');
	const offset = decode_cursor(query.cursor);
	const order: SQL[] = {
		popular: [sql`coalesce(${track_play_counts_table.plays}, 0) desc`, asc(tracks_table.title)],
		newest: [sql`coalesce(${albums_table.release_date}, ${tracks_table.created_at}) desc`, asc(tracks_table.title)],
		title: [asc(tracks_table.title)]
	}[query.sort];
	const rows = await db.select({ id: tracks_table.id })
		.from(tracks_artists_table)
		.innerJoin(tracks_table, eq(tracks_table.id, tracks_artists_table.track_id))
		.leftJoin(albums_table, eq(albums_table.id, tracks_table.album_id))
		.leftJoin(track_play_counts_table, eq(track_play_counts_table.track_id, tracks_table.id))
		.where(eq(tracks_artists_table.artist_id, id))
		.orderBy(...order, asc(tracks_table.id))
		.limit(query.limit + 1)
		.offset(offset);
	const page = page_from(rows.map(r => r.id), offset, query.limit);
	res.json({ items: in_order(page.items, await track_views(db, user.id, page.items)), next_cursor: page.next_cursor });
});

/** Tracks per artist sampled for the vector fallback of similar artists. */
const SIMILAR_ARTIST_SAMPLE_TRACKS = 200;

/** Stored pairs in either direction first, then artists of the tracks nearest the artist's mean vector. */
catalog_router.get('/artists/:id/similar', read_limit, async (req, res) => {
	const user = require_user(req);
	const { id } = await follow(req.params.id, 'artist');
	const { limit } = parse_query(limit_only(100, 20), req);
	const stored = await db.select({ a: similar_artists_table.artist_id, b: similar_artists_table.similar_artist_id })
		.from(similar_artists_table)
		.where(or(eq(similar_artists_table.artist_id, id), eq(similar_artists_table.similar_artist_id, id)))
		.orderBy(asc(similar_artists_table.created_at));
	const ids = new Set<string>();
	for (const pair of stored) {
		const other = pair.a === id ? pair.b : pair.a;
		if (other !== id) ids.add(other);
	}

	if (ids.size < limit) {
		const own = await db.select({ track_id: tracks_artists_table.track_id }).from(tracks_artists_table)
			.where(eq(tracks_artists_table.artist_id, id)).limit(SIMILAR_ARTIST_SAMPLE_TRACKS);
		const own_ids = own.map(r => r.track_id);
		const near = await taste_search(own_ids, limit * 5, own_ids);
		if (near.length > 0) {
			const credits = await db.select({ track_id: tracks_artists_table.track_id, artist_id: tracks_artists_table.artist_id })
				.from(tracks_artists_table).where(inArray(tracks_artists_table.track_id, near.map(n => n.track_id)));
			const by_track = new Map<string, string[]>();
			for (const c of credits) by_track.set(c.track_id, [...(by_track.get(c.track_id) ?? []), c.artist_id]);
			for (const n of near) {
				for (const artist_id of by_track.get(n.track_id) ?? []) if (artist_id !== id && ids.size < limit) ids.add(artist_id);
			}
		}
	}
	const ordered = [...ids].slice(0, limit);
	res.json({ items: in_order(ordered, await artist_views(db, user.id, ordered)) });
});

const search_query = z.object({
	q: z.string().trim().min(1).max(256),
	types: z.string().max(64).optional().transform((value, ctx) => {
		if (value === undefined || value.trim() === '') return [...SEARCH_TYPES];
		const types = [...new Set(value.split(',').map(t => t.trim()).filter(Boolean))];
		for (const t of types) {
			if (!(SEARCH_TYPES as readonly string[]).includes(t)) {
				ctx.addIssue({ code: 'custom', message: `unknown type ${t}` });
				return z.NEVER;
			}
		}
		return types as SearchType[];
	}),
	scope: z.enum(['global', 'library']).default('global'),
	...page_query_shape
});

const RESULT_KEYS = { track: 'tracks', album: 'albums', artist: 'artists', playlist: 'playlists' } as const satisfies Record<SearchType, string>;

catalog_router.get('/search', search_limit, async (req, res) => {
	const user = require_user(req);
	const query = parse_query(search_query, req);
	if (query.cursor !== undefined && query.types.length !== 1) throw new HttpError(400, 'cursor needs exactly one type');
	const offset = decode_cursor(query.cursor);
	const link = detect_service_id(query.q);

	const out: Partial<Record<(typeof RESULT_KEYS)[SearchType], unknown>> = {};
	await Promise.all(query.types.map(async (type) => {
		const key = RESULT_KEYS[type];
		if (type === 'track') {
			const page = slice_page(await search_tracks(db, user.id, query.q, query.scope, link), offset, query.limit);
			out[key] = { items: in_order(page.items, await track_views(db, user.id, page.items)), next_cursor: page.next_cursor };
		} else if (type === 'album') {
			const page = slice_page(await search_albums(db, user.id, query.q, query.scope, link), offset, query.limit);
			out[key] = { items: in_order(page.items, await album_views(db, page.items)), next_cursor: page.next_cursor };
		} else if (type === 'artist') {
			const page = slice_page(await search_artists(db, user.id, query.q, query.scope, link), offset, query.limit);
			out[key] = { items: in_order(page.items, await artist_views(db, user.id, page.items)), next_cursor: page.next_cursor };
		} else {
			const page = slice_page(await search_playlists(db, user.id, query.q, query.scope), offset, query.limit);
			const rows = page.items.length === 0 ? [] : await db.select().from(playlists_table).where(inArray(playlists_table.id, page.items));
			const views = new Map((await playlist_views(db, user.id, rows)).map(v => [v.id, v]));
			out[key] = { items: in_order(page.items, views), next_cursor: page.next_cursor };
		}
	}));
	res.json(out);
});

const suggestions_query = z.object({
	q: z.string().max(256).default(''),
	limit: z.coerce.number().int().min(1).max(SUGGESTION_MAX_LIMIT).default(SUGGESTION_DEFAULT_LIMIT)
});

catalog_router.get('/search/suggestions', suggestions_limit, async (req, res) => {
	const user = require_user(req);
	const query = parse_query(suggestions_query, req);
	// Versions read before building, as for other catalog reads: a concurrent write can only cost a later 304.
	const [versions] = await db.select({
		catalog: sql<number>`coalesce((select ${read_versions_table.version} from ${read_versions_table} where ${read_versions_table.key} = 'catalog'), 0)`.mapWith(Number),
		plays: sql<number>`coalesce((select ${read_versions_table.version} from ${read_versions_table} where ${read_versions_table.key} = 'plays'), 0)`.mapWith(Number),
		user: sql<number>`coalesce((select ${user_read_versions_table.version} from ${user_read_versions_table} where ${user_read_versions_table.user_id} = ${user.id}), 0)`.mapWith(Number),
		recent: sql<string>`(select count(*) || ':' || coalesce(max(${user_recent_searches.id}), 0) from ${user_recent_searches} where ${user_recent_searches.user_id} = ${user.id})`
	}).from(sql`(select 1) one`);
	const tag = validator_tag(`${req.originalUrl}|recent:${versions.recent}`, versions, user.id);
	res.setHeader('ETag', tag);
	res.setHeader('Cache-Control', `private, max-age=${SUGGESTIONS_MAX_AGE_S}`);
	if (matches_if_none_match(req.headers['if-none-match'], tag)) {
		res.status(304).end();
		return;
	}
	res.json(await suggest(db, user.id, query.q, query.limit, versions.catalog));
});
