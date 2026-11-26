import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { tracks_table } from '../../db/schema';
import { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { resolve_redirects } from '../../core/redirects';
import { apply_merge } from '../../worker/reconcile/apply';
import { clear_backpacked } from '../backpack';

export const merge_tracks_schema = z.object({
	survivor: z.uuid(),
	losers: z.array(z.uuid()).min(1).max(20)
});

/**
 * Merges tracks an admin picked as one recording into `survivor`, through the reconciliation merge: references,
 * redirects, service ids and the audit log (with undo data) are handled the same way. Ids differing on a service
 * don't stop an admin; the survivor keeps its own. A playable copy merged in makes the survivor playable.
 */
export async function merge_tracks(body: z.infer<typeof merge_tracks_schema>, admin_id: string) {
	const events = new PendingEvents();
	const result = await db.transaction(async (tx) => {
		const resolved = await resolve_redirects(tx, [body.survivor, ...body.losers]);
		const survivor = resolved.get(body.survivor)!;
		const losers = [...new Set(body.losers.map(id => resolved.get(id)!))].filter(id => id !== survivor);
		if (losers.length === 0) throw new HttpError(400, 'nothing to merge: every track is already the survivor');

		const rows = await tx.select({ id: tracks_table.id, backpacked: tracks_table.backpacked }).from(tracks_table)
			.where(inArray(tracks_table.id, [survivor, ...losers]));
		const missing = [survivor, ...losers].filter(id => !rows.some(r => r.id === id));
		if (missing.length > 0) throw new HttpError(404, 'track not found', { ids: missing });

		const merged: string[] = [];
		const skipped: { id: string; reason: string }[] = [];
		for (const loser of losers) {
			const step = await apply_merge(tx, { type: 'merge', kind: 'track', survivor, loser, auto: false, reasons: ['admin'] },
				{ actor: 'admin', actor_user_id: admin_id, events });
			if (step.applied) merged.push(loser);
			else skipped.push({ id: loser, reason: step.skipped ?? 'unknown' });
		}
		const merged_rows = rows.filter(r => r.id === survivor || merged.includes(r.id));
		if (merged.length > 0 && merged_rows.some(r => !r.backpacked)) await clear_backpacked(tx, survivor);
		return { survivor, merged, skipped };
	});
	events.flush();
	return result;
}
