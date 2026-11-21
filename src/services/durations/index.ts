/**
 * Measured track durations. A client that downloads a track (or reads its length from a streaming service) reports
 * what it measured; the stored duration is filled when empty, confirmed when within tolerance, and replaced once
 * enough users agree on a different length. A lone disagreement goes to the review queue instead.
 */
import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { write_audit } from '../../core/audit';
import { as_owner } from '../../core/context';
import { HttpError, json_body, parse_body, require_user, uuid_schema } from '../../core/http';
import { DURATION_TOLERANCE_MS } from '../../core/normalize';
import { rate_limit_user } from '../../core/rate_limit';
import { resolve_redirect } from '../../core/redirects';
import { add_review_item } from '../../core/review';
import { db } from '../../db';
import type { Tx } from '../../db';
import { DURATION_REPORT_SOURCES, review_items_table, track_duration_reports_table, tracks_table } from '../../db/schema';

/** Mounted after `require_auth`: `POST /tracks/:id/duration`. */
export const durations_router = Router();

export const duration_report_schema = z.object({
	/** Shorter than a second is a failed measurement, not a track. */
	duration_ms: z.number().int().min(1000).max(7 * 24 * 3_600_000),
	source: z.enum(DURATION_REPORT_SOURCES),
	service: z.string().trim().min(1).max(32).optional()
});

export type DurationOutcome = 'filled' | 'confirmed' | 'corrected' | 'disputed';

const close = (a: number, b: number) => Math.abs(a - b) <= DURATION_TOLERANCE_MS;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * What a set of measurements says about the stored duration: replace it with the median of the reports that agree
 * with `reported`, once at least DURATION_CONSENSUS_REPORTS users agree and they outnumber those backing the stored
 * value. Null keeps the stored value.
 */
export function consensus_duration(stored: number, reported: number, reports: number[], needed = config.DURATION_CONSENSUS_REPORTS): number | null {
	const agree = reports.filter(r => close(r, reported));
	const backing = reports.filter(r => close(r, stored)).length;
	if (agree.length < needed || agree.length <= backing) return null;
	return median(agree);
}

/** Records one user's measurement and settles the track's duration. Runs in the caller's transaction, as the owner. */
export async function report_duration(tx: Tx, track_id: string, user_id: string, report: z.infer<typeof duration_report_schema>) {
	const [track] = await tx.select({ duration_ms: tracks_table.duration_ms }).from(tracks_table).where(eq(tracks_table.id, track_id)).for('update');
	if (!track) throw new HttpError(404, 'track not found');
	const now = new Date();
	const row = { duration_ms: report.duration_ms, source: report.source, service: report.service ?? null };
	await tx.insert(track_duration_reports_table).values({ track_id, user_id, ...row })
		.onConflictDoUpdate({ target: [track_duration_reports_table.track_id, track_duration_reports_table.user_id], set: { ...row, modified_at: now } });

	const stored = track.duration_ms;
	const settle = (outcome: DurationOutcome, duration_ms: number | null) => ({ track_id, duration_ms, outcome });
	if (stored == null) {
		// modified_at moves with it, so every client picks the duration up on its next pull.
		await tx.update(tracks_table).set({ duration_ms: report.duration_ms, modified_at: now }).where(eq(tracks_table.id, track_id));
		return settle('filled', report.duration_ms);
	}
	if (close(stored, report.duration_ms)) return settle('confirmed', stored);

	const reports = await tx.select({ duration_ms: track_duration_reports_table.duration_ms }).from(track_duration_reports_table)
		.where(eq(track_duration_reports_table.track_id, track_id));
	const corrected = consensus_duration(stored, report.duration_ms, reports.map(r => r.duration_ms));
	if (corrected == null) {
		await add_review_item(tx, {
			kind: 'FIELD_CONFLICT', entity_table: 'tracks_table', entity_id: track_id, field: 'duration_ms',
			current_value: stored, proposed_value: report.duration_ms, source_user_id: user_id, details: { source: `duration_${report.source}`, service: report.service ?? null }
		});
		return settle('disputed', stored);
	}
	await tx.update(tracks_table).set({ duration_ms: corrected, modified_at: now }).where(eq(tracks_table.id, track_id));
	// The disagreement it settles no longer needs a reviewer.
	await tx.update(review_items_table).set({ status: 'APPLIED', resolved_at: now, modified_at: now }).where(and(
		eq(review_items_table.kind, 'FIELD_CONFLICT'), eq(review_items_table.entity_table, 'tracks_table'),
		eq(review_items_table.entity_id, track_id), eq(review_items_table.field, 'duration_ms'), eq(review_items_table.status, 'OPEN')
	));
	await write_audit(tx, {
		action: 'duration_consensus',
		actor: 'consensus',
		actor_user_id: user_id,
		entity_table: 'tracks_table',
		entity_id: track_id,
		details: { from: stored, to: corrected, agreeing_reports: reports.filter(r => close(r.duration_ms, report.duration_ms)).length },
		undo: { table: 'tracks_table', id: track_id, values: { duration_ms: stored } }
	});
	return settle('corrected', corrected);
}

durations_router.post('/tracks/:id/duration', rate_limit_user('duration_report', 120, 60_000), json_body('4kb'), async (req, res) => {
	const user = require_user(req);
	const requested = uuid_schema.safeParse(req.params.id);
	if (!requested.success) throw new HttpError(400, 'invalid track id');
	const body = parse_body(duration_report_schema, req.body);
	// Consensus counts every user's report, which row-level security would hide.
	const result = await as_owner(async () => {
		const track_id = await resolve_redirect(db, requested.data);
		return db.transaction(tx => report_duration(tx, track_id, user.id, body));
	});
	res.json({ ...result, ...(result.track_id === requested.data ? {} : { redirected_from: requested.data }) });
});
