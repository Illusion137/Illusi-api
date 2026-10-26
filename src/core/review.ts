import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db';
import type { REVIEW_KINDS } from '../db/schema';
import { review_items_table } from '../db/schema';

export type ReviewKind = typeof REVIEW_KINDS[number];

export interface ProposedValue {
	value: unknown;
	source_user_ids: string[];
	occurrences: number;
	plan?: unknown;
	evidence?: unknown;
}

export interface ReviewReport {
	kind: ReviewKind;
	entity_table: string;
	entity_id: string;
	field?: string | null;
	current_value?: unknown;
	proposed_value?: unknown;
	source_user_id?: string | null;
	plan?: unknown;
	evidence?: unknown;
	details?: unknown;
}

const stable = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Adds or bumps a review item. One OPEN row per (kind, entity, field); each distinct
 * proposed value is an entry in `proposed_values` with its own users and count, so several
 * conflicting proposals are grouped. The row's `occurrences` / `source_user_ids` are the totals.
 */
export async function add_review_item(tx: Tx, report: ReviewReport): Promise<number> {
	const field = report.field ?? null;
	const dedupe_key = createHash('sha256').update([report.kind, report.entity_table, report.entity_id, field ?? ''].join('\u0000')).digest('hex');
	const user = report.source_user_id ?? null;

	const [existing] = await tx.select().from(review_items_table)
		.where(and(eq(review_items_table.dedupe_key, dedupe_key), eq(review_items_table.status, 'OPEN')))
		.for('update');

	const entry: ProposedValue = { value: report.proposed_value ?? null, source_user_ids: user ? [user] : [], occurrences: 1, plan: report.plan, evidence: report.evidence };

	if (!existing) {
		const [row] = await tx.insert(review_items_table).values({
			kind: report.kind,
			entity_table: report.entity_table,
			entity_id: report.entity_id,
			field,
			current_value: report.current_value ?? null,
			proposed_values: [entry],
			source_user_ids: user ? [user] : [],
			occurrences: 1,
			details: report.details ?? null,
			dedupe_key
		}).onConflictDoNothing().returning({ id: review_items_table.id });
		if (row) return row.id;
		return add_review_item(tx, report);
	}

	const proposals = (existing.proposed_values as ProposedValue[] | null) ?? [];
	const match = proposals.find(p => stable(p.value) === stable(entry.value));
	if (match) {
		match.occurrences += 1;
		if (user && !match.source_user_ids.includes(user)) match.source_user_ids.push(user);
		if (report.plan !== undefined) match.plan = report.plan;
		if (report.evidence !== undefined) match.evidence = report.evidence;
	} else {
		proposals.push(entry);
	}
	const users = existing.source_user_ids.includes(user ?? '') || !user ? existing.source_user_ids : [...existing.source_user_ids, user];
	await tx.update(review_items_table).set({
		proposed_values: proposals,
		source_user_ids: users,
		occurrences: existing.occurrences + 1,
		current_value: report.current_value === undefined ? existing.current_value : report.current_value,
		details: report.details === undefined ? existing.details : report.details
	}).where(eq(review_items_table.id, existing.id));
	return existing.id;
}
