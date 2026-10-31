import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../../db';
import { album_type, albums_table, artists_table, service_ids_table, tracks_table } from '../../db/schema';
import { write_audit } from '../../core/audit';
import type { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { normalize_service_id, SERVICE_ID_COLUMNS } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';
import { pg_error_code, pg_error_detail, PG_ERRORS } from '../../core/pg_errors';

/** Shared tables an admin may correct directly, keyed by table name. */
export const EDITABLE_TABLES = ['tracks_table', 'albums_table', 'artists_table', 'service_ids_table'] as const;
export type EditableTable = typeof EDITABLE_TABLES[number];

const TABLE_ALIASES: Record<string, EditableTable> = {
	tracks: 'tracks_table', track: 'tracks_table', tracks_table: 'tracks_table',
	albums: 'albums_table', album: 'albums_table', albums_table: 'albums_table',
	artists: 'artists_table', artist: 'artists_table', artists_table: 'artists_table',
	service_ids: 'service_ids_table', service_ids_table: 'service_ids_table'
};

export function resolve_table(name: string): EditableTable | null {
	return Object.hasOwn(TABLE_ALIASES, name) ? TABLE_ALIASES[name] : null;
}

const nullable_uuid = z.uuid().nullable();
const nullable_int = z.number().int().min(0).nullable();
const nullable_bool = z.boolean().nullable();
const nullable_date = z.iso.datetime({ offset: true }).or(z.iso.date()).nullable().transform(v => v == null ? null : new Date(v));
const service_id_value = (column: ServiceIdColumn) => z.union([z.string(), z.number()]).nullable().transform((v, ctx) => {
	if (v == null || v === '') return null;
	const normalized = normalize_service_id(column, v);
	if (normalized == null) {
		ctx.addIssue({ code: 'custom', message: `malformed ${column}` });
		return z.NEVER;
	}
	return normalized;
});

/** Editable columns per table and how a submitted value is validated / normalized. Ids and timestamps are never editable. */
export const EDITABLE_COLUMNS: Record<EditableTable, Record<string, z.ZodType>> = {
	tracks_table: {
		title: z.string().trim().min(1).max(256),
		album_id: nullable_uuid,
		duration_ms: nullable_int,
		explicit: nullable_bool,
		imported: z.boolean(),
		backpacked: z.boolean()
	},
	albums_table: {
		name: z.string().trim().min(1).max(256),
		artist_id: nullable_uuid,
		album_type: z.enum(album_type.enumValues).nullable(),
		release_date: nullable_date,
		track_count: nullable_int,
		explicit: nullable_bool
	},
	artists_table: {
		name: z.string().trim().min(1).max(256),
		description: z.string().nullable(),
		primary_genre_name: z.string().max(80).nullable()
	},
	service_ids_table: Object.fromEntries(SERVICE_ID_COLUMNS.map(c => [c, service_id_value(c)]))
};

/**
 * Validates an admin patch against the whitelist: every key must be an editable column of that
 * table; values are validated and normalized.
 */
export function parse_entity_patch(table: EditableTable, patch: unknown): Record<string, unknown> {
	if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'patch must be an object');
	const columns = EDITABLE_COLUMNS[table];
	const entries = Object.entries(patch as Record<string, unknown>);
	if (entries.length === 0) throw new HttpError(400, 'empty patch');
	const unknown_columns = entries.map(([k]) => k).filter(k => !Object.hasOwn(columns, k));
	if (unknown_columns.length > 0) throw new HttpError(400, 'column not editable', { columns: unknown_columns, editable: Object.keys(columns) });
	const out: Record<string, unknown> = {};
	const issues: unknown[] = [];
	for (const [k, v] of entries) {
		const r = columns[k].safeParse(v);
		if (r.success) out[k] = r.data;
		else issues.push({ column: k, issues: r.error.issues });
	}
	if (issues.length > 0) throw new HttpError(400, 'invalid value', { issues });
	return out;
}

// Drizzle tables are typed individually; the editor only needs the shared shape.
type AnyTable = typeof tracks_table;
const TABLES: Record<EditableTable, { table: AnyTable; pk: AnyTable['id'] }> = {
	tracks_table: { table: tracks_table, pk: tracks_table.id },
	albums_table: { table: albums_table as unknown as AnyTable, pk: albums_table.id as unknown as AnyTable['id'] },
	artists_table: { table: artists_table as unknown as AnyTable, pk: artists_table.id as unknown as AnyTable['id'] },
	service_ids_table: { table: service_ids_table as unknown as AnyTable, pk: service_ids_table.illusi_id as unknown as AnyTable['id'] }
};

export interface AdminEditContext {
	admin_id: string;
	review_item_id?: number | null;
	events?: PendingEvents;
}

/**
 * Applies an admin correction. Bumps
 * `modified_at` so clients get it on their next pull, and writes the audit log with the old values.
 */
export async function admin_update_entity(tx: Tx, table: EditableTable, entity_id: string, values: Record<string, unknown>, ctx: AdminEditContext) {
	const { table: t, pk } = TABLES[table];
	const [before] = await tx.select().from(t).where(eq(pk, entity_id)).for('update') as Record<string, unknown>[];
	if (!before) throw new HttpError(404, 'entity not found');
	const old = Object.fromEntries(Object.keys(values).map(k => [k, before[k] ?? null]));
	let after: Record<string, unknown>;
	try {
		// Savepoint, so a unique violation becomes a 409 without aborting the caller's transaction.
		[after] = await tx.transaction(async sp => sp.update(t).set({ ...values, modified_at: new Date() }).where(eq(pk, entity_id)).returning() as Promise<Record<string, unknown>[]>);
	} catch (err) {
		if (pg_error_code(err) === PG_ERRORS.unique_violation) throw new HttpError(409, 'value already belongs to another entity', { detail: pg_error_detail(err) });
		if (pg_error_code(err) === PG_ERRORS.foreign_key_violation) throw new HttpError(400, 'referenced entity does not exist', { detail: pg_error_detail(err) });
		throw err;
	}
	await write_audit(tx, {
		action: ctx.review_item_id ? 'admin_apply' : 'admin_edit',
		actor: 'admin',
		actor_user_id: ctx.admin_id,
		entity_table: table,
		entity_id,
		details: { changes: values, review_item_id: ctx.review_item_id ?? null },
		undo: { table, id: entity_id, values: old }
	});
	if (table === 'service_ids_table' && ctx.events) {
		const filled = Object.keys(values).filter(k => values[k] != null && String(values[k] as string | number) !== String(old[k] as string | number | null));
		if (filled.length > 0) ctx.events.push('service_ids_filled', { illusi_id: entity_id, columns: filled });
		if (filled.includes('applemusic_id')) ctx.events.push('applemusic_id_filled', { illusi_id: entity_id, applemusic_id: String(values.applemusic_id) });
	}
	return { before: old, after };
}
