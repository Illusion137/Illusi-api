import { describe, expect, it } from 'vitest';
import { build_groups } from './group';
import { decide_pair, is_clear_cut, plan_signature, resolve_group, review_steps } from './resolve';
import { compare_survivors, choose_survivor } from './survivor';
import { conflict, node } from './test_fixtures';
import { DEFAULT_THRESHOLDS as T } from './thresholds';
import type { Facet, MergeStep, PairEvidence } from './types';

const itunes = (over: Partial<Facet> = {}): Facet => ({ source: 'itunes', columns: ['applemusic_id'], title: 'Song', duration_ms: 200_000, ...over });

describe('decide_pair', () => {
	const e = (over: Partial<PairEvidence>): PairEvidence => ({ a: 'a', b: 'b', signals: [], contradictions: [], confidence: 0, hard: null, ...over });
	it('merges only on hard evidence, reviews confident cases, dismisses the rest', () => {
		expect(decide_pair(e({ hard: 'isrc_duration', confidence: 0.1 }), T)).toBe('merge');
		expect(decide_pair(e({ confidence: 0.6 }), T)).toBe('review');
		expect(decide_pair(e({ confidence: T.review_min_confidence }), T)).toBe('review');
		expect(decide_pair(e({ confidence: 0.49 }), T)).toBe('dismiss');
	});
	it('honours configured thresholds', () => {
		expect(decide_pair(e({ confidence: 0.3 }), { ...T, review_min_confidence: 0.25 })).toBe('review');
	});
});

describe('choose_survivor', () => {
	it('prefers an entity row, then user data, then filled columns, then the older one', () => {
		const base = node('b', { user_data: 1, filled: 5, created_at: 50 });
		expect(choose_survivor([node('a', { has_entity: false, user_data: 9 }), base]).illusi_id).toBe('b');
		expect(choose_survivor([node('a', { user_data: 2, filled: 1 }), base]).illusi_id).toBe('a');
		expect(choose_survivor([node('a', { user_data: 1, filled: 6, created_at: 99 }), base]).illusi_id).toBe('a');
		expect(choose_survivor([node('a', { user_data: 1, filled: 5, created_at: 10 }), base]).illusi_id).toBe('a');
		expect(choose_survivor([node('c', { user_data: 1, filled: 5, created_at: 50 }), base]).illusi_id).toBe('b');
		expect(compare_survivors(base, base)).toBe(0);
		expect(() => choose_survivor([])).toThrow();
	});
});

describe('resolve_group', () => {
	it('A–B on Apple Music and B–C on SoundCloud: both hard → one survivor absorbs the others', () => {
		const A = node('A', { ids: { genius_id: '7' }, facets: [{ source: 'genius', columns: ['genius_id'], reported: { applemusic_id: '10' } }] });
		const B = node('B', { ids: { applemusic_id: '10', soundcloud_id: '20' }, user_data: 5, facets: [itunes(), { source: 'soundcloud', columns: ['soundcloud_id'], title: 'Song', duration_ms: 200_500 }] });
		const C = node('C', { ids: { spotify_id: 'S'.repeat(22) } });
		const conflicts = [
			conflict('A', 'applemusic_id', '10', { other_illusi_id: 'B', source: 'genius' }),
			conflict('C', 'soundcloud_id', '20', { other_illusi_id: 'B', source: 'contribute' })
		];
		const [group] = build_groups([A, B, C], conflicts, T);
		const plan = resolve_group(group, T);
		const merges = plan.steps.filter((s): s is MergeStep => s.type === 'merge');
		expect(merges.map(m => [m.survivor, m.loser, m.auto])).toEqual([['B', 'A', true], ['B', 'C', true]]);
		expect(merges[0].reasons).toEqual(['cross_service_id']);
		expect(plan.conflicts.map(c => c.status)).toEqual(['merged', 'merged']);
		expect(review_steps(plan)).toEqual([]);
	});

	it('does not auto-merge a cluster whose members contradict each other; proposes reviews instead', () => {
		// A=B (shared ISRC+duration), B=C (shared ISRC+duration) but A and C hold different Apple Music ids.
		const A = node('A', { ids: { isrc: 'USABC1234567', applemusic_id: '1' }, meta: { duration_ms: 200_000 } });
		const B = node('B', { ids: { isrc: 'USABC1234567' }, meta: { duration_ms: 201_000 } });
		const C = node('C', { ids: { isrc: 'USABC1234567', applemusic_id: '2' }, meta: { duration_ms: 202_000 } });
		const plan = resolve_group({ nodes: [A, B, C], conflicts: [] }, T);
		expect(plan.steps.every(s => !s.auto)).toBe(true);
		const proposals = plan.steps as MergeStep[];
		expect(proposals.length).toBeGreaterThan(0);
		expect(proposals.some(p => p.reasons.includes('blocked_by_contradiction'))).toBe(true);
	});

	it('defers metadata-only matches with the plan; the conflict becomes deferred', () => {
		const A = node('A', { meta: { album: 'LP', track_number: 2 } });
		const B = node('B', { meta: { album: 'LP', track_number: 2, duration_ms: 201_000 } });
		const c = conflict('A', 'applemusic_id', '99', { other_illusi_id: 'B', source: 'itunes', existing_value: '98' });
		const plan = resolve_group({ nodes: [A, B], conflicts: [c] }, { ...T, review_min_confidence: 0.4 });
		expect(plan.steps).toHaveLength(1);
		expect(plan.steps[0]).toMatchObject({ type: 'merge', auto: false });
		expect(plan.conflicts[0].status).toBe('deferred');
	});

	it('dismisses low-confidence and contradicting conflicts (keeps the existing link)', () => {
		const A = node('A', { ids: { applemusic_id: '1' }, meta: { title: 'Yesterday', duration_ms: 125_000 } });
		const B = node('B', { ids: { applemusic_id: '2' }, meta: { title: 'Bohemian Rhapsody', duration_ms: 354_000 } });
		const c = conflict('A', 'applemusic_id', '2', { other_illusi_id: 'B', existing_value: '1' });
		const plan = resolve_group({ nodes: [A, B], conflicts: [c] }, T);
		expect(plan.steps).toEqual([]);
		expect(plan.conflicts[0].status).toBe('dismissed');
		expect(is_clear_cut(plan, T)).toBe(true);
	});

	it('splits a misattributed service id off into a new entity when the durations clearly disagree', () => {
		const A = node('A', {
			ids: { applemusic_id: '1', soundcloud_id: '2', soundcloud_permalink: 'u/t' },
			facets: [itunes(), { source: 'soundcloud', columns: ['soundcloud_id', 'soundcloud_permalink'], title: 'Other Song', duration_ms: 320_000, explicit: true, thumbnails: ['https://x/a.jpg'] }]
		});
		const c = conflict('A', 'soundcloud_id', '3', { existing_value: '2', source: 'soundcloud' });
		const plan = resolve_group({ nodes: [A], conflicts: [c] }, T);
		expect(plan.steps).toEqual([expect.objectContaining({
			type: 'split', from: 'A', auto: true, values: { soundcloud_id: '2', soundcloud_permalink: 'u/t' }, thumbnails: ['https://x/a.jpg'],
			new_entity: { kind: 'track', title: 'Other Song', duration_ms: 320_000, explicit: true }
		})]);
		expect(plan.conflicts[0].status).toBe('split');
		expect(is_clear_cut(plan, T)).toBe(false);
	});

	it('moves the id to another group member it matches instead of creating a new entity, then judges merges on the moved state', () => {
		const A = node('A', { ids: { applemusic_id: '1', soundcloud_id: '2' }, facets: [itunes(), { source: 'soundcloud', columns: ['soundcloud_id'], title: 'Other Song', duration_ms: 320_000 }] });
		const B = node('B', { meta: { title: 'Other Song', duration_ms: 321_000 } });
		const plan = resolve_group({ nodes: [A, B], conflicts: [] }, T);
		expect(plan.steps).toEqual([expect.objectContaining({ type: 'move', from: 'A', to: 'B', auto: true, values: { soundcloud_id: '2' } })]);
	});

	it('proposes (not applies) a split when only the title disagrees', () => {
		const A = node('A', { ids: { genius_id: '5' }, facets: [{ source: 'genius', columns: ['genius_id'], title: 'Totally Different' }] });
		const plan = resolve_group({ nodes: [A], conflicts: [] }, T);
		expect(plan.steps).toEqual([expect.objectContaining({ type: 'split', auto: false })]);
		expect(plan_signature(review_steps(plan))).toBe('split:A:genius_id');
	});

	it('skips groups above the configured size', () => {
		const nodes = Array.from({ length: 4 }, (_, i) => node(`n${i}`));
		const plan = resolve_group({ nodes, conflicts: [] }, { ...T, max_group_size: 3 });
		expect(plan.skipped).toBe('group_too_large:4');
		expect(plan.steps).toEqual([]);
	});

	it('is pure and deterministic regardless of input order', () => {
		const A = node('A', { ids: { isrc: 'USABC1234567' } });
		const B = node('B', { ids: { isrc: 'USABC1234567' }, created_at: 1 });
		const p1 = resolve_group({ nodes: [A, B], conflicts: [] }, T);
		const p2 = resolve_group({ nodes: [B, A], conflicts: [] }, T);
		expect(p1).toEqual(p2);
		expect(p1.steps[0]).toMatchObject({ type: 'merge', survivor: 'B', loser: 'A', auto: true, reasons: ['isrc_duration'] });
		expect(A.ids).toEqual({ isrc: 'USABC1234567' });
	});
});

describe('is_clear_cut / plan_signature', () => {
	it('accepts a single auto merge between two ids', () => {
		const A = node('A', { ids: { applemusic_id: '1' }, facets: [itunes()] });
		const B = node('B');
		const c = conflict('B', 'applemusic_id', '1', { other_illusi_id: 'A', source: 'genius' });
		const plan = resolve_group({ nodes: [A, B], conflicts: [c] }, T);
		expect(is_clear_cut(plan, T)).toBe(true);
		expect(plan.conflicts[0].status).toBe('merged');
	});

	it('rejects borderline dismissals and review cases', () => {
		const A = node('A', { meta: { album: 'LP' } });
		const B = node('B', { meta: { album: 'LP' } });
		const plan = resolve_group({ nodes: [A, B], conflicts: [conflict('A', 'deezer_id', 'x', { other_illusi_id: 'B' })] }, T);
		expect(is_clear_cut(plan, T)).toBe(false);
	});

	it('signature ignores step order', () => {
		const m: MergeStep = { type: 'merge', kind: 'track', survivor: 'a', loser: 'b', auto: false, reasons: [] };
		const n: MergeStep = { ...m, survivor: 'c', loser: 'd' };
		expect(plan_signature([m, n])).toBe(plan_signature([n, m]));
	});
});

describe('plan_signature moves and different-value conflicts', () => {
	it('names a move by its source, target and columns', () => {
		expect(plan_signature([{ type: 'move', from: 'A', to: 'B', auto: false, values: { genius_id: '1' } } as never])).toBe('move:A>B:genius_id');
	});
	it('finds the other node holding an incoming value when the conflict names none', () => {
		const A = node('A', { ids: { genius_id: 'G1' }, facets: [{ source: 'genius', columns: ['genius_id'] }] });
		const B = node('B');
		const plan = resolve_group({ nodes: [A, B], conflicts: [conflict('B', 'genius_id', 'G1')] }, T);
		expect(plan.conflicts).toHaveLength(1);
	});
});
