import type { Tx } from '../db';
import type { PROVENANCE_SOURCES } from '../db/schema';
import { contributions_log_table } from '../db/schema';

export type ProvenanceSource = typeof PROVENANCE_SOURCES[number];

export interface TouchedEntity {
	table: string;
	id: string | number;
	/** Fields this submission filled (or `['*']` for an insert). */
	filled: string[];
}

/** Collects every entity a submission touched, then writes one `contributions_log_table` row. */
export class ProvenanceLog {
	readonly entities: TouchedEntity[] = [];

	constructor(public source: ProvenanceSource, public user_id: string, public token_jti?: string | null, public contribution_id?: string | null) {}

	touch(table: string, id: string | number, filled: string[]) {
		if (filled.length === 0) return;
		this.entities.push({ table, id, filled });
	}

	async write(tx: Tx, response?: unknown) {
		const [row] = await tx.insert(contributions_log_table).values({
			contribution_id: this.contribution_id ?? null,
			user_id: this.user_id,
			source: this.source,
			token_jti: this.token_jti ?? null,
			entities: this.entities,
			response: response ?? null
		}).returning({ id: contributions_log_table.id });
		return row.id;
	}
}
