import type { LyricsService, SyncType } from './types';

/** What a ranker sees about a stored row; the raw content isn't needed to order candidates. */
export interface RankCandidate {
	id: number;
	service: LyricsService;
	sync_type: SyncType;
	created_at: Date;
}

/** Orders candidates best-first. Ranking runs on read, so swapping the metric needs no migration. */
export type LyricsRanker = <T extends RankCandidate>(candidates: readonly T[]) => T[];

const SYNC_RANK: Record<SyncType, number> = { SYLLABLE: 3, WORD: 2, LINE: 1, NONE: 0 };

/** Placeholder metric: richer sync first (`SYLLABLE` > `WORD` > `LINE` > `NONE`), then newest, then highest id. */
export const default_ranker: LyricsRanker = candidates => [...candidates].sort((a, b) =>
	SYNC_RANK[b.sync_type] - SYNC_RANK[a.sync_type]
	|| b.created_at.getTime() - a.created_at.getTime()
	|| b.id - a.id);

let ranker: LyricsRanker = default_ranker;

/** Replaces the ranking metric (pluggable `rank_lyrics()`). */
export function set_lyrics_ranker(next: LyricsRanker) {
	ranker = next;
}

/**
 * Best-first order. Callers walk it and serve the first row that parses, so a row that fails to
 * parse is never chosen.
 */
export function rank_lyrics<T extends RankCandidate>(candidates: readonly T[]): T[] {
	return ranker(candidates);
}
