/** iTunes caps a lookup at 200 results in total, not per id. */
export const ITUNES_LOOKUP_LIMIT = 200;

export interface CollectionSize { id: number; track_count?: number | null }

/**
 * Groups collection ids into album-track lookups so each lookup's results (one collection row per
 * album plus its tracks) stay ≤ `limit`, so no album gets cut off. First-fit decreasing.
 * An album too big for any group, or with an unknown `trackCount`, gets its own lookup.
 */
export function batch_collections(collections: readonly CollectionSize[], limit = ITUNES_LOOKUP_LIMIT): number[][] {
	const solo: number[][] = [];
	const items: { id: number; cost: number }[] = [];
	const seen = new Set<number>();
	for (const c of collections) {
		if (seen.has(c.id)) continue;
		seen.add(c.id);
		if (c.track_count == null || !Number.isFinite(c.track_count) || c.track_count + 1 > limit) solo.push([c.id]);
		else items.push({ id: c.id, cost: Math.max(0, c.track_count) + 1 });
	}
	items.sort((a, b) => b.cost - a.cost);
	const bins: { ids: number[]; used: number }[] = [];
	for (const item of items) {
		const bin = bins.find(b => b.used + item.cost <= limit);
		if (bin) {
			bin.ids.push(item.id);
			bin.used += item.cost;
		} else bins.push({ ids: [item.id], used: item.cost });
	}
	return [...bins.map(b => b.ids), ...solo];
}

/** Splits known ids into lookups of at most `size`. */
export function chunk<T>(values: readonly T[], size = ITUNES_LOOKUP_LIMIT): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
	return out;
}
