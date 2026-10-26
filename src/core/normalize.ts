/**
 * Name matching shared by every service: iTunes resolution, the Genius track match,
 * contribution matching and reconciliation.
 */

export const DEFAULT_SIMILARITY_THRESHOLD = 0.9;
export const DURATION_TOLERANCE_MS = 3_000;

const FEATURE_RE = /[([]\s*(?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]|\s+(?:feat|ft|featuring)\.?\s.*$/giu;
const VERSION_WORDS = [
	'deluxe', 'deluxe edition', 'deluxe version', 'expanded edition', 'special edition', 'bonus track version',
	'remaster', 'remastered', 'remastered \\d{4}', '\\d{4} remaster', '\\d{4} remastered', 'explicit', 'clean',
	'single', 'ep', 'album version', 'radio edit', 'mono', 'stereo'
];
const VERSION_PAREN_RE = new RegExp(`[([]\\s*(?:${VERSION_WORDS.join('|')})\\s*[)\\]]`, 'giu');
const VERSION_DASH_RE = new RegExp(`\\s+-\\s+(?:${VERSION_WORDS.join('|')})\\s*$`, 'giu');

/** Lowercase, NFKC, strip Latin accents, `feat.` parts, version suffixes and punctuation, collapse whitespace. */
export function normalize_name(value: string): string {
	// Only combining diacritics (U+0300–U+036F) are dropped, so `Beyonce` matches `Beyoncé` without touching other scripts.
	let s = value.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').normalize('NFC').toLowerCase();
	s = s.replace(FEATURE_RE, ' ');
	for (let i = 0; i < 2; i++) s = s.replace(VERSION_PAREN_RE, ' ').replace(VERSION_DASH_RE, ' ');
	s = s.replace(/&/gu, ' and ');
	s = s.replace(/[\p{P}\p{S}]+/gu, ' ');
	return s.replace(/\s+/gu, ' ').trim();
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let curr = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/** Similarity in [0, 1] of two **already normalized** strings (1 - normalized edit distance). */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const a_chars = Array.from(a);
	const b_chars = Array.from(b);
	const max = Math.max(a_chars.length, b_chars.length);
	if (max === 0) return 1;
	return 1 - levenshtein(a_chars, b_chars) / max;
}

/** Normalizes both sides and compares them. */
export function name_similarity(a: string, b: string): number {
	return similarity(normalize_name(a), normalize_name(b));
}

export function names_match(a: string, b: string, threshold = DEFAULT_SIMILARITY_THRESHOLD): boolean {
	return name_similarity(a, b) >= threshold;
}

export function durations_match(a_ms: number | null | undefined, b_ms: number | null | undefined, tolerance_ms = DURATION_TOLERANCE_MS): boolean {
	if (a_ms == null || b_ms == null) return false;
	return Math.abs(a_ms - b_ms) <= tolerance_ms;
}

/** Primary (first-listed) artist from a display string like `A, B & C feat. D`. */
export function primary_artist_name(artist: string): string {
	return artist.split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/iu)[0].trim() || artist.trim();
}
