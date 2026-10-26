import type { Tx } from '../db';
import { audit_log_table } from '../db/schema';

export interface AuditEntry {
	action: 'merge' | 'split' | 'id_move' | 'admin_edit' | 'admin_apply' | 'admin_delete' | (string & {});
	actor: 'reconcile' | 'admin' | (string & {});
	actor_user_id?: string | null;
	entity_table?: string | null;
	entity_id?: string | null;
	details: unknown;
	/** Enough to revert the change. */
	undo?: unknown;
}

/** Append-only audit log. */
export async function write_audit(tx: Tx, entry: AuditEntry) {
	await tx.insert(audit_log_table).values({
		action: entry.action,
		actor: entry.actor,
		actor_user_id: entry.actor_user_id ?? null,
		entity_table: entry.entity_table ?? null,
		entity_id: entry.entity_id ?? null,
		details: entry.details ?? {},
		undo: entry.undo ?? null
	});
}
