import { normalize_name, primary_artist_name } from '../../core/normalize';
import type { Thresholds } from './thresholds';
import type { Claim, ConflictInfo, GroupInput, ReconcileNode } from './types';

/** Disjoint-set forest with path halving and union by size. */
export class UnionFind {
	private readonly parent = new Map<string, string>();
	private readonly size = new Map<string, number>();

	add(x: string) {
		if (!this.parent.has(x)) {
			this.parent.set(x, x);
			this.size.set(x, 1);
		}
	}

	find(x: string): string {
		this.add(x);
		let p = this.parent.get(x)!;
		while (p !== x) {
			const gp = this.parent.get(p)!;
			this.parent.set(x, gp);
			x = p;
			p = this.parent.get(x)!;
		}
		return x;
	}

	union(a: string, b: string) {
		let ra = this.find(a);
		let rb = this.find(b);
		if (ra === rb) return;
		if (this.size.get(ra)! < this.size.get(rb)!) [ra, rb] = [rb, ra];
		this.parent.set(rb, ra);
		this.size.set(ra, this.size.get(ra)! + this.size.get(rb)!);
	}

	/** Members by root, every member included. */
	sets(): string[][] {
		const out = new Map<string, string[]>();
		for (const x of this.parent.keys()) {
			const r = this.find(x);
			const list = out.get(r);
			if (list) list.push(x);
			else out.set(r, [x]);
		}
		return [...out.values()];
	}
}

/**
 * Every (column, value) a node claims: its own `service_ids_table` values (sourced by the service row
 * that confirms them, else `stored`), the ids its service rows report, and the incoming values of its conflicts.
 */
export function claims_of(node: ReconcileNode, conflicts: readonly ConflictInfo[] = []): Claim[] {
	const claims: Claim[] = [];
	for (const [column, value] of Object.entries(node.ids) as [Claim['column'], string][]) {
		const confirming = node.facets.find(f => f.columns.includes(column) || (column === 'isrc' && f.isrc === value));
		claims.push({ column, value, source: confirming?.source ?? 'stored' });
	}
	for (const facet of node.facets) {
		for (const [column, value] of Object.entries(facet.reported ?? {}) as [Claim['column'], string][]) {
			claims.push({ column, value, source: facet.source });
		}
		if (facet.isrc) claims.push({ column: 'isrc', value: facet.isrc, source: facet.source });
	}
	for (const c of conflicts) {
		if (c.illusi_id === node.illusi_id) claims.push({ column: c.column, value: c.incoming_value, source: c.source });
	}
	return claims;
}

/** Normalized title + primary artist block key for "strong metadata match" grouping. Null when too little metadata. */
export function metadata_block_key(node: ReconcileNode): string | null {
	if (node.kind !== 'track' && node.kind !== 'album') return null;
	const title = node.meta.title ? normalize_name(node.meta.title) : '';
	const artist = node.meta.artist ? normalize_name(primary_artist_name(node.meta.artist)) : '';
	if (!title || !artist) return null;
	return `${node.kind}\u0000${title}\u0000${artist}`;
}

/**
 * Builds connected groups. Two ids are connected if they claim the same external id
 * value (including ISRC), are linked by a conflict, or strongly match on metadata (normalized title,
 * primary artist and, for tracks, duration within tolerance).
 */
export function build_groups(nodes: readonly ReconcileNode[], conflicts: readonly ConflictInfo[], thresholds: Thresholds): GroupInput[] {
	const uf = new UnionFind();
	const by_id = new Map(nodes.map(n => [n.illusi_id, n]));
	const conflicts_by_node = new Map<string, ConflictInfo[]>();
	for (const c of conflicts) {
		if (!by_id.has(c.illusi_id)) continue;
		const list = conflicts_by_node.get(c.illusi_id);
		if (list) list.push(c);
		else conflicts_by_node.set(c.illusi_id, [c]);
	}

	const by_value = new Map<string, string>();
	const blocks = new Map<string, ReconcileNode[]>();
	for (const node of nodes) {
		uf.add(node.illusi_id);
		for (const claim of claims_of(node, conflicts_by_node.get(node.illusi_id))) {
			const key = `${node.kind}\u0000${claim.column}\u0000${claim.value}`;
			const first = by_value.get(key);
			if (first) uf.union(first, node.illusi_id);
			else by_value.set(key, node.illusi_id);
		}
		const block = metadata_block_key(node);
		if (block) {
			const list = blocks.get(block);
			if (list) list.push(node);
			else blocks.set(block, [node]);
		}
	}

	for (const c of conflicts) {
		if (c.other_illusi_id && by_id.has(c.illusi_id) && by_id.has(c.other_illusi_id)) uf.union(c.illusi_id, c.other_illusi_id);
	}

	for (const block of blocks.values()) {
		if (block.length < 2 || block.length > thresholds.max_metadata_block) continue;
		if (block[0].kind === 'album') {
			for (const n of block.slice(1)) uf.union(block[0].illusi_id, n.illusi_id);
			continue;
		}
		const timed = block.filter(n => n.meta.duration_ms != null).sort((a, b) => a.meta.duration_ms! - b.meta.duration_ms!);
		for (let i = 1; i < timed.length; i++) {
			if (timed[i].meta.duration_ms! - timed[i - 1].meta.duration_ms! <= thresholds.duration_tolerance_ms) uf.union(timed[i - 1].illusi_id, timed[i].illusi_id);
		}
	}

	const groups = uf.sets().map((ids) => {
		ids.sort();
		const set = new Set(ids);
		return {
			nodes: ids.map(id => by_id.get(id)!),
			conflicts: conflicts.filter(c => set.has(c.illusi_id))
		};
	});
	return groups.sort((a, b) => a.nodes[0].illusi_id.localeCompare(b.nodes[0].illusi_id));
}
