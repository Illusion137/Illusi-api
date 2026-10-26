import type { ServiceIdColumn } from '../../core/service_ids';
import { claims_of, UnionFind } from './group';
import { facet_disagreements, facets_agree, pair_evidence } from './evidence';
import { choose_survivor } from './survivor';
import type { Thresholds } from './thresholds';
import type {
	ConflictResolution, EntityKind, FacetDisagreement, GroupInput, GroupPlan, MergeStep, MoveStep, PairDecision,
	PairEvidence, PlanStep, ReconcileNode, SplitStep
} from './types';

/** Decisions: hard evidence → merge; enough confidence → admin review; otherwise dismissed. */
export function decide_pair(evidence: PairEvidence, t: Thresholds): PairDecision {
	if (evidence.hard) return 'merge';
	if (evidence.confidence >= t.review_min_confidence) return 'review';
	return 'dismiss';
}

function majority_kind(nodes: readonly ReconcileNode[]): EntityKind {
	const counts = new Map<EntityKind, number>();
	for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function pick_values(node: ReconcileNode, columns: readonly ServiceIdColumn[]) {
	const values: Partial<Record<ServiceIdColumn, string>> = {};
	for (const c of columns) if (node.ids[c] != null) values[c] = node.ids[c];
	return values;
}

function plan_splits(nodes: readonly ReconcileNode[], disagreements: readonly FacetDisagreement[], t: Thresholds): (SplitStep | MoveStep)[] {
	const steps: (SplitStep | MoveStep)[] = [];
	for (const d of disagreements) {
		const from = nodes.find(n => n.illusi_id === d.illusi_id)!;
		const values = pick_values(from, d.columns);
		const columns = Object.keys(values) as ServiceIdColumn[];
		if (columns.length === 0) continue;
		const thumbnails = d.facet.thumbnails ?? [];
		const reasons = d.reasons;
		const target = nodes.find(n => n !== from && n.kind === from.kind && n.has_entity
			&& columns.every(c => n.ids[c] == null || n.ids[c] === values[c])
			&& facets_agree(d.facet, n.meta, t));
		if (target) {
			steps.push({ type: 'move', from: from.illusi_id, to: target.illusi_id, values, facet_source: d.facet_source, thumbnails, auto: d.hard, reasons });
			continue;
		}
		const title = d.facet.title ?? null;
		steps.push({
			type: 'split',
			from: from.illusi_id,
			values,
			facet_source: d.facet_source,
			thumbnails,
			new_entity: { kind: from.kind, title: title ?? from.meta.title ?? 'Unknown', duration_ms: d.facet.duration_ms ?? null, explicit: d.facet.explicit ?? null },
			auto: d.hard && !!title,
			reasons: title ? reasons : [...reasons, 'no_title_for_new_entity']
		});
	}
	return steps;
}

/** Applies the auto split/move steps to in-memory copies, so merges are judged on the post-split state. */
function adjust_nodes(nodes: readonly ReconcileNode[], steps: readonly (SplitStep | MoveStep)[]): ReconcileNode[] {
	const copies = new Map(nodes.map(n => [n.illusi_id, { ...n, ids: { ...n.ids }, facets: [...n.facets] }]));
	for (const step of steps) {
		if (!step.auto) continue;
		const from = copies.get(step.from)!;
		const facet = from.facets.find(f => f.source === step.facet_source);
		for (const c of Object.keys(step.values) as ServiceIdColumn[]) delete from.ids[c];
		from.facets = from.facets.filter(f => f !== facet);
		if (step.type === 'move') {
			const to = copies.get(step.to)!;
			Object.assign(to.ids, step.values);
			if (facet) to.facets.push(facet);
		}
	}
	return [...copies.values()];
}

/**
 * Resolves one connected group in memory: which entities really exist and which
 * external ids belong to each, as a plan of splits, ID moves and merges. Pure: takes one group's
 * rows and writes nothing, so groups can later be streamed from SQL one at a time.
 */
export function resolve_group(group: GroupInput, t: Thresholds): GroupPlan {
	const nodes = [...group.nodes].sort((a, b) => a.illusi_id.localeCompare(b.illusi_id));
	const key = nodes[0].illusi_id;
	const kind = majority_kind(nodes);
	const base: GroupPlan = { key, kind, node_ids: nodes.map(n => n.illusi_id), steps: [], evidence: [], disagreements: [], conflicts: [] };
	if (nodes.length > t.max_group_size) return { ...base, skipped: `group_too_large:${nodes.length}` };

	const disagreements = nodes.flatMap(n => facet_disagreements(n, t));
	const split_steps = plan_splits(nodes, disagreements, t);
	const adjusted = adjust_nodes(nodes, split_steps);

	const moved_sources = new Map<string, Set<string>>();
	for (const s of split_steps) {
		if (!s.auto) continue;
		const set = moved_sources.get(s.from) ?? new Set();
		set.add(s.facet_source);
		moved_sources.set(s.from, set);
	}
	const claims = new Map(adjusted.map(n => [n.illusi_id, claims_of(n, group.conflicts.filter(c => !moved_sources.get(n.illusi_id)?.has(c.source)))]));

	const evidence: PairEvidence[] = [];
	const decisions = new Map<string, PairDecision>();
	const pair_key = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
	for (let i = 0; i < adjusted.length; i++) {
		for (let j = i + 1; j < adjusted.length; j++) {
			const a = adjusted[i];
			const b = adjusted[j];
			if (a.kind !== b.kind || a.kind === 'unknown') continue;
			const e = pair_evidence(a, b, claims.get(a.illusi_id)!, claims.get(b.illusi_id)!, t);
			evidence.push(e);
			decisions.set(pair_key(a.illusi_id, b.illusi_id), decide_pair(e, t));
		}
	}

	// Auto-merge clusters, unless some pair inside a cluster strongly contradicts (A=B, B=C but A≠C).
	const uf = new UnionFind();
	for (const n of adjusted) uf.add(n.illusi_id);
	for (const e of evidence) if (decisions.get(pair_key(e.a, e.b)) === 'merge') uf.union(e.a, e.b);
	const by_id = new Map(adjusted.map(n => [n.illusi_id, n]));
	const cluster_of = new Map<string, string>();
	const merge_steps: MergeStep[] = [];
	for (const members of uf.sets()) {
		if (members.length < 2) {
			cluster_of.set(members[0], members[0]);
			continue;
		}
		const inside = evidence.filter(e => members.includes(e.a) && members.includes(e.b));
		if (inside.some(e => e.contradictions.some(c => c.strong))) {
			for (const m of members) cluster_of.set(m, m);
			for (const e of inside) if (decisions.get(pair_key(e.a, e.b)) === 'merge') decisions.set(pair_key(e.a, e.b), 'review');
			continue;
		}
		const survivor = choose_survivor(members.map(m => by_id.get(m)!));
		for (const m of members) cluster_of.set(m, survivor.illusi_id);
		for (const m of members.sort()) {
			if (m === survivor.illusi_id) continue;
			const direct = inside.find(e => (e.a === m && e.b === survivor.illusi_id) || (e.b === m && e.a === survivor.illusi_id));
			merge_steps.push({ type: 'merge', kind: survivor.kind, survivor: survivor.illusi_id, loser: m, auto: true, reasons: direct?.hard ? [direct.hard] : ['transitive'], confidence: direct?.confidence });
		}
	}

	// Review proposals between clusters, one per cluster pair (the strongest).
	const proposals = new Map<string, MergeStep>();
	for (const e of evidence) {
		if (decisions.get(pair_key(e.a, e.b)) !== 'review') continue;
		const ca = cluster_of.get(e.a)!;
		const cb = cluster_of.get(e.b)!;
		if (ca === cb) continue;
		const k = pair_key(ca, cb);
		const existing = proposals.get(k);
		if (existing && (existing.confidence ?? 0) >= e.confidence) continue;
		const survivor = choose_survivor([by_id.get(ca)!, by_id.get(cb)!]);
		const loser = survivor.illusi_id === ca ? cb : ca;
		const reasons = e.hard ? [e.hard, 'blocked_by_contradiction'] : e.signals.map(s => s.name);
		proposals.set(k, { type: 'merge', kind: survivor.kind, survivor: survivor.illusi_id, loser, auto: false, reasons, confidence: e.confidence });
	}

	const steps: PlanStep[] = [...split_steps, ...merge_steps, ...proposals.values()];
	const conflicts = group.conflicts.map(c => ({ id: c.id, status: conflict_resolution(c, steps, cluster_of, claims) }));
	return { ...base, steps, evidence, disagreements, conflicts };
}

function conflict_resolution(
	c: GroupInput['conflicts'][number],
	steps: readonly PlanStep[],
	cluster_of: ReadonlyMap<string, string>,
	claims: ReadonlyMap<string, ReturnType<typeof claims_of>>
): ConflictResolution {
	const touches_split = (auto: boolean) => steps.some(s => s.type !== 'merge' && s.auto === auto
		&& (s.from === c.illusi_id || s.from === c.other_illusi_id) && Object.keys(s.values).includes(c.column));
	if (touches_split(true)) return 'split';

	let other = c.other_illusi_id;
	if (!other) {
		// "Different value" conflict: the incoming value may be held or reported by another node of the group.
		for (const [id, list] of claims) {
			if (id !== c.illusi_id && list.some(x => x.column === c.column && x.value === c.incoming_value)) other = id;
		}
	}
	if (other && cluster_of.has(other)) {
		const ca = cluster_of.get(c.illusi_id);
		const cb = cluster_of.get(other);
		if (ca && ca === cb) {
			const merged = steps.some(s => s.type === 'merge' && s.auto && (s.loser === c.illusi_id || s.loser === other));
			if (merged) return 'merged';
		}
		const proposed = steps.some(s => s.type === 'merge' && !s.auto
			&& [s.survivor, s.loser].includes(ca ?? '') && [s.survivor, s.loser].includes(cb ?? ''));
		if (proposed) return 'deferred';
	}
	if (touches_split(false)) return 'deferred';
	return 'dismissed';
}

/** Steps an admin has to decide on. */
export function review_steps(plan: GroupPlan): PlanStep[] {
	return plan.steps.filter(s => !s.auto);
}

/** Stable identity of a plan's proposals, so the nightly pass doesn't re-raise the same review item. */
export function plan_signature(steps: readonly PlanStep[]): string {
	return steps.map((s) => {
		switch (s.type) {
			case 'merge': return `merge:${s.survivor}<${s.loser}`;
			case 'split': return `split:${s.from}:${Object.keys(s.values).sort().join(',')}`;
			case 'move': return `move:${s.from}>${s.to}:${Object.keys(s.values).sort().join(',')}`;
		}
	}).sort().join(';');
}

/**
 * Incremental runs only act on simple, clear-cut conflicts: exactly two ids, and the plan
 * is either one automatic merge, or nothing to do (every conflict dismissed), with no splits involved.
 */
export function is_clear_cut(plan: GroupPlan, t: Thresholds): boolean {
	if (plan.skipped || plan.node_ids.length !== 2 || plan.disagreements.length > 0) return false;
	if (plan.steps.length === 1) return plan.steps[0].type === 'merge' && plan.steps[0].auto;
	return plan.steps.length === 0 && plan.conflicts.every(c => c.status === 'dismissed')
		// Dismissing needs a wide margin below the review threshold; borderline cases wait for the full pass.
		&& plan.evidence.every(e => e.confidence < t.review_min_confidence / 2);
}
