import { and, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db';
import { service_id_conflicts_table, service_ids_table } from '../db/schema';
import type { PendingEvents } from './events';
import { logger } from './log';
import { normalize_service_ids, SERVICE_ID_COLUMNS } from './service_ids';
import type { ServiceIdColumn, ServiceIds } from './service_ids';
import { pg_error_code, PG_ERRORS } from './pg_errors';

const log = logger('enrich');

export interface EnrichContext {
	/** Where the ids came from: `itunes`, `genius`, `soundcloud`, `contribute`, `sync_push`, `youtube_music`, ... */
	source: string;
	user_id?: string | null;
	token_jti?: string | null;
	/** Collects follow-up events (`applemusic_id_filled`, `service_ids_filled`) to flush after commit. */
	events?: PendingEvents;
}

export interface EnrichConflict {
	column: ServiceIdColumn;
	kind: 'different_value' | 'taken';
	existing_value: string | null;
	incoming_value: string;
	other_illusi_id: string | null;
}

export interface EnrichResult {
	filled: ServiceIdColumn[];
	conflicts: EnrichConflict[];
	rejected: { column: ServiceIdColumn; value: unknown }[];
}

const col = (column: ServiceIdColumn) => service_ids_table[column];

async function record_conflict(tx: Tx, illusi_id: string, conflict: EnrichConflict, ctx: EnrichContext) {
	const existing = await tx.select({ id: service_id_conflicts_table.id }).from(service_id_conflicts_table).where(and(
		eq(service_id_conflicts_table.illusi_id, illusi_id),
		eq(service_id_conflicts_table.column, conflict.column),
		eq(service_id_conflicts_table.incoming_value, conflict.incoming_value),
		sql`${service_id_conflicts_table.status} in ('open', 'deferred')`
	)).limit(1);
	if (existing.length > 0) return;
	await tx.insert(service_id_conflicts_table).values({
		illusi_id,
		column: conflict.column,
		existing_value: conflict.existing_value,
		incoming_value: conflict.incoming_value,
		other_illusi_id: conflict.other_illusi_id,
		source: ctx.source,
		source_user_id: ctx.user_id ?? null,
		source_token_jti: ctx.token_jti ?? null
	});
	log.info(`conflict on ${illusi_id}.${conflict.column}`, { ...conflict, source: ctx.source });
}

/**
 * The shared helper every service passes cross-service ids through.
 * Only fills empty columns, never overwrites, records conflicts instead of resolving them.
 * Never creates the `service_ids_table` row: the local entity always comes first.
 */
export async function enrich_service_ids(tx: Tx, illusi_id: string, ids: ServiceIds, ctx: EnrichContext): Promise<EnrichResult> {
	const { ids: normalized, rejected } = normalize_service_ids(ids);
	for (const r of rejected) log.warn(`rejected malformed ${r.column}`, { illusi_id, value: r.value, source: ctx.source });
	const result: EnrichResult = { filled: [], conflicts: [], rejected };
	if (Object.keys(normalized).length === 0) return result;

	const [row] = await tx.select().from(service_ids_table).where(eq(service_ids_table.illusi_id, illusi_id)).for('update');
	if (!row) {
		log.warn(`enrich on unknown illusi_id ${illusi_id}`, { source: ctx.source });
		return result;
	}

	for (const column of SERVICE_ID_COLUMNS) {
		const incoming = normalized[column];
		if (incoming == null) continue;
		const existing = row[column];
		if (existing != null && String(existing) === String(incoming)) continue;
		if (existing != null) {
			result.conflicts.push({ column, kind: 'different_value', existing_value: String(existing), incoming_value: String(incoming), other_illusi_id: null });
			continue;
		}
		if (column !== 'isrc') {
			const [other] = await tx.select({ illusi_id: service_ids_table.illusi_id }).from(service_ids_table)
				.where(and(eq(col(column), incoming as never), ne(service_ids_table.illusi_id, illusi_id))).limit(1);
			if (other) {
				result.conflicts.push({ column, kind: 'taken', existing_value: null, incoming_value: String(incoming), other_illusi_id: other.illusi_id });
				continue;
			}
		}
		try {
			// Savepoint so a concurrent writer claiming the same unique value doesn't abort the caller's transaction.
			const updated = await tx.transaction(async sp => sp.update(service_ids_table)
				.set({ [column]: incoming })
				.where(and(eq(service_ids_table.illusi_id, illusi_id), sql`${col(column)} is null`))
				.returning({ illusi_id: service_ids_table.illusi_id }));
			if (updated.length > 0) {
				result.filled.push(column);
				(row as Record<string, unknown>)[column] = incoming;
			}
		} catch (err) {
			if (pg_error_code(err) !== PG_ERRORS.unique_violation) throw err;
			const [other] = await tx.select({ illusi_id: service_ids_table.illusi_id }).from(service_ids_table).where(eq(col(column), incoming as never)).limit(1);
			result.conflicts.push({ column, kind: 'taken', existing_value: null, incoming_value: String(incoming), other_illusi_id: other?.illusi_id ?? null });
		}
	}

	for (const conflict of result.conflicts) await record_conflict(tx, illusi_id, conflict, ctx);

	if (result.filled.length > 0 && ctx.events) {
		ctx.events.push('service_ids_filled', { illusi_id, columns: result.filled });
		if (result.filled.includes('applemusic_id')) ctx.events.push('applemusic_id_filled', { illusi_id, applemusic_id: String(normalized.applemusic_id) });
	}
	return result;
}

/** Looks up the `illusi_id` already holding any of these ids. Returns every distinct match. */
export async function find_illusi_ids_by_service_ids(tx: Tx, ids: ServiceIds): Promise<{ illusi_id: string; columns: ServiceIdColumn[] }[]> {
	const { ids: normalized } = normalize_service_ids(ids);
	const matches = new Map<string, ServiceIdColumn[]>();
	for (const column of SERVICE_ID_COLUMNS) {
		const value = normalized[column];
		if (value == null) continue;
		const rows = await tx.select({ illusi_id: service_ids_table.illusi_id }).from(service_ids_table).where(eq(col(column), value as never)).limit(column === 'isrc' ? 20 : 1);
		for (const r of rows) matches.set(r.illusi_id, [...(matches.get(r.illusi_id) ?? []), column]);
	}
	return [...matches].map(([illusi_id, columns]) => ({ illusi_id, columns }));
}
