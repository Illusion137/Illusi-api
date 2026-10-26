import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../../db';
import { playlist_inherited_playlists_table, playlists_table } from '../../db/schema';
import { HttpError } from '../../core/http';

export type InheritanceEdges = ReadonlyMap<string, readonly string[]>;

export function edges_from(rows: readonly { playlist_id: string; ref_id: string }[]): Map<string, string[]> {
	const edges = new Map<string, string[]>();
	for (const { playlist_id, ref_id } of rows) {
		const list = edges.get(playlist_id);
		if (list) list.push(ref_id);
		else edges.set(playlist_id, [ref_id]);
	}
	return edges;
}

/** True if adding the edge `playlist_id → ref_id` closes a cycle, i.e. `ref_id` already reaches `playlist_id`. */
export function creates_cycle(edges: InheritanceEdges, playlist_id: string, ref_id: string): boolean {
	if (playlist_id === ref_id) return true;
	const seen = new Set<string>([ref_id]);
	const stack = [ref_id];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const next of edges.get(current) ?? []) {
			if (next === playlist_id) return true;
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return false;
}

/**
 * `playlist_id` and `ref_id` must both be owned by `user_id` and the new edge must not make a cycle over the
 * user's non-deleted inheritance rows. Throws 403 (ownership) or 409 (cycle). The DB triggers enforce the same rules.
 */
export async function assert_inheritance_allowed(tx: Tx, user_id: string, playlist_id: string, ref_id: string): Promise<void> {
	if (playlist_id === ref_id) throw new HttpError(409, 'a playlist cannot inherit itself');
	const owners = await tx.select({ id: playlists_table.id, user_id: playlists_table.user_id })
		.from(playlists_table)
		.where(inArray(playlists_table.id, [playlist_id, ref_id]));
	const owner_of = new Map(owners.map(o => [o.id, o.user_id]));
	if (owner_of.get(playlist_id) !== user_id) throw new HttpError(403, 'playlist is not owned by user', { playlist_id });
	if (owner_of.get(ref_id) !== user_id) throw new HttpError(403, 'only your own playlists can be inherited', { ref_id });

	const rows = await tx.select({ playlist_id: playlist_inherited_playlists_table.playlist_id, ref_id: playlist_inherited_playlists_table.ref_id })
		.from(playlist_inherited_playlists_table)
		.innerJoin(playlists_table, eq(playlists_table.id, playlist_inherited_playlists_table.playlist_id))
		.where(and(eq(playlists_table.user_id, user_id), eq(playlist_inherited_playlists_table.deleted, false)));
	if (creates_cycle(edges_from(rows), playlist_id, ref_id)) throw new HttpError(409, 'playlist inheritance would create a cycle', { playlist_id, ref_id });
}
