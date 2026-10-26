import { db } from '../../db';
import { logger } from '../../core/log';
import { apply_step, order_steps, raise_review, set_conflict_statuses } from './apply';
import type { StepResult } from './apply';
import { build_groups } from './group';
import { load_conflicts, load_nodes, load_vectors } from './load';
import { is_clear_cut, resolve_group } from './resolve';
import type { Thresholds } from './thresholds';
import type { ConflictInfo, GroupInput, GroupPlan, ReconcileNode } from './types';

const log = logger('reconcile');

/** `pg_try_advisory_lock` key: only one reconciliation pass runs at a time across all workers. */
export const RECONCILE_LOCK_KEY = 0x5245434f; // 'RECO'

export interface RunOptions {
	mode: 'full' | 'incremental';
	dry_run: boolean;
	thresholds: Thresholds;
}

export interface RunReport {
	mode: RunOptions['mode'];
	dry_run: boolean;
	locked: boolean;
	groups: number;
	groups_with_work: number;
	skipped_groups: number;
	failed_groups: number;
	merges: number;
	splits: number;
	moves: number;
	steps_skipped_at_apply: number;
	reviews_raised: number;
	conflicts: Record<string, number>;
	/** Dry run only: every plan that would change something. */
	plans?: GroupPlan[];
}

function empty_report(opts: RunOptions): RunReport {
	return { mode: opts.mode, dry_run: opts.dry_run, locked: false, groups: 0, groups_with_work: 0, skipped_groups: 0, failed_groups: 0, merges: 0, splits: 0, moves: 0, steps_skipped_at_apply: 0, reviews_raised: 0, conflicts: {} };
}

const has_work = (plan: GroupPlan) => plan.steps.length > 0 || plan.conflicts.length > 0;

function count_plan(report: RunReport, plan: GroupPlan, results: readonly Pick<StepResult, 'step' | 'applied'>[], statuses_written: boolean) {
	for (const r of results) {
		if (!r.applied) continue;
		if (r.step.type === 'merge') report.merges++;
		else if (r.step.type === 'split') report.splits++;
		else report.moves++;
	}
	report.steps_skipped_at_apply += results.filter(r => !r.applied).length;
	if (!statuses_written) return;
	for (const c of plan.conflicts) report.conflicts[c.status] = (report.conflicts[c.status] ?? 0) + 1;
}

/**
 * Applies one group's plan in its own transaction: the hard-evidence steps, the
 * conflict statuses, and a review item for everything else. If any automatic step no longer applies
 * (the data changed since it was loaded), conflict statuses are left for the next run.
 */
export async function apply_group(plan: GroupPlan, report: RunReport, opts: { review: boolean }) {
	await db.transaction(async (tx) => {
		const results: StepResult[] = [];
		for (const step of order_steps(plan.steps.filter(s => s.auto))) results.push(await apply_step(tx, step, { actor: 'reconcile' }));
		const all_applied = results.every(r => r.applied);
		if (all_applied) await set_conflict_statuses(tx, plan.conflicts);
		if (opts.review && await raise_review(tx, plan) != null) report.reviews_raised++;
		count_plan(report, plan, results, all_applied);
	});
}

async function with_lock(report: RunReport, fn: () => Promise<void>) {
	const client = await db.$client.connect();
	try {
		const res = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [RECONCILE_LOCK_KEY]);
		if (!res.rows[0]?.ok) {
			log.info('another reconciliation pass holds the lock; skipping');
			return;
		}
		report.locked = true;
		try {
			await fn();
		} finally {
			await client.query('select pg_advisory_unlock($1)', [RECONCILE_LOCK_KEY]);
		}
	} finally {
		client.release();
	}
}

async function attach_vectors(groups: readonly GroupInput[]) {
	const ids = groups.filter(g => g.nodes.length > 1).flatMap(g => g.nodes.filter(n => n.kind === 'track').map(n => n.illusi_id));
	if (ids.length === 0) return;
	const vectors = await load_vectors(db, ids);
	for (const g of groups) for (const n of g.nodes) n.vector = vectors.get(n.illusi_id) ?? null;
}

async function process_plan(plan: GroupPlan, report: RunReport, opts: RunOptions) {
	if (plan.skipped) {
		report.skipped_groups++;
		log.warn(`group ${plan.key} skipped: ${plan.skipped}`);
		return;
	}
	if (!has_work(plan)) return;
	report.groups_with_work++;
	if (opts.dry_run) {
		(report.plans ??= []).push(plan);
		count_plan(report, plan, plan.steps.filter(s => s.auto).map(step => ({ step, applied: true })), true);
		if (plan.steps.some(s => !s.auto)) report.reviews_raised++;
		return;
	}
	try {
		await apply_group(plan, report, { review: opts.mode === 'full' });
	} catch (err) {
		report.failed_groups++;
		log.error(`group ${plan.key} failed; rolled back`, err);
	}
}

/**
 * Full pass: the whole `service_ids_table` plus open and deferred conflicts, grouped,
 * resolved group by group, applied one transaction per group.
 */
async function full_pass(report: RunReport, opts: RunOptions) {
	const nodes = await load_nodes(db, null);
	const conflicts = await load_conflicts(db, ['open', 'deferred']);
	const groups = build_groups(nodes, conflicts, opts.thresholds)
		.filter(g => g.nodes.length > 1 || g.conflicts.length > 0 || g.nodes[0].facets.length > 0);
	report.groups = groups.length;
	log.info(`full pass: ${nodes.length} ids, ${conflicts.length} conflicts, ${groups.length} candidate groups`);
	await attach_vectors(groups);
	for (const group of groups) await process_plan(resolve_group(group, opts.thresholds), report, opts);
}

/** Pairs of ids linked by open conflicts where neither id is entangled with a third one. */
export function simple_pairs(open: readonly ConflictInfo[], all: readonly ConflictInfo[]): [string, string][] {
	const partners = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		const set = partners.get(a) ?? new Set();
		set.add(b);
		partners.set(a, set);
	};
	for (const c of all) {
		if (!c.other_illusi_id) continue;
		link(c.illusi_id, c.other_illusi_id);
		link(c.other_illusi_id, c.illusi_id);
	}
	const pairs = new Map<string, [string, string]>();
	for (const c of open) {
		if (!c.other_illusi_id || c.other_illusi_id === c.illusi_id) continue;
		const [a, b] = [c.illusi_id, c.other_illusi_id].sort();
		if (partners.get(a)!.size !== 1 || partners.get(b)!.size !== 1) continue;
		pairs.set(`${a}|${b}`, [a, b]);
	}
	return [...pairs.values()];
}

/** Incremental run: only open conflicts between exactly two ids whose outcome is clear-cut. */
async function incremental_pass(report: RunReport, opts: RunOptions) {
	const all = await load_conflicts(db, ['open', 'deferred']);
	const open = all.filter(c => c.status === 'open');
	const pairs = simple_pairs(open, all);
	report.groups = pairs.length;
	if (pairs.length === 0) return;
	const nodes = new Map<string, ReconcileNode>((await load_nodes(db, pairs.flat())).map(n => [n.illusi_id, n]));
	const groups: GroupInput[] = [];
	for (const [a, b] of pairs) {
		const na = nodes.get(a);
		const nb = nodes.get(b);
		if (!na || !nb) continue;
		const conflicts = open.filter(c => (c.illusi_id === a || c.illusi_id === b) && (c.other_illusi_id === a || c.other_illusi_id === b));
		groups.push({ nodes: [na, nb], conflicts });
	}
	await attach_vectors(groups);
	for (const group of groups) {
		const plan = resolve_group(group, opts.thresholds);
		if (!is_clear_cut(plan, opts.thresholds)) continue;
		await process_plan(plan, report, opts);
	}
}

export async function run_pass(opts: RunOptions): Promise<RunReport> {
	const report = empty_report(opts);
	await with_lock(report, () => opts.mode === 'full' ? full_pass(report, opts) : incremental_pass(report, opts));
	const { plans: _plans, ...summary } = report;
	log.info(`${opts.mode} pass done${opts.dry_run ? ' (dry run)' : ''}`, summary);
	return report;
}
