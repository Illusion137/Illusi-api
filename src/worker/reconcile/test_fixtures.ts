// Builders for resolver unit tests.
import type { ConflictInfo, Facet, ReconcileNode } from './types';

export function node(id: string, over: Partial<Omit<ReconcileNode, 'meta'>> & { meta?: Partial<Facet> } = {}): ReconcileNode {
	const { meta, ...rest } = over;
	return {
		illusi_id: id,
		kind: 'track',
		has_entity: true,
		created_at: 1_000,
		ids: {},
		facets: [],
		user_data: 0,
		filled: 0,
		vector: null,
		...rest,
		meta: { source: 'entity', columns: [], title: 'Song', artist: 'Artist', duration_ms: 200_000, ...meta }
	};
}

let next_conflict = 1;

export function conflict(illusi_id: string, column: ConflictInfo['column'], incoming_value: string, over: Partial<ConflictInfo> = {}): ConflictInfo {
	return { id: next_conflict++, illusi_id, column, existing_value: null, incoming_value, other_illusi_id: null, source: 'genius', status: 'open', ...over };
}
