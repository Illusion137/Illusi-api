/** Shared-data write rules: empty fields are filled (first write wins), differing values are flagged, never applied. */
import { DURATION_TOLERANCE_MS, normalize_name } from '../../core/normalize';

/** How two values of a field are compared. `name` ignores case/punctuation, `duration` allows the ±3 s tolerance. */
export type FieldKind = 'name' | 'text' | 'number' | 'duration' | 'date' | 'bool' | 'enum' | 'id';
export type FieldSpec<T> = { [K in keyof T]?: FieldKind };

export interface FieldConflict { field: string; current: unknown; proposed: unknown }

const as_time = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(v as string).getTime());

export function values_equal(kind: FieldKind, a: unknown, b: unknown): boolean {
	switch (kind) {
		case 'name': return normalize_name(String(a)) === normalize_name(String(b));
		case 'text': return String(a).trim() === String(b).trim();
		case 'duration': return Math.abs(Number(a) - Number(b)) <= DURATION_TOLERANCE_MS;
		case 'date': return as_time(a) === as_time(b);
		case 'number':
		case 'bool':
		case 'enum':
		case 'id':
			return a === b;
	}
}

/**
 * Compares an incoming entity against the stored row. Missing incoming values never null anything out.
 * `existing = null` (a new row) fills everything provided.
 */
export function resolve_shared_fields<T extends Record<string, unknown>>(spec: FieldSpec<T>, existing: Partial<T> | null, incoming: Partial<T>): { fill: Partial<T>; conflicts: FieldConflict[] } {
	const fill: Partial<T> = {};
	const conflicts: FieldConflict[] = [];
	for (const field of Object.keys(spec) as (keyof T & string)[]) {
		const kind = spec[field]!;
		const proposed = incoming[field];
		if (proposed == null) continue;
		const current = existing?.[field];
		if (current == null) {
			fill[field] = proposed;
			continue;
		}
		if (!values_equal(kind, current, proposed)) conflicts.push({ field, current, proposed });
	}
	return { fill, conflicts };
}

const ARTIST_SEPARATOR_RE = /\s*(?:,|\band\b|\bx\b|\bvs\b)\s*/u;

/**
 * `Artist - Title`, the way video titles name songs, becomes `Title` when everything before the dash is the track's
 * artists (`A & B - Title` too). Anything else is left as it is.
 */
export function strip_artist_prefix(title: string, artists: readonly string[]): string {
	const m = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/u.exec(title);
	if (!m || artists.length === 0) return title;
	const known = new Set(artists.map(normalize_name));
	const prefix = normalize_name(m[1]);
	const named = prefix.split(ARTIST_SEPARATOR_RE).filter(Boolean);
	return known.has(prefix) || (named.length > 0 && named.every(n => known.has(n))) ? m[2].trim() : title;
}

/** Services whose catalogs mark clean and explicit versions apart, so a `false` from them is a claim, not a default. */
const EXPLICIT_REPORTING_SOURCES: ReadonlySet<string> = new Set(['Apple Music', 'Deezer', 'Tidal', 'Audiomack']);

/**
 * What a track contribution's `explicit` does, by where the track came from:
 * - YouTube video: nothing. A video says nothing about the song; it is explicit when another source says so.
 * - YouTube Music: its value wins either way.
 * - Anything else: explicit wins over clean. A clean claim against a stored explicit is ignored, unless the source
 *   marks clean versions (then it may be the clean recording, which a reviewer splits off).
 */
export function explicit_rule(source: string | null | undefined, proposed: boolean): 'ignore' | 'apply' | 'review' {
	if (source === 'YouTube') return 'ignore';
	if (proposed || source === 'YouTube Music') return 'apply';
	return source != null && EXPLICIT_REPORTING_SOURCES.has(source) ? 'review' : 'ignore';
}
