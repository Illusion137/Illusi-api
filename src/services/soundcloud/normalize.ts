import { z } from 'zod';
import { truncate_to_columns } from '../../core/truncate';
import { soundcloud_playlist_table, soundcloud_tracks_table, soundcloud_transcodings_table, soundcloud_users_table } from '../../db/schema';

type Insert<T extends { $inferInsert: unknown }> = Omit<T['$inferInsert'], 'created_at' | 'modified_at'>;
export type UserRow = Insert<typeof soundcloud_users_table>;
export type TrackRow = Insert<typeof soundcloud_tracks_table>;
export type TranscodingRow = Omit<Insert<typeof soundcloud_transcodings_table>, 'id' | 'last_seen_at'>;
export type PlaylistRow = Insert<typeof soundcloud_playlist_table>;

export interface TrackEntry {
	row: TrackRow;
	/** `null` when the track had no `media` block (keep stored transcodings untouched). */
	transcodings: TranscodingRow[] | null;
	permalink_url: string | null;
}

export interface PlaylistEntry {
	row: PlaylistRow;
	/** Track ids in playlist order (full tracks and stubs), `null` when `tracks` was absent. */
	members: number[] | null;
	permalink_url: string | null;
}

/** Everything a request contributes, flattened and deduped by SoundCloud id. */
export interface Batch {
	users: Map<number, UserRow>;
	tracks: Map<number, TrackEntry>;
	playlists: Map<number, PlaylistEntry>;
}

/** Counters that are always updated to the newest value seen, even from stale objects. */
export const VOLATILE_FIELDS = {
	users: ['followers_count', 'followings_count', 'track_count', 'playlist_count', 'likes_count', 'playlist_likes_count', 'comments_count', 'groups_count', 'reposts_count'],
	tracks: ['playback_count', 'likes_count', 'reposts_count', 'comment_count', 'download_count'],
	playlists: ['likes_count', 'reposts_count', 'track_count']
} as const;

type Obj = Record<string, unknown>;

const id_schema = z.preprocess(
	v => (typeof v === 'string' && /^\d{1,16}$/u.test(v) ? Number(v) : v),
	z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
);
const text_schema = z.string().trim().min(1);
const user_schema = z.looseObject({ kind: z.literal('user'), id: id_schema, permalink: text_schema, username: text_schema });
const track_schema = z.looseObject({ kind: z.literal('track'), id: id_schema, title: text_schema });
const stub_schema = z.looseObject({ id: id_schema });
const playlist_schema = z.looseObject({ kind: z.literal('playlist'), id: id_schema, title: text_schema });

const is_obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const int = (v: unknown): number | null => {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const date = (v: unknown): Date | null => {
	if (typeof v !== 'string' && typeof v !== 'number') return null;
	if (typeof v === 'string' && v.trim() === '') return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
};

const MAX_UNWRAP_DEPTH = 3;

/**
 * Expands raw `collection` arrays (or `{ collection }` pages) and unwraps `LikedTrack` / `HistoryTrack`
 * (and similar `{ user }` / `{ playlist }`) wrappers into plain SoundCloud objects.
 */
export function unwrap_items(items: readonly unknown[], depth = 0): unknown[] {
	const out: unknown[] = [];
	for (const item of items) {
		if (Array.isArray(item)) {
			if (depth < MAX_UNWRAP_DEPTH) out.push(...unwrap_items(item, depth + 1));
			else out.push(item);
		} else if (is_obj(item) && item.kind === undefined && Array.isArray(item.collection)) {
			if (depth < MAX_UNWRAP_DEPTH) out.push(...unwrap_items(item.collection, depth + 1));
			else out.push(item);
		} else if (is_obj(item) && (item.kind === undefined || item.kind === 'like') && (is_obj(item.track) || is_obj(item.playlist) || is_obj(item.user))) {
			out.push(item.track ?? item.playlist ?? item.user);
		} else {
			out.push(item);
		}
	}
	return out;
}

export function map_user(u: Obj): UserRow | null {
	const parsed = user_schema.safeParse(u);
	if (!parsed.success) return null;
	const v = parsed.data;
	const badges = is_obj(v.badges) ? v.badges : {};
	return truncate_to_columns(soundcloud_users_table, {
		id: v.id,
		permalink: v.permalink,
		username: v.username,
		first_name: str(v.first_name),
		last_name: str(v.last_name),
		full_name: str(v.full_name),
		avatar_url: str(v.avatar_url),
		city: str(v.city),
		country_code: str(v.country_code),
		description: str(v.description),
		verified: bool(v.verified) ?? bool(badges.verified),
		badge_pro: bool(badges.pro),
		badge_creator_mid_tier: bool(badges.creator_mid_tier),
		badge_pro_unlimited: bool(badges.pro_unlimited),
		followers_count: int(v.followers_count),
		followings_count: int(v.followings_count),
		track_count: int(v.track_count),
		playlist_count: int(v.playlist_count),
		likes_count: int(v.likes_count),
		playlist_likes_count: int(v.playlist_likes_count),
		comments_count: int(v.comments_count),
		groups_count: int(v.groups_count),
		reposts_count: int(v.reposts_count),
		soundcloud_created_at: date(v.created_at),
		soundcloud_last_modified: date(v.last_modified)
	}, `soundcloud user ${v.id}`);
}

/** `media` is `{ transcodings }` (or, per the lib-origin `Track` type, an array of those). `null` = no media block. */
export function map_transcodings(track_id: number, media: unknown): TranscodingRow[] | null {
	const blocks = Array.isArray(media) ? media.filter(is_obj) : is_obj(media) ? [media] : null;
	if (blocks === null) return null;
	const rows = new Map<string, TranscodingRow>();
	for (const block of blocks) {
		if (!Array.isArray(block.transcodings)) continue;
		for (const t of block.transcodings) {
			if (!is_obj(t)) continue;
			const url = str(t.url);
			// A truncated URL is useless, so over-long URLs are dropped rather than truncated.
			if (!url || url.length > 512) continue;
			const format = is_obj(t.format) ? t.format : {};
			rows.set(url, truncate_to_columns(soundcloud_transcodings_table, {
				track_id,
				url,
				preset: str(t.preset),
				protocol: str(format.protocol),
				mime_type: str(format.mime_type),
				quality: str(t.quality),
				duration: int(t.duration),
				snipped: bool(t.snipped)
			}, `soundcloud transcoding of ${track_id}`));
		}
	}
	return [...rows.values()];
}

export function map_track(t: Obj): TrackEntry | null {
	const parsed = track_schema.safeParse(t);
	if (!parsed.success) return null;
	const v = parsed.data;
	const pm = is_obj(v.publisher_metadata) ? v.publisher_metadata : {};
	const user_id = int(v.user_id) ?? (is_obj(v.user) ? int(v.user.id) : null);
	const row = truncate_to_columns(soundcloud_tracks_table, {
		id: v.id,
		user_id: user_id !== null && user_id > 0 ? user_id : null,
		permalink: str(v.permalink),
		title: v.title,
		description: str(v.description),
		caption: str(v.caption),
		genre: str(v.genre),
		tag_list: str(v.tag_list),
		license: str(v.license),
		label_name: str(v.label_name),
		artwork_url: str(v.artwork_url),
		waveform_url: str(v.waveform_url),
		duration: int(v.duration),
		full_duration: int(v.full_duration),
		state: str(v.state),
		sharing: str(v.sharing),
		embeddable_by: str(v.embeddable_by),
		policy: str(v.policy),
		monetization_model: str(v.monetization_model),
		public: bool(v.public),
		streamable: bool(v.streamable),
		commentable: bool(v.commentable),
		downloadable: bool(v.downloadable),
		playback_count: int(v.playback_count),
		likes_count: int(v.likes_count),
		reposts_count: int(v.reposts_count),
		comment_count: int(v.comment_count),
		download_count: int(v.download_count),
		publisher_artist: str(pm.artist),
		album_title: str(pm.album_title),
		release_title: str(pm.release_title),
		isrc: str(pm.isrc),
		upc_or_ean: str(pm.upc_or_ean),
		explicit: bool(pm.explicit),
		contains_music: bool(pm.contains_music),
		writer_composer: str(pm.writer_composer),
		p_line: str(pm.p_line),
		c_line: str(pm.c_line),
		release_date: date(v.release_date),
		display_date: date(v.display_date),
		soundcloud_created_at: date(v.created_at),
		soundcloud_last_modified: date(v.last_modified)
	}, `soundcloud track ${v.id}`);
	return { row, transcodings: map_transcodings(v.id, v.media), permalink_url: str(v.permalink_url) };
}

export function map_playlist(p: Obj): PlaylistEntry | null {
	const parsed = playlist_schema.safeParse(p);
	if (!parsed.success) return null;
	const v = parsed.data;
	const user = Array.isArray(v.user) ? v.user.find(is_obj) : v.user;
	const user_id = int(v.user_id) ?? (is_obj(user) ? int(user.id) : null);
	let members: number[] | null = null;
	if (Array.isArray(v.tracks)) {
		members = [];
		for (const t of v.tracks) {
			const stub = stub_schema.safeParse(t);
			if (stub.success) members.push(stub.data.id);
		}
	}
	const row = truncate_to_columns(soundcloud_playlist_table, {
		id: v.id,
		user_id: user_id !== null && user_id > 0 ? user_id : null,
		permalink: str(v.permalink),
		title: v.title,
		description: str(v.description),
		genre: str(v.genre),
		tag_list: str(v.tag_list),
		license: str(v.license),
		label_name: str(v.label_name),
		artwork_url: str(v.artwork_url),
		set_type: str(v.set_type),
		sharing: str(v.sharing),
		embeddable_by: str(v.embeddable_by),
		is_album: bool(v.is_album),
		public: bool(v.public),
		duration: int(v.duration),
		track_count: int(v.track_count),
		likes_count: int(v.likes_count),
		reposts_count: int(v.reposts_count),
		release_date: date(v.release_date),
		published_at: date(v.published_at),
		display_date: date(v.display_date),
		soundcloud_created_at: date(v.created_at),
		soundcloud_last_modified: date(v.last_modified)
	}, `soundcloud playlist ${v.id}`);
	return { row, members, permalink_url: str(v.permalink_url) };
}

const lm_time = (row: { soundcloud_last_modified?: Date | null }) => row.soundcloud_last_modified?.getTime() ?? null;

const filled_count = (row: object) => Object.values(row).filter(v => v !== null && v !== undefined).length;

/**
 * Merges two versions of the same entity: the newer one (by `last_modified`, else the fuller one,
 * else the later one) wins every field it has, and the other only fills its gaps.
 * Returns `[merged, primary_is_b]`.
 */
export function merge_rows<T extends { soundcloud_last_modified?: Date | null }>(a: T, b: T): [T, boolean] {
	const ta = lm_time(a);
	const tb = lm_time(b);
	const b_first = ta !== null && tb !== null ? tb >= ta : ta === null && tb === null ? filled_count(b) >= filled_count(a) : tb !== null;
	const [primary, secondary] = b_first ? [b, a] : [a, b];
	const out: Record<string, unknown> = { ...secondary };
	for (const [key, value] of Object.entries(primary)) {
		if (value !== null && value !== undefined) out[key] = value;
	}
	return [out as T, b_first];
}

function merge_track(a: TrackEntry, b: TrackEntry): TrackEntry {
	const [row, b_first] = merge_rows(a.row, b.row);
	const [p, s] = b_first ? [b, a] : [a, b];
	return { row, transcodings: p.transcodings ?? s.transcodings, permalink_url: p.permalink_url ?? s.permalink_url };
}

function merge_playlist(a: PlaylistEntry, b: PlaylistEntry): PlaylistEntry {
	const [row, b_first] = merge_rows(a.row, b.row);
	const [p, s] = b_first ? [b, a] : [a, b];
	const complete = (e: PlaylistEntry) => e.members !== null && e.members.length === e.row.track_count;
	let members: number[] | null;
	if (p.members === null || s.members === null) members = p.members ?? s.members;
	else if (complete(p) !== complete(s)) members = complete(p) ? p.members : s.members;
	else members = s.members.length > p.members.length ? s.members : p.members;
	return { row, members, permalink_url: p.permalink_url ?? s.permalink_url };
}

export interface FlattenResult {
	batch: Batch;
	accepted: number;
	rejected: number;
}

/**
 * Validates and flattens the (already unwrapped) top-level items: nested users and playlist
 * tracks become their own rows, stubs only contribute membership, duplicates are merged.
 * Malformed items and unknown kinds count as rejected; nested junk is dropped silently.
 */
export function flatten_items(items: readonly unknown[]): FlattenResult {
	const batch: Batch = { users: new Map(), tracks: new Map(), playlists: new Map() };
	let accepted = 0;
	let rejected = 0;

	const add_user = (raw: unknown) => {
		if (!is_obj(raw)) return false;
		const row = map_user(raw);
		if (!row) return false;
		const prev = batch.users.get(row.id);
		batch.users.set(row.id, prev ? merge_rows(prev, row)[0] : row);
		return true;
	};
	const add_users = (raw: unknown) => {
		for (const u of Array.isArray(raw) ? raw : [raw]) add_user(u);
	};
	const add_track = (raw: Obj) => {
		const entry = map_track(raw);
		if (!entry) return false;
		add_users(raw.user);
		const prev = batch.tracks.get(entry.row.id);
		batch.tracks.set(entry.row.id, prev ? merge_track(prev, entry) : entry);
		return true;
	};
	const add_playlist = (raw: Obj) => {
		const entry = map_playlist(raw);
		if (!entry) return false;
		add_users(raw.user);
		if (Array.isArray(raw.tracks)) {
			for (const t of raw.tracks) {
				// Full tracks carry a title; `Track0` stubs only give membership.
				if (is_obj(t) && typeof t.title === 'string') add_track({ ...t, kind: 'track' });
			}
		}
		const prev = batch.playlists.get(entry.row.id);
		batch.playlists.set(entry.row.id, prev ? merge_playlist(prev, entry) : entry);
		return true;
	};

	for (const item of items) {
		let ok = false;
		if (is_obj(item)) {
			if (item.kind === 'user') ok = add_user(item);
			else if (item.kind === 'track') ok = add_track(item);
			else if (item.kind === 'playlist') ok = add_playlist(item);
		}
		if (ok) accepted++;
		else rejected++;
	}

	dedupe_user_permalinks(batch.users);
	return { batch, accepted, rejected };
}

/** `permalink` is unique: if two batch users claim the same one, keep the most recently modified. */
function dedupe_user_permalinks(users: Map<number, UserRow>) {
	const by_permalink = new Map<string, UserRow>();
	for (const user of users.values()) {
		const key = user.permalink.toLowerCase();
		const prev = by_permalink.get(key);
		if (!prev) {
			by_permalink.set(key, user);
			continue;
		}
		const keep_new = (lm_time(user) ?? 0) >= (lm_time(prev) ?? 0);
		users.delete(keep_new ? prev.id : user.id);
		if (keep_new) by_permalink.set(key, user);
	}
}

/** Stale-data rule: only when both are known and the incoming one is strictly older. */
export function is_stale(incoming: Date | null | undefined, stored: Date | null | undefined): boolean {
	return incoming != null && stored != null && incoming.getTime() < stored.getTime();
}

export type MembershipDecision = { mode: 'none' } | { mode: 'replace' | 'add'; rows: { track_id: number; position: number }[] };

/**
 * Playlist membership rule: a complete list (`tracks.length === track_count`) replaces the
 * membership, a partial one only adds. Tracks without a stored row are skipped; duplicates keep
 * their first position.
 */
export function decide_membership(members: readonly number[] | null, track_count: number | null | undefined, known_track_ids: ReadonlySet<number>): MembershipDecision {
	if (members === null) return { mode: 'none' };
	const complete = track_count != null && members.length === track_count;
	const seen = new Set<number>();
	const rows: { track_id: number; position: number }[] = [];
	members.forEach((track_id, position) => {
		if (seen.has(track_id)) return;
		seen.add(track_id);
		if (known_track_ids.has(track_id)) rows.push({ track_id, position });
	});
	if (!complete && rows.length === 0) return { mode: 'none' };
	return { mode: complete ? 'replace' : 'add', rows };
}

const same_value = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

/**
 * Fields this submission actually changed, for the provenance log. Mirrors the SQL upsert:
 * nulls never overwrite, and stale objects only move the volatile counters.
 */
export function changed_fields(existing: Record<string, unknown> | undefined, incoming: Record<string, unknown>, volatile: readonly string[]): string[] {
	if (!existing) return ['*'];
	const stale = is_stale(incoming.soundcloud_last_modified as Date | null, existing.soundcloud_last_modified as Date | null);
	const out: string[] = [];
	for (const [key, value] of Object.entries(incoming)) {
		if (key === 'id' || value === null || value === undefined) continue;
		if (stale && !volatile.includes(key)) continue;
		if (!same_value(existing[key], value)) out.push(key);
	}
	return out;
}
