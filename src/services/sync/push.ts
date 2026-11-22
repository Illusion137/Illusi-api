/**
 * `POST /sync/push`. The whole push is one transaction, replayed by `push_id`.
 * Shared entities go through the contribution engine; user-owned rows follow row-level LWW by clamped
 * `edited_at`; plays and searches are append-only, deduped by `client_id`.
 */
import { and, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db';
import type { Executor, Tx } from '../../db';
import {
	linked_playlists_table, playlist_inherited_playlists_table, playlist_inherited_searches_table, playlist_tracks_table, playlists_table,
	sync_pushes_table, track_downloads_table, track_plays_table, tracks_artists_table, user_recent_searches, user_tracks_table, users_table
} from '../../db/schema';
import type { AuthUser } from '../../core/auth/tokens';
import { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { logger } from '../../core/log';
import { ProvenanceLog } from '../../core/provenance';
import { truncate_to_columns } from '../../core/truncate';
import { apply_graph, flush_engine_events, graph_counts, validate_graph } from '../entities';
import type { EngineResult } from '../entities';
import { resolve_existing_ref } from '../entities/match';
import { OverrideResolver } from './overrides';
import { assert_inheritance_allowed } from '../playlists';
import { clamp_edited_at, clock_skew_ms, correct_skew, lww_update, lww_wins } from './lww';
import { load_album_bundles, load_artist_bundles, load_override_bundles, load_track_bundles, load_user } from './rows';
import { empty_rows, profile_schema, PUSH_TABLES, push_row_schemas } from './types';
import type { PushBody, PushRejection, PushRow, PushTable, SyncPushResponse, SyncRows } from './types';
import { pg_error_code, PG_ERRORS } from '../../core/pg_errors';

const log = logger('sync');

/** Kept small enough that one push finishes well inside the proxy timeout; clients send 250 entities / 2,000 rows. */
export const PUSH_MAX_ENTITIES = 2_000;
export const PUSH_MAX_RELATIONS = 10_000;
export const PUSH_MAX_USER_ROWS = 20_000;

const LIBRARY_TABLES: readonly PushTable[] = ['user_tracks', 'playlists', 'playlist_tracks', 'playlist_inherited_searches', 'playlist_inherited_playlists', 'linked_playlists'];

type ValidRows = { [T in PushTable]: { row: PushRow<T>; index: number }[] };

/** Validates every user row on its own; malformed rows are rejected and the rest still applies. */
export function validate_push_rows(changes: PushBody['changes']): { rows: ValidRows; profile: z.infer<typeof profile_schema> | null; rejected: PushRejection[] } {
	const rejected: PushRejection[] = [];
	const rows = Object.fromEntries(PUSH_TABLES.map(t => [t, []])) as unknown as ValidRows;
	for (const table of PUSH_TABLES) {
		(changes[table] ?? []).forEach((item, index) => {
			const parsed = push_row_schemas[table].safeParse(item);
			if (parsed.success) (rows[table] as { row: unknown; index: number }[]).push({ row: parsed.data, index });
			else rejected.push({ table, index, reason: 'malformed', issues: parsed.error.issues });
		});
	}
	let profile = null;
	if (changes.profile !== undefined) {
		const parsed = profile_schema.safeParse(changes.profile);
		if (parsed.success) profile = parsed.data;
		else rejected.push({ table: 'profile', index: 0, reason: 'malformed', issues: parsed.error.issues });
	}
	return { rows, profile, rejected };
}

/** Values that are explicitly present (omitted fields keep the stored value). */
const defined = <T extends Record<string, unknown>>(values: T) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;

class PushApplier {
	readonly rejected: PushRejection[] = [];
	readonly applied: SyncPushResponse['applied'] = {};
	readonly inherited_id_map: SyncPushResponse['inherited_id_map'] = { playlist_inherited_searches: {}, playlist_inherited_playlists: {} };
	readonly redirects = new Map<string, string>();
	readonly touched = {
		user_tracks: new Set<string>(), playlists: new Set<string>(), playlist_tracks: new Set<string>(),
		playlist_inherited_searches: new Set<number>(), playlist_inherited_playlists: new Set<number>(),
		linked_playlists: new Set<string>(), track_plays: new Set<string>(), recent_searches: new Set<string>(), profile: false
	};

	private readonly track_cache = new Map<string, string | null>();
	private readonly owned = new Map<string, boolean>();

	constructor(
		private tx: Tx, private user_id: string, private session_family_id: string, private now: Date, private refs: Record<string, string>,
		readonly overrides: OverrideResolver, private skew_ms = 0, private client_now?: Date
	) {}

	private count(table: PushTable | 'profile') { this.applied[table] = (this.applied[table] ?? 0) + 1; }
	private reject(table: PushTable | 'profile', index: number, reason: string) { this.rejected.push({ table, index, reason }); }
	/** A device time on the server's clock (skew corrected), never past the server's now. */
	private edited(at: Date) { return clamp_edited_at(correct_skew(at, this.client_now, this.skew_ms), this.now); }

	/** A temp ref of this push's entities, or an existing track id (following redirects, which are returned). */
	async track(ref: string): Promise<string | null> {
		const mapped = this.refs[ref] as string | undefined;
		if (mapped) return mapped;
		if (!this.track_cache.has(ref)) {
			const id = await resolve_existing_ref(this.tx, 'track', ref);
			if (id && id !== ref.toLowerCase()) this.redirects.set(ref.toLowerCase(), id);
			this.track_cache.set(ref, id);
		}
		return this.track_cache.get(ref) ?? null;
	}

	private async owns_playlist(id: string): Promise<boolean> {
		if (!this.owned.has(id)) {
			const [row] = await this.tx.select({ user_id: playlists_table.user_id }).from(playlists_table).where(eq(playlists_table.id, id));
			this.owned.set(id, row?.user_id === this.user_id);
		}
		return this.owned.get(id)!;
	}

	async profile(p: z.infer<typeof profile_schema>) {
		const edited_at = this.edited(p.edited_at);
		const [cur] = await this.tx.select({ edited_at: users_table.edited_at }).from(users_table).where(eq(users_table.id, this.user_id)).for('update');
		this.touched.profile = true;
		if (!cur || !lww_wins(cur.edited_at, edited_at)) return;
		await this.tx.update(users_table).set(lww_update(['username'], { username: p.username }, edited_at)).where(eq(users_table.id, this.user_id));
		this.count('profile');
	}

	async user_track({ row: r, index }: { row: PushRow<'user_tracks'>; index: number }) {
		const track_id = await this.track(r.track_id);
		if (!track_id) return this.reject('user_tracks', index, 'unknown track');
		await this.device_download(track_id, r);
		const t = user_tracks_table;
		const edited_at = this.edited(r.edited_at);
		const [cur] = await this.tx.select({ edited_at: t.edited_at, deleted: t.deleted }).from(t).where(and(eq(t.user_id, this.user_id), eq(t.track_id, track_id))).for('update');
		if (cur && !lww_wins(cur.edited_at, edited_at)) {
			this.touched.user_tracks.add(track_id);
			return;
		}
		const credits = await this.credits(r);
		if (credits === null) return this.reject('user_tracks', index, 'unresolvable artist or album');
		const values = truncate_to_columns(t, defined({ title: r.title, ...credits, downloaded_at: r.downloaded_at, start_at: r.start_at, end_at: r.end_at, deleted: r.deleted }), 'sync user_tracks');
		this.touched.user_tracks.add(track_id);
		const added = this.added(r.added_at, cur, r.deleted);
		if (!cur) {
			await this.tx.insert(t).values({ ...values, user_id: this.user_id, track_id, edited_at, ...added });
		} else if (lww_wins(cur.edited_at, edited_at)) {
			await this.tx.update(t).set({ ...lww_update(['title', 'artist_ids', 'album_id', 'downloaded_at', 'start_at', 'end_at', 'deleted'], values, edited_at), ...added }).where(and(eq(t.user_id, this.user_id), eq(t.track_id, track_id)));
		} else {
			return;
		}
		this.count('user_tracks');
	}

	/**
	 * `created_at` from the device's `added_at` (the "date added" that orders libraries and playlists), set when the
	 * row is created or re-added after a delete. Without it, the server's time of the push is used.
	 */
	private added(added_at: Date | undefined, cur: { deleted: boolean } | undefined, deleted: boolean | undefined): { created_at?: Date } {
		const creates = !cur || (cur.deleted && deleted === false);
		return added_at && creates ? { created_at: this.edited(added_at) } : {};
	}

	/**
	 * Whether this device holds the file is a fact about the device, not a user edit, so it skips last-write-wins.
	 * A client without `downloaded` only reports downloads it has.
	 */
	private async device_download(track_id: string, r: PushRow<'user_tracks'>) {
		const has = r.downloaded ?? (r.downloaded_at != null ? true : undefined);
		const d = track_downloads_table;
		if (has === false) {
			await this.tx.delete(d).where(and(eq(d.session_family_id, this.session_family_id), eq(d.track_id, track_id)));
		} else if (has === true) {
			const downloaded_at = r.downloaded_at ?? this.now;
			await this.tx.insert(d).values({ session_family_id: this.session_family_id, user_id: this.user_id, track_id, downloaded_at })
				.onConflictDoUpdate({ target: [d.session_family_id, d.track_id], set: { downloaded_at, modified_at: this.now } });
		}
	}

	/** The row's own credits as ids; undefined fields keep the stored ones, null if a name can't be resolved */
	private async credits(r: PushRow<'user_tracks'>): Promise<{ artist_ids?: string[] | null; album_id?: string | null } | null> {
		const out: { artist_ids?: string[] | null; album_id?: string | null } = {};
		if (r.artists !== undefined) {
			if (r.artists === null) {
				out.artist_ids = null;
			} else {
				const ids: string[] = [];
				for (const artist of r.artists) {
					const id = await this.overrides.artist(artist);
					if (id === null) return null;
					if (!ids.includes(id)) ids.push(id);
				}
				out.artist_ids = ids;
			}
		}
		if (r.album !== undefined) {
			if (r.album === null) {
				out.album_id = null;
			} else {
				const artist_ids = out.artist_ids ?? (await this.stored_artist_ids(r.track_id));
				const id = await this.overrides.album(r.album, artist_ids);
				if (id === null) return null;
				out.album_id = id;
			}
		}
		return out;
	}

	/** The user's credited artists for the track, else the catalog's */
	private async stored_artist_ids(ref: string): Promise<string[]> {
		const track_id = await this.track(ref);
		if (!track_id) return [];
		const [own] = await this.tx.select({ artist_ids: user_tracks_table.artist_ids }).from(user_tracks_table).where(and(eq(user_tracks_table.user_id, this.user_id), eq(user_tracks_table.track_id, track_id)));
		if (own?.artist_ids) return own.artist_ids;
		const rows = await this.tx.select({ id: tracks_artists_table.artist_id }).from(tracks_artists_table).where(eq(tracks_artists_table.track_id, track_id));
		return rows.map(row => row.id);
	}

	async playlist({ row: r, index }: { row: PushRow<'playlists'>; index: number }) {
		const t = playlists_table;
		const edited_at = this.edited(r.edited_at);
		const values = truncate_to_columns(t, defined({ title: r.title, description: r.description, pinned: r.pinned, archived: r.archived, public: r.public, sort_mode: r.sort_mode, deleted: r.deleted }), 'sync playlists');
		const [cur] = await this.tx.select({ user_id: t.user_id, edited_at: t.edited_at }).from(t).where(eq(t.id, r.id)).for('update');
		if (cur && cur.user_id !== this.user_id) return this.reject('playlists', index, 'playlist belongs to another user');
		this.touched.playlists.add(r.id);
		if (!cur) {
			if (!values.title) return this.reject('playlists', index, 'title is required for a new playlist');
			// Another user's private playlist is invisible to the select above, so the id can still collide.
			const inserted = await this.tx.insert(t).values({ ...values, title: values.title, id: r.id, user_id: this.user_id, edited_at }).onConflictDoNothing().returning({ id: t.id });
			if (inserted.length === 0) return this.reject('playlists', index, 'playlist belongs to another user');
			this.owned.set(r.id, true);
		} else if (lww_wins(cur.edited_at, edited_at)) {
			await this.tx.update(t).set(lww_update(['title', 'description', 'pinned', 'archived', 'public', 'sort_mode', 'deleted'], values, edited_at)).where(eq(t.id, r.id));
		} else {
			return;
		}
		this.count('playlists');
	}

	async playlist_track({ row: r, index }: { row: PushRow<'playlist_tracks'>; index: number }) {
		if (!(await this.owns_playlist(r.playlist_id))) return this.reject('playlist_tracks', index, 'unknown playlist');
		const track_id = await this.track(r.track_id);
		if (!track_id) return this.reject('playlist_tracks', index, 'unknown track');
		const t = playlist_tracks_table;
		const edited_at = this.edited(r.edited_at);
		const where = and(eq(t.playlist_id, r.playlist_id), eq(t.track_id, track_id));
		const [cur] = await this.tx.select({ edited_at: t.edited_at, deleted: t.deleted }).from(t).where(where).for('update');
		this.touched.playlist_tracks.add(`${r.playlist_id}|${track_id}`);
		const added = this.added(r.added_at, cur, r.deleted);
		if (!cur) await this.tx.insert(t).values({ playlist_id: r.playlist_id, track_id, deleted: r.deleted ?? false, edited_at, ...added });
		else if (lww_wins(cur.edited_at, edited_at)) await this.tx.update(t).set({ ...lww_update(['deleted'], defined({ deleted: r.deleted }), edited_at), ...added }).where(where);
		else return;
		this.count('playlist_tracks');
	}

	async inherited_search({ row: r, index }: { row: PushRow<'playlist_inherited_searches'>; index: number }) {
		const table = 'playlist_inherited_searches';
		if (!(await this.owns_playlist(r.playlist_id))) return this.reject(table, index, 'unknown playlist');
		const t = playlist_inherited_searches_table;
		const edited_at = this.edited(r.edited_at);
		const values = truncate_to_columns(t, defined({ playlist_id: r.playlist_id, query: r.query, mode: r.mode, deleted: r.deleted }), 'sync inherited searches');
		// Without a server id, an active row with the same query is the same row (a retried push with a new push_id).
		const [cur] = r.id != null
			? await this.tx.select().from(t).where(eq(t.id, r.id)).for('update')
			: await this.tx.select().from(t).where(and(eq(t.playlist_id, r.playlist_id), r.query == null ? isNull(t.query) : eq(t.query, values.query!), not(t.deleted))).limit(1).for('update');
		if (r.id != null && (!cur || !(await this.owns_playlist(cur.playlist_id)))) return this.reject(table, index, 'unknown row');
		if (!cur) {
			const [row] = await this.tx.insert(t).values({ ...values, playlist_id: r.playlist_id, edited_at }).returning({ id: t.id });
			if (r.temp_id) this.inherited_id_map[table][r.temp_id] = row.id;
			this.touched[table].add(row.id);
		} else {
			this.touched[table].add(cur.id);
			if (r.temp_id) this.inherited_id_map[table][r.temp_id] = cur.id;
			if (!lww_wins(cur.edited_at, edited_at)) return;
			await this.tx.update(t).set(lww_update(['playlist_id', 'query', 'mode', 'deleted'], values, edited_at)).where(eq(t.id, cur.id));
		}
		this.count(table);
	}

	/** Every write that makes an inheritance edge active goes through `assert_inheritance_allowed`. */
	async inherited_playlist({ row: r, index }: { row: PushRow<'playlist_inherited_playlists'>; index: number }) {
		const table = 'playlist_inherited_playlists';
		if (!(await this.owns_playlist(r.playlist_id))) return this.reject(table, index, 'unknown playlist');
		const t = playlist_inherited_playlists_table;
		const edited_at = this.edited(r.edited_at);
		const [cur] = r.id != null
			? await this.tx.select().from(t).where(eq(t.id, r.id)).for('update')
			: await this.tx.select().from(t).where(and(eq(t.playlist_id, r.playlist_id), eq(t.ref_id, r.ref_id), not(t.deleted))).limit(1).for('update');
		if (r.id != null && (!cur || !(await this.owns_playlist(cur.playlist_id)))) return this.reject(table, index, 'unknown row');
		if (cur) {
			this.touched[table].add(cur.id);
			if (r.temp_id) this.inherited_id_map[table][r.temp_id] = cur.id;
			if (!lww_wins(cur.edited_at, edited_at)) return;
		}
		const deleted = r.deleted ?? cur?.deleted ?? false;
		const activates = !deleted && (!cur || cur.deleted || cur.ref_id !== r.ref_id || cur.playlist_id !== r.playlist_id);
		try {
			await this.tx.transaction(async (sp) => {
				if (activates) await assert_inheritance_allowed(sp, this.user_id, r.playlist_id, r.ref_id);
				if (!cur) {
					const [row] = await sp.insert(t).values({ playlist_id: r.playlist_id, ref_id: r.ref_id, mode: r.mode, deleted, edited_at }).returning({ id: t.id });
					if (r.temp_id) this.inherited_id_map[table][r.temp_id] = row.id;
					this.touched[table].add(row.id);
				} else {
					await sp.update(t).set(lww_update(['playlist_id', 'ref_id', 'mode', 'deleted'], defined({ playlist_id: r.playlist_id, ref_id: r.ref_id, mode: r.mode, deleted: r.deleted }), edited_at)).where(eq(t.id, cur.id));
				}
			});
		} catch (err) {
			if (err instanceof HttpError) return this.reject(table, index, err.message);
			log.warn('inheritance write failed', err);
			return this.reject(table, index, 'inheritance not allowed');
		}
		this.count(table);
	}

	async linked_playlist({ row: r }: { row: PushRow<'linked_playlists'>; index: number }) {
		const t = linked_playlists_table;
		const edited_at = this.edited(r.edited_at);
		const where = and(eq(t.user_id, this.user_id), eq(t.service_uri, r.service_uri));
		const [cur] = await this.tx.select({ edited_at: t.edited_at }).from(t).where(where).for('update');
		this.touched.linked_playlists.add(r.service_uri);
		if (!cur) await this.tx.insert(t).values({ user_id: this.user_id, service_uri: r.service_uri, deleted: r.deleted ?? false, edited_at });
		else if (lww_wins(cur.edited_at, edited_at)) await this.tx.update(t).set(lww_update(['deleted'], defined({ deleted: r.deleted }), edited_at)).where(where);
		else return;
		this.count('linked_playlists');
	}

	async plays(rows: ValidRows['track_plays']) {
		const values = [];
		for (const { row, index } of rows) {
			const track_id = await this.track(row.track_id);
			if (!track_id) {
				this.reject('track_plays', index, 'unknown track');
				continue;
			}
			values.push({ user_id: this.user_id, track_id, client_id: row.client_id, created_at: this.edited(row.created_at) });
			this.touched.track_plays.add(row.client_id);
		}
		for (let i = 0; i < values.length; i += 1_000) {
			const inserted = await this.tx.insert(track_plays_table).values(values.slice(i, i + 1_000)).onConflictDoNothing({ target: [track_plays_table.user_id, track_plays_table.client_id] }).returning({ id: track_plays_table.id });
			this.applied.track_plays = (this.applied.track_plays ?? 0) + inserted.length;
		}
	}

	async searches(rows: ValidRows['recent_searches']) {
		const values = rows.map(({ row }) => truncate_to_columns(user_recent_searches, { user_id: this.user_id, text: row.text, client_id: row.client_id, created_at: this.edited(row.created_at) }, 'sync searches'));
		for (const { row } of rows) this.touched.recent_searches.add(row.client_id);
		for (let i = 0; i < values.length; i += 1_000) {
			const inserted = await this.tx.insert(user_recent_searches).values(values.slice(i, i + 1_000)).onConflictDoNothing({ target: [user_recent_searches.user_id, user_recent_searches.client_id] }).returning({ id: user_recent_searches.id });
			this.applied.recent_searches = (this.applied.recent_searches ?? 0) + inserted.length;
		}
	}

	/** Re-reads every touched row so the client can overwrite its copy with the server's values. */
	async authoritative(engine: EngineResult): Promise<SyncRows> {
		const rows = empty_rows();
		const tx = this.tx;
		const u = this.user_id;
		const touched = this.touched;
		if (touched.profile) rows.user = await load_user(tx, u);
		if (touched.user_tracks.size > 0) rows.user_tracks = await tx.select().from(user_tracks_table).where(and(eq(user_tracks_table.user_id, u), inArray(user_tracks_table.track_id, [...touched.user_tracks])));
		await load_override_bundles(tx, rows.user_tracks, rows);
		if (touched.playlists.size > 0) rows.playlists = await tx.select().from(playlists_table).where(and(eq(playlists_table.user_id, u), inArray(playlists_table.id, [...touched.playlists])));
		if (touched.playlist_tracks.size > 0) {
			const pairs = [...touched.playlist_tracks].map(k => k.split('|'));
			const found = await tx.select().from(playlist_tracks_table).where(and(
				inArray(playlist_tracks_table.playlist_id, [...new Set(pairs.map(p => p[0]))]),
				inArray(playlist_tracks_table.track_id, [...new Set(pairs.map(p => p[1]))])
			));
			rows.playlist_tracks = found.filter(r => touched.playlist_tracks.has(`${r.playlist_id}|${r.track_id}`));
		}
		if (touched.playlist_inherited_searches.size > 0) rows.playlist_inherited_searches = await tx.select().from(playlist_inherited_searches_table).where(inArray(playlist_inherited_searches_table.id, [...touched.playlist_inherited_searches]));
		if (touched.playlist_inherited_playlists.size > 0) rows.playlist_inherited_playlists = await tx.select().from(playlist_inherited_playlists_table).where(inArray(playlist_inherited_playlists_table.id, [...touched.playlist_inherited_playlists]));
		if (touched.linked_playlists.size > 0) rows.linked_playlists = await tx.select().from(linked_playlists_table).where(and(eq(linked_playlists_table.user_id, u), inArray(linked_playlists_table.service_uri, [...touched.linked_playlists])));
		if (touched.track_plays.size > 0) rows.track_plays = await tx.select().from(track_plays_table).where(and(eq(track_plays_table.user_id, u), inArray(track_plays_table.client_id, [...touched.track_plays])));
		if (touched.recent_searches.size > 0) rows.recent_searches = await tx.select().from(user_recent_searches).where(and(eq(user_recent_searches.user_id, u), inArray(user_recent_searches.client_id, [...touched.recent_searches])));

		const by_type = { track: new Set<string>(), album: new Set<string>(), artist: new Set<string>() };
		for (const e of [...engine.created, ...engine.matched]) by_type[e.type].add(e.illusi_id);
		await load_track_bundles(tx, [...by_type.track], rows);
		await load_album_bundles(tx, [...by_type.album], rows);
		await load_artist_bundles(tx, [...by_type.artist], rows);
		rows.redirects = [...this.redirects].map(([old_id, new_id]) => ({ old_id, new_id }));
		for (const e of engine.matched) {
			if (e.by === 'ref' && e.ref.toLowerCase() !== e.illusi_id) rows.redirects.push({ old_id: e.ref.toLowerCase(), new_id: e.illusi_id });
		}
		return rows;
	}

	get library_changed() {
		return LIBRARY_TABLES.some(t => (this.applied[t] ?? 0) > 0);
	}
}

async function replay(ex: Executor, push_id: string): Promise<SyncPushResponse | null> {
	// Row-level security hides other users' pushes: a push_id taken by someone else surfaces as a unique violation.
	const [row] = await ex.select({ response: sync_pushes_table.response }).from(sync_pushes_table).where(eq(sync_pushes_table.push_id, push_id));
	return row ? row.response as SyncPushResponse : null;
}

/** Sentinel: the push was applied by a concurrent request (a retry after a proxy timeout) while this one waited. */
class Replayed extends Error {
	constructor(readonly response: SyncPushResponse) {
		super('replayed');
	}
}

const is_unique_violation = (err: unknown) => pg_error_code(err) === PG_ERRORS.unique_violation;

export async function push(user: AuthUser, body: PushBody): Promise<SyncPushResponse> {
	const raw_graph = body.changes.entities ?? {};
	const counts = graph_counts(raw_graph);
	const user_row_count = PUSH_TABLES.reduce((n, t) => n + (body.changes[t]?.length ?? 0), 0);
	if (counts.entities > PUSH_MAX_ENTITIES || counts.relations > PUSH_MAX_RELATIONS || user_row_count > PUSH_MAX_USER_ROWS) {
		throw new HttpError(413, 'push too large, send it in chunks', { max_entities: PUSH_MAX_ENTITIES, max_relations: PUSH_MAX_RELATIONS, max_user_rows: PUSH_MAX_USER_ROWS });
	}
	const previous = await replay(db, body.push_id);
	if (previous) return previous;

	const { graph, rejected: graph_rejected } = validate_graph(raw_graph);
	const { rows, profile, rejected: row_rejected } = validate_push_rows(body.changes);

	let outcome;
	try {
		outcome = await db.transaction(async (tx) => {
			// A client that timed out resends the same push_id while the first request is still applying it: the
			// retry waits here, then answers with the stored result instead of doing the work twice.
			await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sync_push:${body.push_id}`}, 0))`);
			const replayed = await replay(tx, body.push_id);
			if (replayed) throw new Replayed(replayed);
			const [{ now }] = await tx.execute<{ now: string }>(sql`select now()::text as now`, 'objects');
			const server_now = new Date(now);
			const provenance = new ProvenanceLog('sync_push', user.id);
			const engine = await apply_graph(tx, graph, { user_id: user.id, source: 'sync_push', provenance });
			const applier = new PushApplier(tx, user.id, user.sid, server_now, engine.refs, new OverrideResolver(tx, user.id, provenance), clock_skew_ms(body.client_now, server_now), body.client_now);

			if (profile) await applier.profile(profile);
			for (const r of rows.user_tracks) await applier.user_track(r);
			for (const r of rows.playlists) await applier.playlist(r);
			for (const r of rows.playlist_tracks) await applier.playlist_track(r);
			for (const r of rows.playlist_inherited_searches) await applier.inherited_search(r);
			for (const r of rows.playlist_inherited_playlists) await applier.inherited_playlist(r);
			for (const r of rows.linked_playlists) await applier.linked_playlist(r);
			await applier.plays(rows.track_plays);
			await applier.searches(rows.recent_searches);

			if (provenance.entities.length > 0) await provenance.write(tx);
			const rejected = [...row_rejected, ...applier.rejected];
			const entity_rejected = [...graph_rejected, ...engine.rejected];
			const response: SyncPushResponse = {
				push_id: body.push_id,
				cursor: body.base_cursor ?? null,
				id_map: engine.refs,
				inherited_id_map: applier.inherited_id_map,
				rows: await applier.authoritative(engine),
				entities: { created: engine.created, matched: engine.matched, conflicts: engine.conflicts, rejected: entity_rejected },
				rejected,
				applied: applier.applied,
				progress: {
					entities: counts.entities,
					user_rows: user_row_count + (body.changes.profile !== undefined ? 1 : 0),
					created: engine.created.length,
					matched: engine.matched.length,
					rejected: rejected.length + entity_rejected.filter(r => r.field == null).length
				}
			};
			// Round-trip through JSON so the stored replay and the first response are identical.
			const json = JSON.parse(JSON.stringify(response)) as SyncPushResponse;
			await tx.insert(sync_pushes_table).values({ push_id: body.push_id, user_id: user.id, response: json });
			return { response: json, engine, overrides: applier.overrides.results, library_changed: applier.library_changed };
		});
	} catch (err) {
		if (err instanceof Replayed) return err.response;
		if (is_unique_violation(err)) {
			const stored = await replay(db, body.push_id);
			if (stored) return stored;
			throw new HttpError(409, 'push_id already used', { code: 'PUSH_ID_TAKEN' });
		}
		throw err;
	}

	flush_engine_events(outcome.engine);
	for (const result of outcome.overrides) flush_engine_events(result);
	if (outcome.library_changed) {
		const events = new PendingEvents();
		events.push('user_library_changed', { user_id: user.id });
		events.flush();
	}
	return outcome.response;
}
