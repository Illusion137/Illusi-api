import type { EntityKind } from './types';

export type Row = Record<string, unknown>;

/** A table that references an entity id and has to follow it on a merge. */
export interface RefTableSpec {
	table: string;
	/** Column holding the entity id. */
	ref_col: string;
	/** Columns identifying one row (for delete / update). */
	pk: string[];
	/**
	 * Unique keys, besides `ref_col`, that collide when survivor and loser both have a row. `[[]]` means
	 * `ref_col` alone is unique (one row per entity). Empty means rows never collide.
	 */
	unique_keys: string[][];
	/** Survivor columns to set when a loser row collides into it. Default: earliest `created_at`. */
	merge?: (survivor: Row, loser: Row) => Row;
	/** A column that must not end up equal to the entity id (`similar_artists_table` self pairs). */
	distinct_from?: string;
	has_modified_at: boolean;
}

export interface RefMergePlan {
	/** Loser rows dropped because they collided with (and were merged into) a survivor row, or would self-reference. */
	delete: Row[];
	/** Survivor rows that absorb a colliding loser row. */
	update: { key: Row; before: Row; set: Row }[];
	/** Loser rows that simply get `ref_col` pointed at the survivor. */
	repoint: Row[];
}

const as_time = (v: unknown) => v instanceof Date ? v.getTime() : typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN;

function same_value(a: unknown, b: unknown): boolean {
	if (a instanceof Date || b instanceof Date) return as_time(a) === as_time(b);
	return String(a) === String(b);
}

function earliest(a: unknown, b: unknown): unknown {
	if (a == null) return b;
	if (b == null) return a;
	return as_time(b) < as_time(a) ? b : a;
}

function latest(a: unknown, b: unknown): unknown {
	if (a == null) return b;
	if (b == null) return a;
	return as_time(b) > as_time(a) ? b : a;
}

/** Keep the earliest `created_at`. */
export function merge_created(s: Row, l: Row): Row {
	return 'created_at' in s ? { created_at: earliest(s.created_at, l.created_at) } : {};
}

/** Library / playlist membership: the merged row is live if either was (union), keeps the earliest add and the latest edit. */
export function merge_membership(s: Row, l: Row): Row {
	const set: Row = { ...merge_created(s, l), deleted: s.deleted === true && l.deleted === true };
	if ('edited_at' in s) set.edited_at = latest(s.edited_at, l.edited_at);
	for (const col of ['title', 'downloaded_at', 'start_at', 'end_at', 'track_number', 'position']) {
		if (col in s && s[col] == null && l[col] != null) set[col] = l[col];
	}
	return set;
}

function fill_nulls(cols: string[]) {
	return (s: Row, l: Row): Row => {
		const set = merge_created(s, l);
		for (const col of cols) if (s[col] == null && l[col] != null) set[col] = l[col];
		return set;
	};
}

/** For lookup bookkeeping: keep whichever row records the better outcome. */
function prefer_status(ranking: readonly string[], cols: string[]) {
	const rank = (v: unknown) => {
		const i = ranking.indexOf(String(v));
		return i < 0 ? ranking.length : i;
	};
	return (s: Row, l: Row): Row => {
		if (rank(l.status) >= rank(s.status)) return {};
		const set: Row = {};
		for (const col of cols) set[col] = l[col];
		return set;
	};
}

const keep_survivor = (): Row => ({});

/**
 * Pure: given every row of one referencing table that points at the survivor or the loser, decides
 * which loser rows are repointed, which collide on a composite / unique key and are merged into the
 * survivor's row (earliest `created_at`, union of flags), and which are dropped.
 */
export function plan_ref_merge(spec: RefTableSpec, survivor_id: string, loser_id: string, rows: readonly Row[]): RefMergePlan {
	const survivor_rows = rows.filter(r => same_value(r[spec.ref_col], survivor_id));
	const loser_rows = rows.filter(r => same_value(r[spec.ref_col], loser_id));
	const plan: RefMergePlan = { delete: [], update: [], repoint: [] };
	const pending = new Map<Row, Row>();

	for (const l of loser_rows) {
		if (spec.distinct_from && same_value(l[spec.distinct_from], survivor_id)) {
			plan.delete.push(l);
			continue;
		}
		const hit = survivor_rows.find(s => spec.unique_keys.some(key => key.every(col => same_value(s[col], l[col]))));
		if (!hit) {
			plan.repoint.push(l);
			continue;
		}
		plan.delete.push(l);
		const current = { ...hit, ...pending.get(hit) };
		const set = (spec.merge ?? merge_created)(current, l);
		const changed = Object.fromEntries(Object.entries(set).filter(([k, v]) => !(current[k] == null && v == null) && (current[k] == null || v == null || !same_value(current[k], v))));
		if (Object.keys(changed).length > 0) pending.set(hit, { ...pending.get(hit), ...changed });
	}
	for (const [s, set] of pending) {
		plan.update.push({ key: Object.fromEntries(spec.pk.map(c => [c, s[c]])), before: s, set });
	}
	return plan;
}

const LYRICS_LOOKUP_RANK = ['FOUND', 'INSTRUMENTAL', 'NOT_FOUND', 'SKIPPED', 'ERROR'];
const SAMPLE_LOOKUP_RANK = ['DONE', 'NOT_FOUND', 'BAD_FILE', 'ERROR'];
const ITUNES_LOOKUP_RANK = ['FOUND', 'NOT_FOUND', 'ERROR'];

const itunes_lookups: RefTableSpec = { table: 'itunes_lookups_table', ref_col: 'illusi_id', pk: ['illusi_id'], unique_keys: [[]], merge: prefer_status(ITUNES_LOOKUP_RANK, ['status', 'attempts', 'attempted_at', 'retry_after']), has_modified_at: false };
/** `thumbnails_table.id` has no foreign key, so it has to be repointed explicitly. */
const thumbnails: RefTableSpec = { table: 'thumbnails_table', ref_col: 'id', pk: ['url'], unique_keys: [], has_modified_at: false };

/** Every table that references a track / album / artist id, in the order they are repointed. */
export const REF_TABLES: Record<Exclude<EntityKind, 'unknown'>, RefTableSpec[]> = {
	track: [
		{ table: 'user_tracks_table', ref_col: 'track_id', pk: ['user_id', 'track_id'], unique_keys: [['user_id']], merge: merge_membership, has_modified_at: true },
		{ table: 'playlist_tracks_table', ref_col: 'track_id', pk: ['playlist_id', 'track_id'], unique_keys: [['playlist_id']], merge: merge_membership, has_modified_at: true },
		{ table: 'track_plays_table', ref_col: 'track_id', pk: ['id'], unique_keys: [], has_modified_at: false },
		{ table: 'track_lyrics_table', ref_col: 'track_id', pk: ['id'], unique_keys: [['content_hash']], has_modified_at: true },
		{ table: 'track_lyrics_lookups_table', ref_col: 'track_id', pk: ['track_id', 'service'], unique_keys: [['service']], merge: prefer_status(LYRICS_LOOKUP_RANK, ['status', 'attempts', 'attempted_at', 'retry_after', 'source_user_id']), has_modified_at: false },
		{ table: 'track_sample_data_table', ref_col: 'id', pk: ['id'], unique_keys: [[]], merge: keep_survivor, has_modified_at: true },
		{ table: 'track_sample_lookups_table', ref_col: 'track_id', pk: ['track_id', 'source'], unique_keys: [['source']], merge: prefer_status(SAMPLE_LOOKUP_RANK, ['status', 'attempts', 'attempted_at', 'retry_after', 'source_ref']), has_modified_at: false },
		{ table: 'track_vectors_table', ref_col: 'track_id', pk: ['track_id'], unique_keys: [[]], merge: keep_survivor, has_modified_at: true },
		{ table: 'track_vocals_table', ref_col: 'track_id', pk: ['track_id'], unique_keys: [[]], merge: prefer_status(SAMPLE_LOOKUP_RANK, ['resource_id', 'status', 'attempts', 'attempted_at', 'retry_after', 'model', 'hop_ms', 'window_ms', 'duration_ms', 'voice', 'segments', 'rhythm_model', 'rhythm_bpm', 'rhythm_confidence', 'beats', 'bpm_estimates', 'words_model', 'words', 'word_times', 'word_probabilities', 'speech_model', 'speech_hop_ms', 'speech', 'beat_grid_model', 'grid_beats', 'downbeats']), has_modified_at: true },
		{ table: 'track_alignment_table', ref_col: 'track_id', pk: ['track_id'], unique_keys: [[]], merge: prefer_status(SAMPLE_LOOKUP_RANK, ['resource_id', 'status', 'attempts', 'attempted_at', 'retry_after', 'model', 'duration_ms', 'frame_ms', 'alphabet', 'letter_scale', 'letters', 'loudness', 'words_model', 'words', 'word_times', 'word_probabilities', 'beat_grid_model', 'grid_beats', 'downbeats', 'repeats', 'repeat_strengths']), has_modified_at: true },
		{ table: 'track_duration_reports_table', ref_col: 'track_id', pk: ['track_id', 'user_id'], unique_keys: [['user_id']], merge: keep_survivor, has_modified_at: true },
		{ table: 'media_table', ref_col: 'track_id', pk: ['id'], unique_keys: [['resource_id'], ['content_hash']], has_modified_at: true },
		{ table: 'album_tracks_table', ref_col: 'track_id', pk: ['album_id', 'track_id'], unique_keys: [['album_id']], merge: fill_nulls(['track_number']), has_modified_at: true },
		{ table: 'tracks_artists_table', ref_col: 'track_id', pk: ['artist_id', 'track_id'], unique_keys: [['artist_id']], has_modified_at: true },
		{ table: 'tracks_producers_table', ref_col: 'track_id', pk: ['producer_id', 'track_id'], unique_keys: [['producer_id']], has_modified_at: true },
		itunes_lookups,
		thumbnails
	],
	album: [
		{ table: 'tracks_table', ref_col: 'album_id', pk: ['id'], unique_keys: [], has_modified_at: true },
		{ table: 'album_tracks_table', ref_col: 'album_id', pk: ['album_id', 'track_id'], unique_keys: [['track_id']], merge: fill_nulls(['track_number']), has_modified_at: true },
		{ table: 'artist_albums_table', ref_col: 'album_id', pk: ['artist_id', 'album_id'], unique_keys: [['artist_id']], merge: fill_nulls(['position']), has_modified_at: true },
		itunes_lookups,
		thumbnails
	],
	artist: [
		{ table: 'albums_table', ref_col: 'artist_id', pk: ['id'], unique_keys: [], has_modified_at: true },
		{ table: 'tracks_artists_table', ref_col: 'artist_id', pk: ['artist_id', 'track_id'], unique_keys: [['track_id']], has_modified_at: true },
		{ table: 'artist_albums_table', ref_col: 'artist_id', pk: ['artist_id', 'album_id'], unique_keys: [['album_id']], merge: fill_nulls(['position']), has_modified_at: true },
		{ table: 'similar_artists_table', ref_col: 'artist_id', pk: ['artist_id', 'similar_artist_id'], unique_keys: [['similar_artist_id']], distinct_from: 'similar_artist_id', has_modified_at: true },
		{ table: 'similar_artists_table', ref_col: 'similar_artist_id', pk: ['artist_id', 'similar_artist_id'], unique_keys: [['artist_id']], distinct_from: 'artist_id', has_modified_at: true },
		itunes_lookups,
		thumbnails
	]
};

/** Entity row merge: the survivor keeps its values; empty columns are filled from the loser, flags are OR-ed. */
export function merge_entity_row(survivor: Row, loser: Row, flag_cols: readonly string[] = ['backpacked']): Row {
	const set: Row = {};
	for (const [col, value] of Object.entries(loser)) {
		if (col === 'id' || col === 'created_at' || col === 'modified_at') continue;
		if (flag_cols.includes(col)) {
			if (value === true && survivor[col] !== true) set[col] = true;
			continue;
		}
		if (survivor[col] == null && value != null) set[col] = value;
	}
	return set;
}
