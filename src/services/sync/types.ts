/**
 * Wire shapes of `POST /sync/pull` and `POST /sync/push`. Timestamps are ISO strings on the wire
 * (rows are serialized with `JSON.stringify`). Every table section is an array of full rows, so a client
 * can upsert each row by its primary key; soft deletes come through as `deleted: true`.
 */
import { z } from 'zod';
import type { ActionType } from '../../core/actions';
import type {
	album_tracks_table, albums_table, artist_albums_table, artists_table, linked_playlists_table, playlist_inherited_playlists_table,
	playlist_inherited_searches_table, playlist_tracks_table, playlists_table, service_ids_table, thumbnails_table, track_plays_table,
	track_sample_data_table, tracks_artists_table, tracks_table, user_recent_searches, user_tracks_table, users_table
} from '../../db/schema';
import { inheritance_mode, sort_type } from '../../db/schema';
import type { BestLyrics } from '../lyrics';
import type { ConflictReport, EntityOutcome, MatchedOutcome, Rejection } from '../entities';
import { raw_graph_schema } from '../entities';

/** `users_table` without `password_hash` (never synced). */
export type SyncUser = Omit<typeof users_table.$inferSelect, 'password_hash' | 'email_verified_at'>;
export interface Redirect { old_id: string; new_id: string }
/** Selected iTunes fields for a local track / album / artist, keyed by its `illusi_id`. */
export interface ItunesFields {
	id: string;
	entity_type: 'track' | 'album' | 'artist';
	explicitness: string | null;
	release_date: Date | null;
	primary_genre_name: string | null;
	/** Largest iTunes artwork URL; the same URLs are also in `thumbnails`. */
	artwork_url: string | null;
}
export interface TrackProducer { track_id: string; producer_id: number; name: string | null }

/** The analyzer's raw features, kept on the server and left out of sync */
export type ServerOnlySampleColumn = 'version' | 'tempo_confidence' | 'rms_energy' | 'spectral_rolloff' | 'zero_crossing_rate' | 'mfccs' | 'chroma' | 'mood_scores' | 'source_duration_ms';

/** Every syncable table, in the order a client should apply them after `redirects`. */
export interface SyncRows {
	/** Apply first: rewrite local ids `old_id` → `new_id` (possibly chained) before anything else. */
	redirects: Redirect[];
	user: SyncUser | null;
	// Shared data for every track the user touches.
	artists: Omit<typeof artists_table.$inferSelect, 'search_name'>[];
	albums: Omit<typeof albums_table.$inferSelect, 'search_name'>[];
	tracks: Omit<typeof tracks_table.$inferSelect, 'search_title'>[];
	tracks_artists: (typeof tracks_artists_table.$inferSelect)[];
	album_tracks: (typeof album_tracks_table.$inferSelect)[];
	artist_albums: (typeof artist_albums_table.$inferSelect)[];
	/** `tracks_producers_table` with the Genius artist name. */
	tracks_producers: TrackProducer[];
	service_ids: (typeof service_ids_table.$inferSelect)[];
	thumbnails: (typeof thumbnails_table.$inferSelect)[];
	sample_data: Omit<typeof track_sample_data_table.$inferSelect, ServerOnlySampleColumn>[];
	/** Best lyrics only, already parsed. */
	lyrics: { track_id: string; lyrics: BestLyrics }[];
	itunes: ItunesFields[];
	// Data the user owns.
	user_tracks: (typeof user_tracks_table.$inferSelect)[];
	playlists: (typeof playlists_table.$inferSelect)[];
	playlist_tracks: (typeof playlist_tracks_table.$inferSelect)[];
	playlist_inherited_searches: (typeof playlist_inherited_searches_table.$inferSelect)[];
	playlist_inherited_playlists: (typeof playlist_inherited_playlists_table.$inferSelect)[];
	linked_playlists: (typeof linked_playlists_table.$inferSelect)[];
	track_plays: (typeof track_plays_table.$inferSelect)[];
	recent_searches: (typeof user_recent_searches.$inferSelect)[];
}

export const empty_rows = (): SyncRows => ({
	redirects: [], user: null,
	artists: [], albums: [], tracks: [], tracks_artists: [], album_tracks: [], artist_albums: [], tracks_producers: [],
	service_ids: [], thumbnails: [], sample_data: [], lyrics: [], itunes: [],
	user_tracks: [], playlists: [], playlist_tracks: [], playlist_inherited_searches: [], playlist_inherited_playlists: [],
	linked_playlists: [], track_plays: [], recent_searches: []
});

/**
 * `POST /sync/pull` response. Pages: keep pulling with `next_cursor` while `has_more`; store the last
 * `next_cursor` for the next sync. Rows changed while paging are sent again on the next sync.
 */
export interface SyncPullResponse extends SyncRows {
	next_cursor: string;
	has_more: boolean;
	actions?: ActionType[];
}

export const pull_body_schema = z.object({ cursor: z.string().max(2048).nullish() });

const ref = z.string().trim().min(1).max(128);
const time = z.union([z.string().max(64), z.number()]).transform((v, ctx) => {
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) {
		ctx.addIssue({ code: 'custom', message: 'invalid timestamp' });
		return z.NEVER;
	}
	return d;
});
const nullable_time = z.union([time, z.null()]);

/** An artist or album a user credits a track with: an existing id, or a name to link or create */
const override_ref = z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(256) });

/** User-owned rows: each carries the client's `edited_at`. Omitted fields keep the stored value. */
export const push_row_schemas = {
	user_tracks: z.object({
		track_id: ref,
		title: z.string().max(4096).nullish(),
		/** null goes back to the catalog's credits */
		artists: z.array(override_ref).min(1).max(32).nullish(),
		album: override_ref.nullish(),
		downloaded_at: nullable_time.optional(),
		/** Whether the pushing device has the file now; older clients send only `downloaded_at` */
		downloaded: z.boolean().optional(),
		start_at: z.number().int().nullish(),
		end_at: z.number().int().nullish(),
		deleted: z.boolean().optional(),
		edited_at: time
	}),
	playlists: z.object({
		id: z.uuid(),
		title: z.string().trim().min(1).max(4096).optional(),
		description: z.string().max(10_000).nullish(),
		pinned: z.boolean().optional(),
		archived: z.boolean().optional(),
		public: z.boolean().optional(),
		sort_mode: z.enum(sort_type.enumValues).optional(),
		deleted: z.boolean().optional(),
		edited_at: time
	}),
	playlist_tracks: z.object({ playlist_id: z.uuid(), track_id: ref, deleted: z.boolean().optional(), edited_at: time }),
	playlist_inherited_searches: z.object({
		/** Server id of an existing row; omit with `temp_id` for a new one. */
		id: z.number().int().positive().optional(),
		temp_id: z.string().max(128).optional(),
		playlist_id: z.uuid(),
		query: z.string().max(4096).nullish(),
		mode: z.enum(inheritance_mode.enumValues).nullish(),
		deleted: z.boolean().optional(),
		edited_at: time
	}),
	playlist_inherited_playlists: z.object({
		id: z.number().int().positive().optional(),
		temp_id: z.string().max(128).optional(),
		playlist_id: z.uuid(),
		ref_id: z.uuid(),
		mode: z.enum(inheritance_mode.enumValues).nullish(),
		deleted: z.boolean().optional(),
		edited_at: time
	}),
	linked_playlists: z.object({ service_uri: z.string().trim().min(1).max(256), deleted: z.boolean().optional(), edited_at: time }),
	/** Append-only, deduped by the client-generated `client_id`. */
	track_plays: z.object({ client_id: z.uuid(), track_id: ref, created_at: time }),
	recent_searches: z.object({ client_id: z.uuid(), text: z.string().max(4096).nullable(), created_at: time })
} as const;
export type PushTable = keyof typeof push_row_schemas;
export const PUSH_TABLES = Object.keys(push_row_schemas) as PushTable[];
export type PushRow<T extends PushTable> = z.infer<typeof push_row_schemas[T]>;

export const profile_schema = z.object({ username: z.string().trim().min(1).max(64).optional(), edited_at: time });

/**
 * `POST /sync/push` body. `changes.entities` is a contribution graph:
 * new local artists/albums/tracks/relations, processed by the contribution engine; track refs in the
 * user rows may be its temp refs. Derived data (lyrics, sample data, vectors, iTunes, redirects) is not
 * accepted. For a first import, send chunks in dependency order, each with its own `push_id`.
 */
export const push_body_schema = z.object({
	push_id: z.uuid(),
	base_cursor: z.string().max(2048).nullish(),
	changes: z.object({
		entities: raw_graph_schema.optional(),
		profile: z.unknown().optional(),
		...Object.fromEntries(PUSH_TABLES.map(t => [t, z.array(z.unknown()).optional()])) as Record<PushTable, z.ZodOptional<z.ZodArray<z.ZodUnknown>>>
	})
});
export type PushBody = z.infer<typeof push_body_schema>;

export interface PushRejection { table: PushTable | 'profile'; index: number; reason: string; issues?: unknown }

/** `POST /sync/push` response; replayed verbatim for a retried `push_id`. */
export interface SyncPushResponse {
	push_id: string;
	/**
	 * Cursor for the next pull. This is the `base_cursor` (or null without one): rows other devices changed
	 * after it must not be skipped, so the push never advances it. The pushed rows' authoritative values are
	 * already in `rows`, so the client doesn't need to pull again to see its own writes.
	 */
	cursor: string | null;
	/** `{ temp ref → illusi_id }` for every applied entity of `changes.entities`. */
	id_map: Record<string, string>;
	/** `{ temp_id → server id }` for new inheritance rows. */
	inherited_id_map: { playlist_inherited_searches: Record<string, number>; playlist_inherited_playlists: Record<string, number> };
	/** Authoritative values of every row this push touched, applied or not, plus redirects for merged ids it referenced. */
	rows: SyncRows;
	entities: { created: EntityOutcome[]; matched: MatchedOutcome[]; conflicts: ConflictReport[]; rejected: Rejection[] };
	rejected: PushRejection[];
	/** Rows actually written per table (LWW losers and duplicates are not counted). */
	applied: Partial<Record<PushTable | 'profile', number>>;
	/** For first-import progress bars. */
	progress: { entities: number; user_rows: number; created: number; matched: number; rejected: number };
}
