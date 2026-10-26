/**
 * `POST /sync/pull`. A sweep returns every row in scope changed in `(since, upper]`, where
 * `upper` is a watermark taken on the sweep's first page. Each page is one REPEATABLE READ snapshot and
 * walks the phases below in order with keyset paging; the cursor carries `since`, `upper` and the position.
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db';
import type { Tx } from '../../db';
import {
	illusi_id_redirects_table, linked_playlists_table, playlist_inherited_playlists_table, playlist_inherited_searches_table, playlist_tracks_table,
	playlists_table, track_plays_table, user_recent_searches, user_tracks_table, users_table
} from '../../db/schema';
import type { ActionType } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { logger } from '../../core/log';
import * as analyzer from '../analyzer';
import { research_actions } from '../backpack';
import * as itunes from '../itunes';
import { get_best_lyrics, lyrics_actions_for_tracks, queue_never_looked_up } from '../lyrics';
import { pending_upload_actions } from '../media';
import { resolve_playlist_track_ids } from '../playlists';
import { encode_cursor, in_progress, next_cursor } from './cursor';
import type { Cursor } from './cursor';
import { load_album_bundles, load_artist_bundles, load_track_bundles, load_user } from './rows';
import { empty_rows } from './types';
import type { SyncPullResponse, SyncRows } from './types';

const log = logger('sync');

/** Row budget per page; a bundle (track/album/artist with its related rows) costs more than a plain row. */
export const PAGE_BUDGET = 2_000;
const BUNDLE_COST = 5;
const LYRICS_ACTIONS_PER_PAGE = 10;
const UPLOAD_ACTIONS_PER_PULL = 10;
const RESEARCH_ACTIONS_PER_PULL = 5;
/** Safety margin under the watermark for app-clock `modified_at` values (`$onUpdate`) and clock skew. */
const WATERMARK_MARGIN = '2 seconds';
/** A transaction open longer than this no longer holds the watermark back. */
const WATERMARK_MAX_LAG = '10 minutes';

export interface Scope { tracks: string[]; albums: string[]; artists: string[] }

interface PullContext {
	tx: Tx;
	user: AuthUser;
	since: string | null;
	upper: string;
	scope: Scope;
	rows: SyncRows;
	page_tracks: string[];
	page_entities: string[];
}

/** A Postgres `uuid[]` as one parameter (scope lists can exceed the bind-parameter limit). */
export const uuid_array = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * Database time up to which every committed row is visible: the snapshot's `now()`, held back to the start
 * of the oldest transaction still running (its rows carry `now()` = its start but commit later), minus a margin.
 */
async function watermark(tx: Tx): Promise<string> {
	const [row] = await tx.execute<{ t: string }>(sql`
		select (least(now(), greatest(now() - ${WATERMARK_MAX_LAG}::interval, coalesce((
			select min(xact_start) from pg_stat_activity
			where datname = current_database() and backend_type = 'client backend' and xact_start is not null and pid <> pg_backend_pid()
		), now()))) - ${WATERMARK_MARGIN}::interval)::text as t
	`, 'objects');
	return row.t;
}

/** `(since, upper]` on a column given as raw SQL text (`x.modified_at`). */
function win(ctx: PullContext, column: string): SQL {
	const c = sql.raw(column);
	return ctx.since
		? sql`(${c} > ${ctx.since}::timestamptz and ${c} <= ${ctx.upper}::timestamptz)`
		: sql`${c} <= ${ctx.upper}::timestamptz`;
}
const win_col = (ctx: PullContext, column: Parameters<typeof gt>[0]) => (ctx.since
	? sql`(${column} > ${ctx.since}::timestamptz and ${column} <= ${ctx.upper}::timestamptz)`
	: sql`${column} <= ${ctx.upper}::timestamptz`);

/** Tracks reached only through inheritance; computed outside the snapshot, it only widens the scope. */
async function inherited_track_ids(user_id: string): Promise<string[]> {
	const rows = await db.execute<{ id: string }>(sql`
		select p.id from ${playlists_table} p where p.user_id = ${user_id} and not p.deleted and (
			exists(select 1 from ${playlist_inherited_playlists_table} i where i.playlist_id = p.id and not i.deleted)
			or exists(select 1 from ${playlist_inherited_searches_table} i where i.playlist_id = p.id and not i.deleted)
		)
	`, 'objects');
	const out = new Set<string>();
	for (const { id } of rows) {
		try {
			for (const track_id of await resolve_playlist_track_ids(user_id, id)) out.add(track_id);
		} catch (err) {
			log.warn(`could not resolve playlist ${id}`, err);
		}
	}
	return [...out];
}

/** Every track the user touches (library, own playlists, inherited) and their albums and artists. */
async function compute_scope(tx: Tx, user_id: string, inherited: readonly string[]): Promise<Scope> {
	const tracks = await tx.execute<{ id: string }>(sql`
		select track_id as id from user_tracks_table where user_id = ${user_id}
		union
		select pt.track_id from playlist_tracks_table pt join playlists_table p on p.id = pt.playlist_id where p.user_id = ${user_id}
		union
		select t.id from tracks_table t where t.id = any(${uuid_array(inherited)})
	`, 'objects');
	const track_ids = tracks.map(r => r.id).sort();
	const albums = await tx.execute<{ id: string }>(sql`
		select album_id as id from tracks_table where id = any(${uuid_array(track_ids)}) and album_id is not null
		union
		select album_id from album_tracks_table where track_id = any(${uuid_array(track_ids)})
	`, 'objects');
	const album_ids = albums.map(r => r.id).sort();
	const artists = await tx.execute<{ id: string }>(sql`
		select artist_id as id from tracks_artists_table where track_id = any(${uuid_array(track_ids)})
		union
		select artist_id from albums_table where id = any(${uuid_array(album_ids)}) and artist_id is not null
		union
		select artist_id from artist_albums_table where album_id = any(${uuid_array(album_ids)})
	`, 'objects');
	return { tracks: track_ids, albums: album_ids, artists: artists.map(r => r.id).sort() };
}

const itunes_join = (itunes_table: string) => sql.raw(`join ${itunes_table} it on it.id = (case when si.applemusic_id ~ '^[0-9]{1,18}$' then si.applemusic_id::bigint end)`);

/** A row "changed" if it or any related row changed in the window, including becoming part of the user's scope. */
function track_changed(ctx: PullContext): SQL {
	if (!ctx.since) return sql`true`;
	const u = ctx.user.id;
	return sql`(
		exists(select 1 from tracks_table x where x.id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from service_ids_table x where x.illusi_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from tracks_artists_table x where x.track_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from album_tracks_table x where x.track_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from tracks_producers_table x where x.track_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from track_sample_data_table x where x.id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from track_lyrics_table x where x.track_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from user_tracks_table x where x.user_id = ${u} and x.track_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from playlist_tracks_table x join playlists_table p on p.id = x.playlist_id where p.user_id = ${u} and x.track_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from service_ids_table si ${itunes_join('itunes_tracks_table')} where si.illusi_id = s.id and ${win(ctx, 'it.modified_at')})
	)`;
}

/** Tracks of the user whose library / playlist row changed in the window: their albums and artists newly enter scope. */
function newly_scoped_tracks(ctx: PullContext): SQL {
	const u = ctx.user.id;
	return sql`(
		select x.track_id from user_tracks_table x where x.user_id = ${u} and ${win(ctx, 'x.modified_at')}
		union
		select x.track_id from playlist_tracks_table x join playlists_table p on p.id = x.playlist_id where p.user_id = ${u} and ${win(ctx, 'x.modified_at')}
	)`;
}

function album_changed(ctx: PullContext): SQL {
	if (!ctx.since) return sql`true`;
	return sql`(
		exists(select 1 from albums_table x where x.id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from service_ids_table x where x.illusi_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from artist_albums_table x where x.album_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from album_tracks_table x where x.album_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from tracks_table x where x.album_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from service_ids_table si ${itunes_join('itunes_collections_table')} where si.illusi_id = s.id and ${win(ctx, 'it.modified_at')})
		or exists(select 1 from tracks_table x where x.album_id = s.id and x.id in ${newly_scoped_tracks(ctx)})
		or exists(select 1 from album_tracks_table x where x.album_id = s.id and x.track_id in ${newly_scoped_tracks(ctx)})
	)`;
}

function artist_changed(ctx: PullContext): SQL {
	if (!ctx.since) return sql`true`;
	return sql`(
		exists(select 1 from artists_table x where x.id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from service_ids_table x where x.illusi_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from artist_albums_table x where x.artist_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from tracks_artists_table x where x.artist_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from albums_table x where x.artist_id = s.id and ${win(ctx, 'x.modified_at')})
		or exists(select 1 from service_ids_table si ${itunes_join('itunes_artists_table')} where si.illusi_id = s.id and ${win(ctx, 'it.modified_at')})
		or exists(select 1 from tracks_artists_table x where x.artist_id = s.id and x.track_id in ${newly_scoped_tracks(ctx)})
	)`;
}

async function changed_ids(ctx: PullContext, ids: readonly string[], predicate: SQL, after: string | null, limit: number): Promise<string[]> {
	if (ids.length === 0) return [];
	const rows = await ctx.tx.execute<{ id: string }>(sql`
		select s.id::text as id from unnest(${uuid_array(ids)}) as s(id)
		where (${after}::uuid is null or s.id > ${after}::uuid) and ${predicate}
		order by s.id limit ${limit}
	`, 'objects');
	return rows.map(r => r.id);
}

/** Redirects into anything in scope, with the chains leading to them. */
async function load_redirects(ctx: PullContext) {
	const targets = [...ctx.scope.tracks, ...ctx.scope.albums, ...ctx.scope.artists];
	const found = new Map<string, { old_id: string; new_id: string; created_at: Date }>();
	let frontier = targets;
	for (let hop = 0; hop < 10 && frontier.length > 0; hop++) {
		const rows = await ctx.tx.select().from(illusi_id_redirects_table)
			.where(sql`${illusi_id_redirects_table.new_id} = any(${uuid_array(frontier)})`);
		const fresh = rows.filter(r => !found.has(r.old_id));
		for (const r of fresh) found.set(r.old_id, r);
		frontier = fresh.map(r => r.old_id);
	}
	const since = ctx.since ? new Date(ctx.since).getTime() : null;
	for (const r of found.values()) {
		if (since == null || r.created_at.getTime() >= since) ctx.rows.redirects.push({ old_id: r.old_id, new_id: r.new_id });
	}
}

interface Phase {
	name: string;
	cost: number;
	/** Adds up to `limit` items after `after` to the page; returns how many and the last key. */
	run(ctx: PullContext, after: string | null, limit: number): Promise<{ n: number; last: string | null }>;
}

const last_of = <T>(rows: readonly T[], key: (r: T) => string) => (rows.length > 0 ? key(rows[rows.length - 1]) : null);

const PHASES: Phase[] = [
	{
		name: 'redirects', cost: 0,
		async run(ctx) { await load_redirects(ctx); return { n: 0, last: null }; }
	},
	{
		name: 'user', cost: 1,
		async run(ctx) {
			const [row] = await ctx.tx.select({ id: users_table.id }).from(users_table).where(and(eq(users_table.id, ctx.user.id), win_col(ctx, users_table.modified_at)));
			if (row) ctx.rows.user = await load_user(ctx.tx, ctx.user.id);
			return { n: 0, last: null };
		}
	},
	{
		name: 'user_tracks', cost: 1,
		async run(ctx, after, limit) {
			const t = user_tracks_table;
			const rows = await ctx.tx.select().from(t)
				.where(and(eq(t.user_id, ctx.user.id), win_col(ctx, t.modified_at), after ? gt(t.track_id, after) : undefined))
				.orderBy(t.track_id).limit(limit);
			ctx.rows.user_tracks.push(...rows);
			return { n: rows.length, last: last_of(rows, r => r.track_id) };
		}
	},
	{
		name: 'playlists', cost: 1,
		async run(ctx, after, limit) {
			const t = playlists_table;
			const rows = await ctx.tx.select().from(t)
				.where(and(eq(t.user_id, ctx.user.id), win_col(ctx, t.modified_at), after ? gt(t.id, after) : undefined))
				.orderBy(t.id).limit(limit);
			ctx.rows.playlists.push(...rows);
			return { n: rows.length, last: last_of(rows, r => r.id) };
		}
	},
	{
		name: 'playlist_tracks', cost: 1,
		async run(ctx, after, limit) {
			const t = playlist_tracks_table;
			const [a, b] = after ? after.split('|') : [];
			const rows = await ctx.tx.select({ row: t }).from(t).innerJoin(playlists_table, eq(playlists_table.id, t.playlist_id))
				.where(and(eq(playlists_table.user_id, ctx.user.id), win_col(ctx, t.modified_at), after ? sql`(${t.playlist_id}, ${t.track_id}) > (${a}::uuid, ${b}::uuid)` : undefined))
				.orderBy(t.playlist_id, t.track_id).limit(limit);
			ctx.rows.playlist_tracks.push(...rows.map(r => r.row));
			return { n: rows.length, last: last_of(rows, r => `${r.row.playlist_id}|${r.row.track_id}`) };
		}
	},
	{
		name: 'playlist_inherited_searches', cost: 1,
		async run(ctx, after, limit) {
			const t = playlist_inherited_searches_table;
			const rows = await ctx.tx.select({ row: t }).from(t).innerJoin(playlists_table, eq(playlists_table.id, t.playlist_id))
				.where(and(eq(playlists_table.user_id, ctx.user.id), win_col(ctx, t.modified_at), after ? gt(t.id, Number(after)) : undefined))
				.orderBy(t.id).limit(limit);
			ctx.rows.playlist_inherited_searches.push(...rows.map(r => r.row));
			return { n: rows.length, last: last_of(rows, r => String(r.row.id)) };
		}
	},
	{
		name: 'playlist_inherited_playlists', cost: 1,
		async run(ctx, after, limit) {
			const t = playlist_inherited_playlists_table;
			const rows = await ctx.tx.select({ row: t }).from(t).innerJoin(playlists_table, eq(playlists_table.id, t.playlist_id))
				.where(and(eq(playlists_table.user_id, ctx.user.id), win_col(ctx, t.modified_at), after ? gt(t.id, Number(after)) : undefined))
				.orderBy(t.id).limit(limit);
			ctx.rows.playlist_inherited_playlists.push(...rows.map(r => r.row));
			return { n: rows.length, last: last_of(rows, r => String(r.row.id)) };
		}
	},
	{
		name: 'linked_playlists', cost: 1,
		async run(ctx, after, limit) {
			const t = linked_playlists_table;
			const rows = await ctx.tx.select().from(t)
				.where(and(eq(t.user_id, ctx.user.id), win_col(ctx, t.modified_at), after ? gt(t.service_uri, after) : undefined))
				.orderBy(t.service_uri).limit(limit);
			ctx.rows.linked_playlists.push(...rows);
			return { n: rows.length, last: last_of(rows, r => r.service_uri) };
		}
	},
	{
		name: 'track_plays', cost: 1,
		async run(ctx, after, limit) {
			const t = track_plays_table;
			const rows = await ctx.tx.select().from(t)
				.where(and(eq(t.user_id, ctx.user.id), win_col(ctx, t.created_at), after ? gt(t.id, Number(after)) : undefined))
				.orderBy(t.id).limit(limit);
			ctx.rows.track_plays.push(...rows);
			return { n: rows.length, last: last_of(rows, r => String(r.id)) };
		}
	},
	{
		name: 'recent_searches', cost: 1,
		async run(ctx, after, limit) {
			const t = user_recent_searches;
			const rows = await ctx.tx.select().from(t)
				.where(and(eq(t.user_id, ctx.user.id), win_col(ctx, t.created_at), after ? gt(t.id, Number(after)) : undefined))
				.orderBy(t.id).limit(limit);
			ctx.rows.recent_searches.push(...rows);
			return { n: rows.length, last: last_of(rows, r => String(r.id)) };
		}
	},
	{
		name: 'tracks', cost: BUNDLE_COST,
		async run(ctx, after, limit) {
			const ids = await changed_ids(ctx, ctx.scope.tracks, track_changed(ctx), after, limit);
			await load_track_bundles(ctx.tx, ids, ctx.rows);
			ctx.page_tracks.push(...ids);
			ctx.page_entities.push(...ids);
			return { n: ids.length, last: last_of(ids, id => id) };
		}
	},
	{
		name: 'albums', cost: BUNDLE_COST,
		async run(ctx, after, limit) {
			const ids = await changed_ids(ctx, ctx.scope.albums, album_changed(ctx), after, limit);
			await load_album_bundles(ctx.tx, ids, ctx.rows);
			ctx.page_entities.push(...ids);
			return { n: ids.length, last: last_of(ids, id => id) };
		}
	},
	{
		name: 'artists', cost: BUNDLE_COST,
		async run(ctx, after, limit) {
			const ids = await changed_ids(ctx, ctx.scope.artists, artist_changed(ctx), after, limit);
			await load_artist_bundles(ctx.tx, ids, ctx.rows);
			ctx.page_entities.push(...ids);
			return { n: ids.length, last: last_of(ids, id => id) };
		}
	}
];

/**
 * Walks phases from `position` until the budget is spent. Returns the position to resume from, or null when
 * the sweep is complete. Pure over the phase runner, so the paging logic is testable without a database.
 */
export async function walk_phases(
	phases: readonly { cost: number; run(after: string | null, limit: number): Promise<{ n: number; last: string | null }> }[],
	position: { phase: number; key: string | null },
	budget: number
): Promise<{ phase: number; key: string | null } | null> {
	let { phase, key } = position;
	while (phase < phases.length) {
		const p = phases[phase];
		if (p.cost === 0) {
			if (key == null) await p.run(null, 0);
			phase++;
			key = null;
			continue;
		}
		const limit = Math.floor(budget / p.cost);
		if (limit < 1) break;
		const { n, last } = await p.run(key, limit);
		budget -= n * p.cost;
		if (n < limit) {
			phase++;
			key = null;
		} else {
			key = last;
		}
	}
	return phase < phases.length ? { phase, key } : null;
}

/** Starts lyrics / iTunes / analyzer work for entities never looked up; never awaited. */
function queue_background(track_ids: readonly string[], entity_ids: readonly string[]) {
	const run = (name: string, p: Promise<void>) => { p.catch((err: unknown) => log.warn(`${name} queueing failed`, err)); };
	if (track_ids.length > 0) {
		run('lyrics', queue_never_looked_up(track_ids));
		run('analyzer', analyzer.enqueue_if_needed(track_ids));
	}
	if (entity_ids.length > 0) run('itunes', itunes.enqueue_if_needed(entity_ids));
}

export async function pull(user: AuthUser, cursor: Cursor | null): Promise<SyncPullResponse> {
	const inherited = await inherited_track_ids(user.id);
	const page = await db.transaction(async (tx) => {
		const resuming = cursor && in_progress(cursor) ? cursor : null;
		const since = cursor?.since ?? null;
		const upper = resuming ? resuming.upper : await watermark(tx);
		const ctx: PullContext = { tx, user, since, upper, scope: await compute_scope(tx, user.id, inherited), rows: empty_rows(), page_tracks: [], page_entities: [] };
		const position = await walk_phases(
			PHASES.map(p => ({ cost: p.cost, run: (after: string | null, limit: number) => p.run(ctx, after, limit) })),
			resuming ? { phase: resuming.phase, key: resuming.key ?? null } : { phase: 0, key: null },
			PAGE_BUDGET
		);
		return { ctx, position, since, upper };
	}, { isolationLevel: 'repeatable read', accessMode: 'read only' });

	const { ctx, position } = page;
	const lyrics = await get_best_lyrics(ctx.page_tracks);
	for (const [track_id, best] of lyrics) ctx.rows.lyrics.push({ track_id, lyrics: best });
	queue_background(ctx.page_tracks, ctx.page_entities);

	const actions: ActionType[] = [];
	try {
		if (ctx.page_tracks.length > 0) actions.push(...await lyrics_actions_for_tracks(user, ctx.page_tracks, LYRICS_ACTIONS_PER_PAGE));
		if (!position) actions.push(...await pending_upload_actions(user, UPLOAD_ACTIONS_PER_PULL));
		if (!position) actions.push(...await research_actions(user, RESEARCH_ACTIONS_PER_PULL));
	} catch (err) {
		log.warn('could not build actions', err);
	}
	const response: SyncPullResponse = {
		...ctx.rows,
		next_cursor: encode_cursor(next_cursor(page.since, page.upper, position)),
		has_more: position != null
	};
	if (actions.length > 0) response.actions = actions;
	return response;
}
