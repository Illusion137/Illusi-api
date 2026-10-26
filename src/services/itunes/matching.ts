import type { ITunesArtist, ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { DURATION_TOLERANCE_MS, durations_match, name_similarity, normalize_name } from '../../core/normalize';

/** Lookup request types. */
export type LookupRequest
	= | { type: 'artist'; artist_name: string }
		| { type: 'album'; artist_name: string; album_name: string; track_count?: number | null }
		| { type: 'track'; artist_name: string; album_name?: string | null; track_name: string; duration_ms?: number | null };

/** Dedupe key: type + normalized fields. */
export function request_key(req: LookupRequest): string {
	switch (req.type) {
		case 'artist': return `artist|${normalize_name(req.artist_name)}`;
		case 'album': return `album|${normalize_name(req.artist_name)}|${normalize_name(req.album_name)}`;
		case 'track': return `track|${normalize_name(req.artist_name)}|${normalize_name(req.album_name ?? '')}|${normalize_name(req.track_name)}|${req.duration_ms ?? ''}`;
	}
}

/** Scores are bucketed so near-identical scores count as a tie that the later criteria break. */
const bucket = (score: number) => Math.round(score * 100) / 100;

const explicit_rank = (e: string | undefined) => (e === 'explicit' ? 2 : e === 'notExplicit' ? 1 : 0);

function best_name_score(name: string, ...candidates: (string | undefined)[]): number {
	let best = 0;
	for (const c of candidates) if (c) best = Math.max(best, name_similarity(name, c));
	return best;
}

/** Artists whose name matches, best first (iTunes order on ties). */
export function rank_artists(artist_name: string, candidates: readonly ITunesArtist[], threshold: number): ITunesArtist[] {
	return candidates
		.filter(c => c.artistId != null && c.artistName)
		.map((c, i) => ({ c, i, score: bucket(name_similarity(artist_name, c.artistName!)) }))
		.filter(x => x.score >= threshold)
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.map(x => x.c);
}

/**
 * Albums whose `collectionName` / `collectionCensoredName` match, best first.
 * Ties prefer an explicit version, then the closest `trackCount` when the local one is known.
 */
export function rank_albums(album_name: string, candidates: readonly ITunesCollection[], threshold: number, track_count?: number | null): ITunesCollection[] {
	return candidates
		.filter(c => c.collectionId != null && c.collectionName)
		.map((c, i) => ({ c, i, score: bucket(best_name_score(album_name, c.collectionName, c.collectionCensoredName)) }))
		.filter(x => x.score >= threshold)
		.sort((a, b) => b.score - a.score
			|| explicit_rank(b.c.collectionExplicitness) - explicit_rank(a.c.collectionExplicitness)
			|| (track_count != null ? Math.abs((a.c.trackCount ?? 0) - track_count) - Math.abs((b.c.trackCount ?? 0) - track_count) : 0)
			|| a.i - b.i)
		.map(x => x.c);
}

export interface TrackQuery { track_name: string; album_name?: string | null; duration_ms?: number | null }

/**
 * Best matching song: name similarity ≥ threshold, then duration within ±3 s breaks ties,
 * then a matching album name, then `trackExplicitness = 'explicit'`, then the closest duration.
 */
export function pick_track(query: TrackQuery, candidates: readonly ITunesTrack[], threshold: number): ITunesTrack | null {
	const scored = candidates
		.filter(c => c.wrapperType === 'track' && (c.kind === undefined || c.kind === 'song') && c.trackId != null && c.trackName)
		.map((c, i) => ({
			c,
			i,
			score: bucket(best_name_score(query.track_name, c.trackName, c.trackCensoredName)),
			in_tolerance: durations_match(query.duration_ms, c.trackTimeMillis, DURATION_TOLERANCE_MS) ? 1 : 0,
			album: query.album_name ? (best_name_score(query.album_name, c.collectionName, c.collectionCensoredName) >= threshold ? 1 : 0) : 0,
			diff: query.duration_ms != null && c.trackTimeMillis != null ? Math.abs(query.duration_ms - c.trackTimeMillis) : Number.MAX_SAFE_INTEGER
		}))
		.filter(x => x.score >= threshold);
	scored.sort((a, b) => b.score - a.score
		|| b.in_tolerance - a.in_tolerance
		|| b.album - a.album
		|| explicit_rank(b.c.trackExplicitness) - explicit_rank(a.c.trackExplicitness)
		|| a.diff - b.diff
		|| a.i - b.i);
	return scored[0]?.c ?? null;
}

/**
 * A match good enough to stop looking up more album batches: exact-score name, duration fits (when
 * known), and not a cleaned version (an explicit one could still turn up in a later batch).
 */
export function is_conclusive_track(query: TrackQuery, track: ITunesTrack): boolean {
	if (best_name_score(query.track_name, track.trackName, track.trackCensoredName) < 1) return false;
	if (query.duration_ms != null && !durations_match(query.duration_ms, track.trackTimeMillis)) return false;
	return track.trackExplicitness !== 'cleaned';
}
