import { name_similarity, normalize_name, primary_artist_name } from '../../core/normalize';
import { UNIQUE_SERVICE_ID_COLUMNS } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';
import type { Thresholds } from './thresholds';
import type { Claim, Facet, FacetDisagreement, PairEvidence, ReconcileNode, Signal } from './types';

type MetaField = 'title' | 'artist' | 'album' | 'duration_ms' | 'explicit' | 'track_number' | 'release_year';

/** The entity's own value, else the first service that has one. */
export function pick<K extends MetaField>(node: ReconcileNode, field: K): Facet[K] | null {
	const own = node.meta[field];
	if (own != null) return own;
	for (const f of node.facets) if (f[field] != null) return f[field];
	return null;
}

export function cosine_distance(a: readonly number[], b: readonly number[]): number | null {
	if (a.length !== b.length || a.length === 0) return null;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return null;
	return 1 - dot / Math.sqrt(na * nb);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const is_named = (s: string) => s !== 'stored';

/**
 * Weighs every "same entity" signal between two nodes and determines which
 * hard-evidence rule, if any, applies. Where an id came from (client or server) never changes its weight.
 */
export function pair_evidence(a: ReconcileNode, b: ReconcileNode, a_claims: readonly Claim[], b_claims: readonly Claim[], t: Thresholds): PairEvidence {
	const w = t.weights;
	const signals: Signal[] = [];
	const contradictions: PairEvidence['contradictions'] = [];
	const strong = (name: string, detail?: unknown) => contradictions.push({ name, weight: w.strong_contradiction, detail, strong: true });
	const weak = (name: string, detail?: unknown) => contradictions.push({ name, weight: w.weak_contradiction, detail, strong: false });

	let cross_service = false;
	let shared_unique = false;
	for (const column of UNIQUE_SERVICE_ID_COLUMNS) {
		const av = a_claims.filter(c => c.column === column);
		const bv = b_claims.filter(c => c.column === column);
		const shared = [...new Set(av.map(c => c.value))].filter(v => bv.some(c => c.value === v));
		for (const value of shared) {
			const a_sources = new Set(av.filter(c => c.value === value).map(c => c.source));
			const b_sources = new Set(bv.filter(c => c.value === value).map(c => c.source));
			const independent = [...a_sources].some(sa => is_named(sa) && [...b_sources].some(sb => is_named(sb) && sb !== sa));
			if (independent) {
				cross_service = true;
				signals.push({ name: 'cross_service_id', weight: w.cross_service_id, detail: { column, value, a_sources: [...a_sources], b_sources: [...b_sources] } });
			} else {
				shared_unique = true;
				signals.push({ name: 'shared_unique_id', weight: w.shared_unique_id, detail: { column, value } });
			}
		}
		const a_own = a.ids[column];
		const b_own = b.ids[column];
		// An artist's YouTube id is one of their channels; two of them don't make two artists.
		const identifies = a.kind !== 'artist' || column !== 'youtube_id';
		if (identifies && a_own != null && b_own != null && a_own !== b_own) strong('different_id', { column, a: a_own, b: b_own });
	}

	const a_isrc = new Set(a_claims.filter(c => c.column === 'isrc').map(c => c.value));
	const b_isrc = new Set(b_claims.filter(c => c.column === 'isrc').map(c => c.value));
	const same_isrc = [...a_isrc].some(v => b_isrc.has(v));
	if (same_isrc) signals.push({ name: 'same_isrc', weight: w.same_isrc, detail: [...a_isrc].filter(v => b_isrc.has(v)) });
	else if (a_isrc.size > 0 && b_isrc.size > 0) strong('isrc_differs', { a: [...a_isrc], b: [...b_isrc] });

	const at = pick(a, 'title');
	const bt = pick(b, 'title');
	if (at && bt) {
		const s = name_similarity(at, bt);
		if (s >= t.name_match) signals.push({ name: 'title', weight: w.title, detail: s });
		else if (s < t.name_contradiction) strong('title_differs', { a: at, b: bt, similarity: s });
	}
	const aa = pick(a, 'artist');
	const ba = pick(b, 'artist');
	if (aa && ba) {
		const s = name_similarity(primary_artist_name(aa), primary_artist_name(ba));
		if (s >= t.name_match) signals.push({ name: 'artist', weight: w.artist, detail: s });
		else if (s < t.name_contradiction) weak('artist_differs', { a: aa, b: ba, similarity: s });
	}
	const al = pick(a, 'album');
	const bl = pick(b, 'album');
	if (al && bl && name_similarity(al, bl) >= t.name_match) signals.push({ name: 'album', weight: w.album });
	const an = pick(a, 'track_number');
	const bn = pick(b, 'track_number');
	if (an != null && an === bn) signals.push({ name: 'track_number', weight: w.track_number });

	const ad = pick(a, 'duration_ms');
	const bd = pick(b, 'duration_ms');
	const durations_close = ad != null && bd != null && Math.abs(ad - bd) <= t.duration_tolerance_ms;
	if (ad != null && bd != null) {
		const gap = Math.abs(ad - bd);
		if (durations_close) signals.push({ name: 'duration', weight: w.duration, detail: gap });
		else if (gap > t.split_duration_gap_ms) strong('duration_gap', gap);
	}
	const ae = pick(a, 'explicit');
	const be = pick(b, 'explicit');
	if (ae != null && be != null) {
		if (ae === be) signals.push({ name: 'explicit', weight: w.explicit });
		else weak('explicit_differs');
	}
	const ay = pick(a, 'release_year');
	const by = pick(b, 'release_year');
	if (ay != null && by != null) {
		if (ay === by) signals.push({ name: 'release_year', weight: w.release_year });
		else if (Math.abs(ay - by) > 1) weak('release_year_differs', { a: ay, b: by });
	}

	// The same release twice (or the standard edition and its deluxe): at least half of the shorter track list is on the other.
	const atr = a.meta.tracks;
	const btr = b.meta.tracks;
	let tracks_agree = false;
	if (atr?.length && btr?.length) {
		const other = new Set(btr);
		const shared = new Set(atr.filter(x => other.has(x))).size;
		tracks_agree = shared * 2 >= Math.min(new Set(atr).size, other.size);
		if (tracks_agree) signals.push({ name: 'album_tracks', weight: w.album_tracks, detail: shared });
	}

	if (a.vector && b.vector) {
		const d = cosine_distance(a.vector, b.vector);
		if (d != null) {
			if (d <= t.audio_match_distance) signals.push({ name: 'audio', weight: w.audio, detail: d });
			else if (d >= t.audio_contradiction_distance) strong('audio_differs', d);
		}
	}

	const any_strong = contradictions.some(c => c.strong);
	let hard: PairEvidence['hard'] = null;
	if (!any_strong) {
		if (cross_service) hard = 'cross_service_id';
		else if (same_isrc && durations_close) hard = 'isrc_duration';
		else if (shared_unique && contradictions.length === 0) hard = 'shared_unique_id';
		// Same name and artist with agreeing tracks; a different release year (a reissue?) is left for review.
		else if (a.kind === 'album' && tracks_agree && contradictions.length === 0 && (ay == null || by == null || ay === by)
			&& signals.some(s => s.name === 'title') && signals.some(s => s.name === 'artist')) hard = 'album_tracks';
		// Two artists with the same name and no service on which their ids differ: the way contributions match
		// artists, so duplicates made before that rule (or by a race) are merged.
		else if (a.kind === 'artist' && b.kind === 'artist' && contradictions.length === 0 && at && bt
			&& normalize_name(at) !== '' && normalize_name(at) === normalize_name(bt)) hard = 'same_artist_name';
	}
	const score = signals.reduce((s, x) => s + x.weight, 0) - contradictions.reduce((s, x) => s + x.weight, 0);
	return { a: a.illusi_id, b: b.illusi_id, signals, contradictions, confidence: clamp01(score), hard };
}

/** Two sources describe the same recording: titles match and durations within tolerance (at least one of them comparable). */
export function facets_agree(x: Facet, y: Facet, t: Thresholds): boolean {
	if (x.duration_ms != null && y.duration_ms != null && Math.abs(x.duration_ms - y.duration_ms) > t.duration_tolerance_ms) return false;
	if (x.title && y.title && name_similarity(x.title, y.title) < t.name_match) return false;
	return (x.duration_ms != null && y.duration_ms != null) || (!!x.title && !!y.title);
}

function disagreement_reasons(anchor: Facet, anchor_isrc: string | null, f: Facet, t: Thresholds): { reasons: string[]; hard: boolean } {
	const reasons: string[] = [];
	let gap = false;
	if (anchor.duration_ms != null && f.duration_ms != null && Math.abs(anchor.duration_ms - f.duration_ms) > t.split_duration_gap_ms) {
		reasons.push('duration_gap');
		gap = true;
	}
	const title_differs = !!anchor.title && !!f.title && name_similarity(anchor.title, f.title) < t.name_contradiction;
	if (title_differs) reasons.push('title_differs');
	const isrc_differs = anchor_isrc != null && f.isrc != null && anchor_isrc !== f.isrc;
	if (isrc_differs) reasons.push('isrc_differs');
	return { reasons, hard: gap || (isrc_differs && title_differs) };
}

/**
 * Split detection: service rows attached to one track whose metadata disagrees with the
 * local entity. Hard only for a duration gap above the threshold or different ISRCs plus different
 * titles, and only while at least one source still agrees with the entity (or the facet is alone);
 * if every service agrees among themselves against the entity, the entity is the odd one out → review.
 */
export function facet_disagreements(node: ReconcileNode, t: Thresholds): FacetDisagreement[] {
	if (node.kind !== 'track' || node.facets.length === 0) return [];
	const anchor = node.meta;
	if (!anchor.title && anchor.duration_ms == null) return [];

	const found: { facet: Facet; reasons: string[]; hard: boolean }[] = [];
	for (const facet of node.facets) {
		const own_isrc = facet.isrc != null && node.ids.isrc === facet.isrc ? null : node.ids.isrc ?? null;
		const r = disagreement_reasons(anchor, own_isrc, facet, t);
		if (r.reasons.length > 0) found.push({ facet, ...r });
	}
	if (found.length === 0) return [];

	const agreeing = node.facets.filter(f => !found.some(d => d.facet === f));
	const dissenters_agree = found.length >= 2 && found.every(d => found.every(e => d === e || facets_agree(d.facet, e.facet, t)));
	const entity_outvoted = agreeing.length === 0 && dissenters_agree;

	return found.map(d => ({
		illusi_id: node.illusi_id,
		facet_source: d.facet.source,
		facet: d.facet,
		columns: facet_columns(node, d.facet, agreeing),
		reasons: entity_outvoted ? [...d.reasons, 'entity_outvoted'] : d.reasons,
		hard: d.hard && !entity_outvoted
	}));
}

/**
 * The columns that travel with a misattributed service row: the ones it is attached through, plus
 * stored ids only it vouches for (ids it reports, its ISRC) that no agreeing source confirms.
 */
export function facet_columns(node: ReconcileNode, facet: Facet, agreeing: readonly Facet[]): ServiceIdColumn[] {
	const columns = new Set<ServiceIdColumn>(facet.columns.filter(c => node.ids[c] != null));
	const vouched_by_other = (column: ServiceIdColumn, value: string) => agreeing.some(f => f.columns.includes(column) || f.reported?.[column] === value || (column === 'isrc' && f.isrc === value));
	for (const [column, value] of Object.entries(facet.reported ?? {}) as [ServiceIdColumn, string][]) {
		if (node.ids[column] === value && !vouched_by_other(column, value)) columns.add(column);
	}
	if (facet.isrc && node.ids.isrc === facet.isrc && !vouched_by_other('isrc', facet.isrc)) columns.add('isrc');
	return [...columns].sort();
}
