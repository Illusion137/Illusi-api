import { inArray } from 'drizzle-orm';
import type { Executor } from '../db';
import { illusi_id_redirects_table } from '../db/schema';

const MAX_HOPS = 10;

/** Follows `illusi_id_redirects_table` (old → new, possibly chained) for every id. Unredirected ids map to themselves. */
export async function resolve_redirects(ex: Executor, ids: readonly string[]): Promise<Map<string, string>> {
	const result = new Map<string, string>(ids.map(id => [id, id]));
	let pending = [...new Set(ids)];
	for (let hop = 0; hop < MAX_HOPS && pending.length > 0; hop++) {
		const rows = await ex.select().from(illusi_id_redirects_table).where(inArray(illusi_id_redirects_table.old_id, pending));
		if (rows.length === 0) break;
		const next = new Map(rows.map(r => [r.old_id, r.new_id]));
		for (const [original, current] of result) {
			const to = next.get(current);
			if (to) result.set(original, to);
		}
		pending = [...new Set(rows.map(r => r.new_id))];
	}
	return result;
}

export async function resolve_redirect(ex: Executor, id: string): Promise<string> {
	return (await resolve_redirects(ex, [id])).get(id)!;
}
