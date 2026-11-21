import type { LyricsService, ParsedLyrics, SyncType } from './types';

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

/** Words, with each CJK character its own token since those scripts don't separate words. */
const TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu;

function lyrics_tokens(parsed: ParsedLyrics): string[] {
	return parsed.lines.map(l => l.text).join('\n').normalize('NFKC').toLowerCase().match(TOKEN_RE) ?? [];
}

/** Word pairs (single words when there's only one), so both the words and their order count. */
function shingle_counts(tokens: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	const shingles = tokens.length < 2 ? tokens : tokens.slice(1).map((t, i) => `${tokens[i]} ${t}`);
	for (const s of shingles) counts.set(s, (counts.get(s) ?? 0) + 1);
	return counts;
}

function dice(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
	let size = 0;
	let shared = 0;
	for (const n of a.values()) size += n;
	for (const [s, n] of b) {
		size += n;
		shared += Math.min(n, a.get(s) ?? 0);
	}
	return size === 0 ? 1 : 2 * shared / size;
}

/** 0–1: how much of the same text, in the same order, two lyrics share. Timing is ignored. */
export function lyrics_similarity(a: ParsedLyrics, b: ParsedLyrics): number {
	return dice(shingle_counts(lyrics_tokens(a)), shingle_counts(lyrics_tokens(b)));
}

/**
 * The candidate whose text agrees most with the rest (highest total similarity), so one service's
 * mistranscription or wrong song loses to the version the others share. Ties, and any two candidates,
 * keep the given order.
 */
export function pick_consensus<T extends { parsed: ParsedLyrics }>(candidates: readonly T[]): T | undefined {
	if (candidates.length < 3) return candidates[0];
	const shingles = candidates.map(c => shingle_counts(lyrics_tokens(c.parsed)));
	const totals = shingles.map((a, i) => shingles.reduce((sum, b, j) => (i === j ? sum : sum + dice(a, b)), 0));
	let best = 0;
	for (let i = 1; i < candidates.length; i++) if (totals[i] > totals[best]) best = i;
	return candidates[best];
}
