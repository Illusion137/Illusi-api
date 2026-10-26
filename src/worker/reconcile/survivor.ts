import type { ReconcileNode } from './types';

/**
 * Orders merge candidates best-first: an existing entity row, then more user data,
 * then more filled columns, then the older one; the id breaks remaining ties so runs are deterministic.
 */
export function compare_survivors(a: ReconcileNode, b: ReconcileNode): number {
	if (a.has_entity !== b.has_entity) return a.has_entity ? -1 : 1;
	if (a.user_data !== b.user_data) return b.user_data - a.user_data;
	if (a.filled !== b.filled) return b.filled - a.filled;
	if (a.created_at !== b.created_at) return a.created_at - b.created_at;
	return a.illusi_id.localeCompare(b.illusi_id);
}

export function choose_survivor<T extends ReconcileNode>(nodes: readonly T[]): T {
	if (nodes.length === 0) throw new Error('choose_survivor: no nodes');
	return [...nodes].sort(compare_survivors)[0];
}
