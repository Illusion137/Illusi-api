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

/** Lowercase, NFKC, strip Latin accents, invisible characters, `feat.` parts, version suffixes and punctuation, collapse whitespace. */
export function normalize_name(value: string): string {
	// Only combining diacritics (U+0300–U+036F) are dropped, so `Beyonce` matches `Beyoncé` without touching other scripts.
	// Format characters (left-to-right marks, zero-width spaces) are invisible: `cade\u200e` is `cade`.
	let s = value.replace(/\p{Cf}/gu, '').normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').normalize('NFC').toLowerCase();
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

/** Bracketed parts that describe the upload rather than the work: `(Official Video)`, `[prod. X]`, `(Full Audio)`. */
const DECORATION_RE = /\s*[([](?:[^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|4k|hd|hq|mv|m\/v|unreleased|leak(?:ed)?|snippet|prod|produced)\b|\s*p\.\s)[^)\]]*[)\]]/giu;

/** `title` without its decorations (see DECORATION_RE), and how many were removed. */
export function strip_decorations(title: string): { text: string; removed: number } {
	let removed = 0;
	const text = title.replace(DECORATION_RE, () => {
		removed++;
		return '';
	}).trim();
	return text ? { text, removed } : { text: title, removed: 0 };
}

const ROMAN: Readonly<Record<string, string>> = {
	ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15', xvi: '16', xvii: '17', xviii: '18', xix: '19', xx: '20'
};

/** The numbers a normalized name carries (`2`, `02` and `II` alike), sorted: sequels, volumes, parts and years. */
function numbers_of(normalized: string): string {
	const out: string[] = [];
	for (const word of normalized.split(' ')) {
		if (/^\d+$/u.test(word)) out.push(String(Number(word)));
		else if (ROMAN[word]) out.push(ROMAN[word]);
	}
	return out.sort().join(' ');
}

/**
 * Two words that are different words rather than one misspelt: what is left of them after their common start and
 * end is 3 or more characters ("Otori|monogatari" / "Nise|monogatari", "Koi" / "Bake"). A typo leaves 1 or 2.
 */
function different_words(a: string, b: string): boolean {
	const x = Array.from(a);
	const y = Array.from(b);
	let start = 0;
	while (start < x.length && start < y.length && x[start] === y[start]) start++;
	let end = 0;
	while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
	return Math.max(x.length - start - end, y.length - start - end) >= 3;
}

/**
 * Names that are close as strings but name different works: their numbers differ ("Lil Boat 2" / "Lil Boat 3",
 * "Hits 2024" / "Hits 2025", "Vol. 1" / "Vol. 2", "Album" / "Album 2"), or, with as many words, one word is
 * replaced by another ("Nisemonogatari" / "Bakemonogatari"). Decorations like `(Official Video)` are ignored.
 */
export function names_differ(a: string, b: string): boolean {
	const na = normalize_name(strip_decorations(a).text);
	const nb = normalize_name(strip_decorations(b).text);
	if (na === nb) return false;
	if (numbers_of(na) !== numbers_of(nb)) return true;
	const wa = na.split(' ');
	const wb = nb.split(' ');
	return wa.length === wb.length && wa.some((w, i) => w !== wb[i] && different_words(w, wb[i]));
}

export function names_match(a: string, b: string, threshold = DEFAULT_SIMILARITY_THRESHOLD): boolean {
	if (names_differ(a, b)) return false;
	return name_similarity(a, b) >= threshold || name_similarity(strip_decorations(a).text, strip_decorations(b).text) >= threshold;
}

export function durations_match(a_ms: number | null | undefined, b_ms: number | null | undefined, tolerance_ms = DURATION_TOLERANCE_MS): boolean {
	if (a_ms == null || b_ms == null) return false;
	return Math.abs(a_ms - b_ms) <= tolerance_ms;
}

/** Primary (first-listed) artist from a display string like `A, B & C feat. D`. */
export function primary_artist_name(artist: string): string {
	return artist.split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/iu)[0].trim() || artist.trim();
}
