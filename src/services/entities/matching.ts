/**
 * Pure matching decisions. The engine fetches candidates from the database and these
 * functions decide; nothing here touches the database.
 */
import { DURATION_TOLERANCE_MS, durations_match, name_similarity, names_match, normalize_name, primary_artist_name } from '../../core/normalize';
import { UNIQUE_SERVICE_ID_COLUMNS } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';

export interface IdCandidate { illusi_id: string; columns: ServiceIdColumn[] }

export type ServiceIdDecision
	= | { kind: 'none' }
		| {
			kind: 'match';
			illusi_id: string;
			/** Other entities holding one of the entity's unique ids: recorded as conflicts. */
			others: IdCandidate[];
		};

/** Unique columns identify an entity; a shared ISRC only hints. */
const id_score = (c: IdCandidate) => c.columns.reduce((sum, col) => sum + (col === 'isrc' ? 1 : 10), 0);

/**
 * Picks the best service-id hit. Ties (and several ISRC-only hits) are broken by `tiebreak`
 * (e.g. a metadata score), then by input order. Other hits with a unique column are conflicts.
 */
export function decide_service_id_match(candidates: readonly IdCandidate[], tiebreak: (illusi_id: string) => number = () => 0): ServiceIdDecision {
	if (candidates.length === 0) return { kind: 'none' };
	const ranked = candidates
		.map((c, i) => ({ c, i, score: id_score(c), tie: tiebreak(c.illusi_id) }))
		.sort((a, b) => b.score - a.score || b.tie - a.tie || a.i - b.i);
	const [best, ...rest] = ranked;
	return {
		kind: 'match',
		illusi_id: best.c.illusi_id,
		others: rest.filter(r => r.c.columns.some(col => col !== 'isrc')).map(r => r.c)
	};
}

export type Strength = 'strong' | 'unclear' | 'none';
export interface Evaluation { id: string; strength: Strength; score: number }

export type MetadataDecision
	= | { kind: 'match'; illusi_id: string; others: string[] }
		| { kind: 'unclear'; candidates: string[] }
		| { kind: 'none' };

/** Best strong match (other strong ones are possible duplicates); else every unclear candidate; else none. */
export function decide_metadata(evaluations: readonly Evaluation[]): MetadataDecision {
	const strong = evaluations.filter(e => e.strength === 'strong').sort((a, b) => b.score - a.score);
	if (strong.length > 0) return { kind: 'match', illusi_id: strong[0].id, others: strong.slice(1).map(e => e.id) };
	const unclear = evaluations.filter(e => e.strength === 'unclear').sort((a, b) => b.score - a.score);
	if (unclear.length > 0) return { kind: 'unclear', candidates: unclear.map(e => e.id) };
	return { kind: 'none' };
}

const any_name_matches = (name: string, names: readonly string[]) => names.some(n => names_match(name, n));

export interface TrackQuery {
	title: string;
	duration_ms?: number | null;
	/** Resolved artist ids, primary first. */
	artist_ids?: readonly string[];
	/** Display artist string (`/resolve`); its primary artist is compared. */
	artist_name?: string | null;
	album_id?: string | null;
	album_name?: string | null;
}
export interface TrackCandidate {
	id: string;
	title: string;
	duration_ms: number | null;
	artist_ids: readonly string[];
	artist_names: readonly string[];
	album_ids: readonly string[];
	album_names: readonly string[];
}

type Check = 'ok' | 'unknown' | 'mismatch';

function check_artist(q: { artist_ids?: readonly string[]; artist_name?: string | null; artist_id?: string | null }, c: { artist_ids: readonly string[]; artist_names: readonly string[] }): Check {
	const primary_id = q.artist_id ?? q.artist_ids?.[0];
	if (primary_id) return c.artist_ids.includes(primary_id) ? 'ok' : (q.artist_name && any_name_matches(primary_artist_name(q.artist_name), c.artist_names) ? 'ok' : 'mismatch');
	if (q.artist_name) {
		if (c.artist_names.length === 0) return 'unknown';
		return any_name_matches(primary_artist_name(q.artist_name), c.artist_names) ? 'ok' : 'mismatch';
	}
	return 'unknown';
}

/**
 * Tracks: title and primary artist must match, and duration within tolerance.
 * A missing duration, an unknown artist, or a different album (same song, other release) makes it unclear.
 * Durations that clearly differ mean a different recording: no match.
 */
export function evaluate_track(q: TrackQuery, c: TrackCandidate): Evaluation {
	const none = { id: c.id, strength: 'none' as const, score: 0 };
	const title_sim = name_similarity(q.title, c.title);
	if (!names_match(q.title, c.title)) return none;
	const artist = check_artist(q, c);
	if (artist === 'mismatch') return none;
	let duration: Check = 'unknown';
	if (q.duration_ms != null && c.duration_ms != null) duration = durations_match(q.duration_ms, c.duration_ms) ? 'ok' : 'mismatch';
	if (duration === 'mismatch') return none;
	let album: Check = 'unknown';
	if (q.album_id && c.album_ids.length > 0) album = c.album_ids.includes(q.album_id) ? 'ok' : 'mismatch';
	if (album !== 'ok' && q.album_name && c.album_names.length > 0) album = any_name_matches(q.album_name, c.album_names) ? 'ok' : 'mismatch';
	const score = title_sim
		+ (album === 'ok' ? 0.5 : 0)
		+ (duration === 'ok' ? 0.5 * (1 - Math.abs(q.duration_ms! - c.duration_ms!) / (DURATION_TOLERANCE_MS + 1)) : 0);
	const strong = artist === 'ok' && duration === 'ok' && album !== 'mismatch';
	return { id: c.id, strength: strong ? 'strong' : 'unclear', score };
}

export interface AlbumQuery { name: string; artist_id?: string | null; artist_name?: string | null }
export interface AlbumCandidate { id: string; name: string; artist_ids: readonly string[]; artist_names: readonly string[] }

/** Albums: name and artist. An unknown artist on either side is unclear; a different artist is no match. */
export function evaluate_album(q: AlbumQuery, c: AlbumCandidate): Evaluation {
	if (!names_match(q.name, c.name)) return { id: c.id, strength: 'none', score: 0 };
	const artist = check_artist(q, c);
	if (artist === 'mismatch') return { id: c.id, strength: 'none', score: 0 };
	return { id: c.id, strength: artist === 'ok' ? 'strong' : 'unclear', score: name_similarity(q.name, c.name) };
}

export interface ArtistQuery {
	name: string;
	/** `illusi_id`s of payload works (albums, tracks) linked to this artist that are already known. */
	work_ids?: readonly string[];
	album_names?: readonly string[];
	track_titles?: readonly string[];
	/** The incoming artist's normalized service ids. */
	service_ids?: Partial<Record<ServiceIdColumn, string>>;
}
export interface ArtistCandidate {
	id: string;
	name: string;
	work_ids: readonly string[];
	album_names: readonly string[];
	track_titles: readonly string[];
	service_ids?: Partial<Record<ServiceIdColumn, string>>;
}

/**
 * Service ids that tell two same-name artists apart. Not YouTube: an artist's id there is a channel, and one artist
 * has several (their own, an auto-generated "Topic" channel), while uploaders like Lyrical Lemonade post many artists.
 */
export const ARTIST_IDENTITY_COLUMNS: readonly ServiceIdColumn[] = UNIQUE_SERVICE_ID_COLUMNS.filter(c => c !== 'youtube_id');

/** Both artists have an id on the same service and the ids differ: two artists who share a name. */
export function artist_ids_differ(a: Partial<Record<ServiceIdColumn, string>> | undefined, b: Partial<Record<ServiceIdColumn, string>> | undefined): boolean {
	if (!a || !b) return false;
	return ARTIST_IDENTITY_COLUMNS.some(col => a[col] != null && b[col] != null && a[col] !== b[col]);
}

/**
 * Artists: name plus a shared album or track (by id, or by name) is strong. The same name (case, accents and
 * punctuation aside) without a shared work is strong too, unless their ids on some service differ: a new song by
 * an artist already in the catalog joins that artist instead of creating another one. Among several, the one with
 * a shared work wins, then the one with the most works. A merely similar name without a shared work is unclear.
 */
export function evaluate_artist(q: ArtistQuery, c: ArtistCandidate): Evaluation {
	if (!names_match(q.name, c.name)) return { id: c.id, strength: 'none', score: 0 };
	const name_sim = name_similarity(q.name, c.name);
	const shared_id = (q.work_ids ?? []).some(id => c.work_ids.includes(id));
	const shared_album = (q.album_names ?? []).some(n => any_name_matches(n, c.album_names));
	const shared_track = (q.track_titles ?? []).some(t => any_name_matches(t, c.track_titles));
	const shared = shared_id || shared_album || shared_track;
	const different_ids = artist_ids_differ(q.service_ids, c.service_ids);
	if (shared && !different_ids) return { id: c.id, strength: 'strong', score: name_sim + 1 + (shared_id ? 1 : 0) + (shared_album || shared_track ? 0.5 : 0) };
	const same_name = normalize_name(q.name) === normalize_name(c.name) && normalize_name(q.name) !== '';
	if (same_name && !different_ids) return { id: c.id, strength: 'strong', score: Math.min(c.work_ids.length, 999) / 1000 };
	return { id: c.id, strength: 'unclear', score: name_sim + (shared ? 0.5 : 0) };
}
