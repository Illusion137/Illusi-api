import { describe, expect, it } from 'vitest';
import { cosine_distance, facet_columns, facet_disagreements, pair_evidence } from './evidence';
import { claims_of } from './group';
import { node } from './test_fixtures';
import { DEFAULT_THRESHOLDS as T } from './thresholds';
import type { ConflictInfo, ReconcileNode } from './types';

function evidence(a: ReconcileNode, b: ReconcileNode, conflicts: ConflictInfo[] = []) {
	return pair_evidence(a, b, claims_of(a, conflicts), claims_of(b, conflicts), T);
}

describe('pair_evidence', () => {
	it('Genius appleMusicId equal to the other row\'s iTunes trackId is cross-service hard evidence', () => {
		const a = node('A', { ids: { applemusic_id: '10' }, facets: [{ source: 'itunes', columns: ['applemusic_id'] }] });
		const b = node('B', { ids: { genius_id: '7' }, facets: [{ source: 'genius', columns: ['genius_id'], reported: { applemusic_id: '10' } }] });
		const e = evidence(a, b);
		expect(e.hard).toBe('cross_service_id');
		expect(e.signals.map(s => s.name)).toContain('cross_service_id');
		expect(e.confidence).toBeGreaterThan(0.8);
	});

	it('client-submitted ids count as an independent source like server ones', () => {
		const a = node('A', { ids: { applemusic_id: '10' }, facets: [{ source: 'itunes', columns: ['applemusic_id'] }] });
		const b = node('B');
		const c: ConflictInfo = { id: 1, illusi_id: 'B', column: 'applemusic_id', existing_value: null, incoming_value: '10', other_illusi_id: 'A', source: 'contribute', status: 'open' };
		expect(evidence(a, b, [c]).hard).toBe('cross_service_id');
	});

	it('the same value from the same source is "shared unique id": hard only without any contradiction', () => {
		const a = node('A', { ids: { applemusic_id: '10' }, facets: [{ source: 'itunes', columns: ['applemusic_id'] }] });
		const b = node('B');
		const c: ConflictInfo = { id: 1, illusi_id: 'B', column: 'applemusic_id', existing_value: null, incoming_value: '10', other_illusi_id: 'A', source: 'itunes', status: 'open' };
		expect(evidence(a, b, [c]).hard).toBe('shared_unique_id');
		const b_explicit = node('B', { meta: { explicit: true } });
		const a_clean = { ...a, meta: { ...a.meta, explicit: false } };
		const e = evidence(a_clean, b_explicit, [c]);
		expect(e.contradictions.map(x => x.name)).toEqual(['explicit_differs']);
		expect(e.hard).toBeNull();
	});

	it('same ISRC plus duration within ±3 s is hard; outside the tolerance it is not', () => {
		const a = node('A', { ids: { isrc: 'USABC1234567' }, meta: { duration_ms: 200_000 } });
		expect(evidence(a, node('B', { ids: { isrc: 'USABC1234567' }, meta: { duration_ms: 202_500 } })).hard).toBe('isrc_duration');
		expect(evidence(a, node('B', { ids: { isrc: 'USABC1234567' }, meta: { duration_ms: 206_000 } })).hard).toBeNull();
	});

	it('a strong contradiction blocks every hard rule', () => {
		const a = node('A', { ids: { isrc: 'USABC1234567' }, meta: { title: 'Yesterday', duration_ms: 200_000 } });
		const b = node('B', { ids: { isrc: 'USABC1234567' }, meta: { title: 'Bohemian Rhapsody', duration_ms: 200_000 } });
		const e = evidence(a, b);
		expect(e.contradictions.find(c => c.name === 'title_differs')?.strong).toBe(true);
		expect(e.hard).toBeNull();
	});

	it('flags different values in the same unique column and different ISRCs', () => {
		const a = node('A', { ids: { applemusic_id: '1', isrc: 'USABC1234567' } });
		const b = node('B', { ids: { applemusic_id: '2', isrc: 'USABC7654321' } });
		const names = evidence(a, b).contradictions.map(c => c.name);
		expect(names).toEqual(expect.arrayContaining(['different_id', 'isrc_differs']));
	});

	it('scores metadata-only similarity below hard evidence', () => {
		const a = node('A', { meta: { title: 'Song', artist: 'Artist', album: 'LP', duration_ms: 200_000, track_number: 3 } });
		const b = node('B', { meta: { title: 'Song', artist: 'Artist', album: 'LP', duration_ms: 201_000, track_number: 3 } });
		const e = evidence(a, b);
		expect(e.hard).toBeNull();
		expect(e.confidence).toBeCloseTo(T.weights.title + T.weights.artist + T.weights.album + T.weights.duration + T.weights.track_number, 5);
	});

	it('uses audio distance when both tracks have vectors', () => {
		const close = evidence(node('A', { vector: [1, 0, 0] }), node('B', { vector: [1, 0.01, 0] }));
		expect(close.signals.map(s => s.name)).toContain('audio');
		const far = evidence(node('A', { vector: [1, 0, 0] }), node('B', { vector: [0, 1, 0] }));
		expect(far.contradictions.map(s => s.name)).toContain('audio_differs');
	});

	it('falls back to service metadata when the entity lacks a field', () => {
		const a = node('A', { meta: { duration_ms: null }, facets: [{ source: 'itunes', columns: ['applemusic_id'], duration_ms: 100_000 }] });
		const b = node('B', { meta: { duration_ms: 150_000 } });
		expect(evidence(a, b).contradictions.map(c => c.name)).toContain('duration_gap');
	});
});

describe('cosine_distance', () => {
	it('is 0 for parallel and 1 for orthogonal vectors, null for mismatched', () => {
		expect(cosine_distance([1, 2], [2, 4])).toBeCloseTo(0);
		expect(cosine_distance([1, 0], [0, 1])).toBeCloseTo(1);
		expect(cosine_distance([1], [1, 2])).toBeNull();
		expect(cosine_distance([0, 0], [1, 1])).toBeNull();
	});
});

describe('facet_disagreements', () => {
	const itunes = { source: 'itunes' as const, columns: ['applemusic_id' as const], title: 'Song', duration_ms: 200_000 };

	it('a duration gap above 10 s is hard evidence for a split', () => {
		const n = node('A', { ids: { applemusic_id: '1', soundcloud_id: '2' }, facets: [itunes, { source: 'soundcloud', columns: ['soundcloud_id'], title: 'Song', duration_ms: 260_000 }] });
		const d = facet_disagreements(n, T);
		expect(d).toHaveLength(1);
		expect(d[0]).toMatchObject({ facet_source: 'soundcloud', columns: ['soundcloud_id'], hard: true, reasons: ['duration_gap'] });
	});

	it('different ISRC plus different title is hard; either alone is not', () => {
		const base = node('A', { ids: { isrc: 'USABC1234567', soundcloud_id: '2' }, facets: [itunes] });
		const both = facet_disagreements({ ...base, facets: [itunes, { source: 'soundcloud', columns: ['soundcloud_id'], title: 'Completely Else', isrc: 'GBXYZ7654321' }] }, T);
		expect(both[0].hard).toBe(true);
		const title_only = facet_disagreements({ ...base, facets: [itunes, { source: 'soundcloud', columns: ['soundcloud_id'], title: 'Completely Else' }] }, T);
		expect(title_only[0]).toMatchObject({ hard: false, reasons: ['title_differs'] });
	});

	it('is not hard when every service agrees against the entity (the entity is the odd one out)', () => {
		const n = node('A', {
			ids: { applemusic_id: '1', soundcloud_id: '2' },
			meta: { duration_ms: 100_000 },
			facets: [{ ...itunes }, { source: 'soundcloud', columns: ['soundcloud_id'], title: 'Song', duration_ms: 200_500 }]
		});
		const d = facet_disagreements(n, T);
		expect(d).toHaveLength(2);
		expect(d.every(x => !x.hard && x.reasons.includes('entity_outvoted'))).toBe(true);
	});

	it('ignores non-tracks and agreeing facets', () => {
		expect(facet_disagreements(node('A', { kind: 'album', facets: [{ ...itunes, duration_ms: 1 }] }), T)).toEqual([]);
		expect(facet_disagreements(node('A', { ids: { applemusic_id: '1' }, facets: [itunes] }), T)).toEqual([]);
	});
});

describe('facet_columns', () => {
	it('takes the attach columns plus ids only that service vouches for', () => {
		const genius = { source: 'genius' as const, columns: ['genius_id' as const], reported: { spotify_id: 'S'.repeat(22), youtube_id: 'abcdefghijk' } };
		const yt_confirmer = { source: 'itunes' as const, columns: ['applemusic_id' as const], reported: { youtube_id: 'abcdefghijk' } };
		const n = node('A', { ids: { genius_id: '9', spotify_id: 'S'.repeat(22), youtube_id: 'abcdefghijk', applemusic_id: '1' } });
		expect(facet_columns(n, genius, [yt_confirmer])).toEqual(['genius_id', 'spotify_id']);
	});
});

describe('pair_evidence release years', () => {
	it('flags release years more than a year apart as weak contradicting evidence', () => {
		const a = node('A', { meta: { release_year: 2000 } });
		const b = node('B', { meta: { release_year: 2005 } });
		expect(JSON.stringify(evidence(a, b))).toContain('release_year_differs');
		expect(JSON.stringify(evidence(a, node('C', { meta: { release_year: 2001 } })))).not.toContain('release_year_differs');
	});

	it('merges duplicate albums whose track lists agree, unless their release years differ', () => {
		const album = (id: string, tracks: string[], release_year: number | null = 2020) =>
			node(id, { kind: 'album', meta: { title: 'Record', artist: 'Artist', duration_ms: null, release_year, tracks } });
		const standard = album('A', ['one', 'two', 'three']);
		expect(evidence(standard, album('B', ['one', 'two', 'three'])).hard).toBe('album_tracks');
		expect(evidence(standard, album('C', ['one', 'two', 'three', 'bonus', 'demo'])).hard).toBe('album_tracks');
		expect(evidence(standard, album('D', ['one', 'two', 'three'], null)).hard).toBe('album_tracks');
		expect(evidence(standard, album('E', ['one', 'other', 'else'])).hard).toBeNull();
		expect(evidence(standard, album('F', [])).hard).toBeNull();
		expect(evidence(standard, album('G', ['one', 'two', 'three'], 2021)).hard).toBeNull();
		expect(evidence(album('H', ['one', 'two'], 2020), node('I', { kind: 'album', meta: { title: 'Other Record', artist: 'Artist', duration_ms: null, tracks: ['one', 'two'] } })).hard).toBeNull();
	});
});

describe('pair_evidence artists', () => {
	it('flags clearly different primary artists as weak contradicting evidence', () => {
		const e = evidence(node('A', { meta: { artist: 'Completely Unrelated Band' } }), node('B', { meta: { artist: 'Zzyzx Quartet' } }));
		expect(JSON.stringify(e)).toContain('artist_differs');
	});
});
