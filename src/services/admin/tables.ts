import { and, asc, desc, eq, getTableColumns, is, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Column, SQL } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db';
import type { Tx } from '../../db';
import * as schema from '../../db/schema';
import { write_audit } from '../../core/audit';
import { forget_user } from '../../core/auth/middleware';
import { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { pg_error_code, pg_error_detail, PG_ERRORS } from '../../core/pg_errors';
import { admin_update_entity, EDITABLE_COLUMNS, parse_entity_patch, resolve_table } from './entities';

/**
 * The dashboard's table browser: every table in the schema, its rows, and edits to single cells. Secrets are never
 * sent, the audit log can't be rewritten, and keys, timestamps the app maintains and binary columns stay read-only.
 */

/** How the dashboard shows and edits a column. */
export type ColumnKind = 'text' | 'uuid' | 'enum' | 'boolean' | 'integer' | 'number' | 'timestamp' | 'date' | 'json' | 'array' | 'vector' | 'binary';

export interface ColumnInfo {
	name: string;
	sql_type: string;
	kind: ColumnKind;
	nullable: boolean;
	primary_key: boolean;
	has_default: boolean;
	enum_values: string[] | null;
	editable: boolean;
	/** Never sent: shown as hidden, not filterable or sortable. */
	redacted: boolean;
}

interface TableMeta {
	name: string;
	table: PgTable;
	primary_key: string[];
	editable: boolean;
	columns: ColumnInfo[];
	/** Drizzle column objects by database name. */
	refs: Map<string, Column>;
	/** Drizzle property names by database name, for `.set()`. */
	keys: Map<string, string>;
	values: Map<string, z.ZodType>;
}

/** Append-only history: editing it would forge the record of who changed what. */
const READ_ONLY_TABLES = new Set(['audit_log_table']);
const REDACTED_COLUMNS = new Set(['users_table.password_hash', 'sessions_table.token_hash', 'email_verifications_table.token_hash']);
/** Set by the app, never by hand. */
const MANAGED_COLUMNS = new Set(['created_at', 'modified_at']);
const READ_ONLY_KINDS = new Set<ColumnKind>(['vector', 'binary']);
/** Comparisons need a scalar Postgres can cast the filter text to. */
const SCALAR_KINDS = new Set<ColumnKind>(['text', 'uuid', 'enum', 'boolean', 'integer', 'number', 'timestamp', 'date']);

const INT32 = 2 ** 31;

function column_kind(c: Column, element = false): ColumnKind {
	if (c.columnType === 'PgVector') return 'vector';
	if (c.columnType === 'PgBytea') return 'binary';
	if (!element && (c as Column & { dimensions?: number }).dimensions) return 'array';
	switch (c.columnType) {
		case 'PgUUID': return 'uuid';
		case 'PgEnumColumn': return 'enum';
		case 'PgBoolean': return 'boolean';
		case 'PgInteger': case 'PgBigInt53': return 'integer';
		case 'PgDoublePrecision': case 'PgReal': return 'number';
		case 'PgTimestamp': return 'timestamp';
		case 'PgDateString': return 'date';
		case 'PgJsonb': return 'json';
		default: return 'text';
	}
}

function scalar_schema(c: Column, kind: ColumnKind): z.ZodType {
	switch (kind) {
		case 'uuid': return z.uuid();
		case 'enum': return z.enum(c.enumValues as [string, ...string[]]);
		case 'boolean': return z.boolean();
		case 'integer': return c.columnType === 'PgInteger' ? z.number().int().min(-INT32).max(INT32 - 1) : z.number().int();
		case 'number': return z.number();
		case 'timestamp': return z.iso.datetime({ offset: true }).transform(v => new Date(v));
		case 'date': return z.iso.date();
		case 'json': return z.json();
		default: {
			const length = (c as Column & { length?: number }).length;
			return length ? z.string().max(length) : z.string();
		}
	}
}

function value_schema(c: Column, kind: ColumnKind): z.ZodType {
	const base = kind === 'array' ? z.array(scalar_schema(c, column_kind(c, true))) : scalar_schema(c, kind);
	return c.notNull ? base : base.nullable();
}

function describe_table(table: PgTable): TableMeta {
	const config = getTableConfig(table);
	const primary_key = config.primaryKeys[0]?.columns.map(c => c.name) ?? config.columns.filter(c => c.primary).map(c => c.name);
	const editable = !READ_ONLY_TABLES.has(config.name);
	const keys = new Map(Object.entries(getTableColumns(table)).map(([key, c]) => [c.name, key]));
	const refs = new Map<string, Column>();
	const values = new Map<string, z.ZodType>();
	const columns = config.columns.map((c): ColumnInfo => {
		const kind = column_kind(c);
		const redacted = REDACTED_COLUMNS.has(`${config.name}.${c.name}`);
		refs.set(c.name, c);
		values.set(c.name, value_schema(c, kind));
		return {
			name: c.name,
			sql_type: kind === 'array' ? `${c.getSQLType()}[]` : c.getSQLType(),
			kind,
			nullable: !c.notNull,
			primary_key: primary_key.includes(c.name),
			has_default: c.hasDefault,
			enum_values: c.enumValues ?? null,
			editable: editable && !redacted && !primary_key.includes(c.name) && !MANAGED_COLUMNS.has(c.name) && !READ_ONLY_KINDS.has(kind),
			redacted
		};
	});
	return { name: config.name, table, primary_key, editable, columns, refs, keys, values };
}

const TABLES = new Map((Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable)).map(describe_table).map(t => [t.name, t]));

function table_meta(name: string): TableMeta {
	const meta = TABLES.get(name);
	if (!meta) throw new HttpError(404, 'unknown table');
	return meta;
}

function column_info(meta: TableMeta, name: string): ColumnInfo {
	const column = meta.columns.find(c => c.name === name);
	if (!column) throw new HttpError(400, 'unknown column', { column: name });
	return column;
}

export async function list_tables() {
	const { rows } = await db.execute<{ name: string; estimate: string }>(sql`
		select relname as name, reltuples::bigint as estimate from pg_class
		where relkind in ('r', 'p') and relnamespace = 'public'::regnamespace`);
	const estimates = new Map(rows.map(r => [r.name, Number(r.estimate)]));
	return {
		tables: [...TABLES.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
			name: t.name,
			primary_key: t.primary_key,
			editable: t.editable,
			// -1 until the table has been analyzed.
			row_estimate: (estimates.get(t.name) ?? -1) < 0 ? null : estimates.get(t.name),
			columns: t.columns
		}))
	};
}

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'not_null'] as const;

const filter_schema = z.object({
	column: z.string().max(64),
	op: z.enum(FILTER_OPS),
	value: z.string().max(1024).optional()
});

export const rows_query_schema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	sort: z.string().max(64).optional(),
	dir: z.enum(['asc', 'desc']).default('asc'),
	filters: z.string().max(8192).optional().transform((raw, ctx) => {
		if (!raw) return [];
		const parsed = z.array(filter_schema).max(10).safeParse((() => {
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				return null;
			}
		})());
		if (!parsed.success) {
			ctx.addIssue({ code: 'custom', message: 'filters must be a JSON array of {column, op, value}' });
			return z.NEVER;
		}
		return parsed.data;
	})
});

const escape_like = (s: string) => s.replace(/[\\%_]/gu, m => `\\${m}`);

function filter_sql(meta: TableMeta, f: z.infer<typeof filter_schema>): SQL {
	const info = column_info(meta, f.column);
	if (info.redacted) throw new HttpError(400, 'column cannot be filtered', { column: f.column });
	const ref = meta.refs.get(f.column)!;
	if (f.op === 'is_null') return isNull(ref);
	if (f.op === 'not_null') return isNotNull(ref);
	if (f.value === undefined) throw new HttpError(400, 'filter needs a value', { column: f.column });
	if (f.op === 'contains') return sql`${ref}::text ilike ${`%${escape_like(f.value)}%`}`;
	if (!SCALAR_KINDS.has(info.kind)) throw new HttpError(400, 'only contains and null filters work on this column', { column: f.column });
	// Postgres parses the text as the column's type, so `gt` compares numbers and dates, not strings. The type name comes
	// from the schema, never from the request.
	const value = sql`cast(${f.value} as ${sql.raw(info.sql_type)})`;
	const op = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
	return sql`${ref} ${sql.raw(op)} ${value}`;
}

/** Long strings and JSON are cut in listings; the row endpoint returns them whole for editing. */
const PREVIEW_CHARS = 400;

function serialize_row(meta: TableMeta, row: Record<string, unknown>, truncate: boolean) {
	const out: Record<string, unknown> = {};
	const truncated: string[] = [];
	for (const c of meta.columns) {
		let v = row[meta.keys.get(c.name)!];
		if (c.redacted) v = null;
		else if (Buffer.isBuffer(v)) v = { bytes: v.length };
		else if (truncate && v != null && (c.kind === 'text' || c.kind === 'json' || c.kind === 'array' || c.kind === 'vector')) {
			const text = typeof v === 'string' ? v : JSON.stringify(v);
			if (text.length > PREVIEW_CHARS) {
				v = `${text.slice(0, PREVIEW_CHARS)}…`;
				truncated.push(c.name);
			}
		}
		out[c.name] = v;
	}
	return truncate ? { ...out, _truncated: truncated } : out;
}

function invalid_input(err: unknown): HttpError | null {
	const code = pg_error_code(err);
	// invalid_text_representation, datetime_field_overflow, invalid_datetime_format, numeric_value_out_of_range
	if (code === '22P02' || code === '22008' || code === '22007' || code === '22003') return new HttpError(400, 'filter value does not fit the column type');
	return null;
}

export async function list_rows(name: string, q: z.infer<typeof rows_query_schema>) {
	const meta = table_meta(name);
	const where = q.filters.length ? and(...q.filters.map(f => filter_sql(meta, f))) : undefined;
	const order: SQL[] = [];
	if (q.sort) {
		const info = column_info(meta, q.sort);
		if (info.redacted || !SCALAR_KINDS.has(info.kind)) throw new HttpError(400, 'column cannot be sorted', { column: q.sort });
		order.push(q.dir === 'desc' ? desc(meta.refs.get(q.sort)!) : asc(meta.refs.get(q.sort)!));
	}
	// The key breaks ties, so paging is stable.
	order.push(...meta.primary_key.map(k => asc(meta.refs.get(k)!)));
	let rows: Record<string, unknown>[];
	try {
		rows = await db.select().from(meta.table).where(where).orderBy(...order).limit(q.limit + 1).offset((q.page - 1) * q.limit);
	} catch (err) {
		throw invalid_input(err) ?? err;
	}
	return {
		items: rows.slice(0, q.limit).map(r => serialize_row(meta, r, true)),
		page: q.page,
		limit: q.limit,
		has_more: rows.length > q.limit
	};
}

function parse_key(meta: TableMeta, raw: unknown): Record<string, unknown> {
	if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'key must be an object of primary key values');
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length !== meta.primary_key.length || !meta.primary_key.every(k => Object.hasOwn(raw, k))) {
		throw new HttpError(400, 'key must name exactly the primary key columns', { primary_key: meta.primary_key });
	}
	const key: Record<string, unknown> = {};
	for (const [k, v] of entries) {
		const r = meta.values.get(k)!.safeParse(v);
		if (!r.success || r.data == null) throw new HttpError(400, 'invalid key value', { column: k });
		key[k] = r.data;
	}
	return key;
}

const key_where = (meta: TableMeta, key: Record<string, unknown>) => and(...Object.entries(key).map(([k, v]) => eq(meta.refs.get(k)!, v)));

export async function get_row(name: string, raw_key: unknown) {
	const meta = table_meta(name);
	const key = parse_key(meta, raw_key);
	const [row] = await db.select().from(meta.table).where(key_where(meta, key)) as Record<string, unknown>[];
	if (!row) throw new HttpError(404, 'row not found');
	return serialize_row(meta, row, false);
}

export const row_patch_schema = z.object({
	key: z.record(z.string(), z.unknown()),
	values: z.record(z.string(), z.unknown())
});

function parse_values(meta: TableMeta, raw: Record<string, unknown>): Record<string, unknown> {
	const entries = Object.entries(raw);
	if (entries.length === 0) throw new HttpError(400, 'empty patch');
	const locked = entries.map(([k]) => k).filter(k => !meta.columns.find(c => c.name === k)?.editable);
	if (locked.length) throw new HttpError(400, 'column not editable', { columns: locked });
	const out: Record<string, unknown> = {};
	const issues: unknown[] = [];
	for (const [k, v] of entries) {
		const r = meta.values.get(k)!.safeParse(v);
		if (r.success) out[k] = r.data;
		else issues.push({ column: k, issues: r.error.issues });
	}
	if (issues.length) throw new HttpError(400, 'invalid value', { issues });
	return out;
}

/**
 * Edits one row. Catalog fields with their own rules (service id normalization, backpack clearing, sync events) go
 * through the entity editor; everything else is a plain audited update that bumps `modified_at` for client sync.
 */
export async function update_row(name: string, body: z.infer<typeof row_patch_schema>, admin_id: string) {
	const meta = table_meta(name);
	if (!meta.editable) throw new HttpError(403, 'table is read-only');
	const key = parse_key(meta, body.key);
	const entity = resolve_table(name);
	if (entity && meta.primary_key.length === 1 && Object.keys(body.values).every(k => Object.hasOwn(EDITABLE_COLUMNS[entity], k))) {
		const values = parse_entity_patch(entity, body.values);
		const events = new PendingEvents();
		await db.transaction(tx => admin_update_entity(tx, entity, String(key[meta.primary_key[0]]), values, { admin_id, events }));
		events.flush();
		return get_row(name, key);
	}
	const values = parse_values(meta, body.values);
	if (name === 'users_table' && key.id === admin_id && values.role === 'USER') throw new HttpError(400, 'you cannot remove your own admin role');
	await db.transaction(tx => update_generic(tx, meta, key, values, admin_id));
	if (name === 'users_table') forget_user(String(key.id));
	return get_row(name, key);
}

async function update_generic(tx: Tx, meta: TableMeta, key: Record<string, unknown>, values: Record<string, unknown>, admin_id: string) {
	const where = key_where(meta, key);
	const [before] = await tx.select().from(meta.table).where(where).for('update') as Record<string, unknown>[];
	if (!before) throw new HttpError(404, 'row not found');
	const set: Record<string, unknown> = Object.fromEntries(Object.entries(values).map(([k, v]) => [meta.keys.get(k)!, v]));
	if (meta.keys.has('modified_at')) set[meta.keys.get('modified_at')!] = new Date();
	try {
		await tx.update(meta.table).set(set).where(where);
	} catch (err) {
		const code = pg_error_code(err);
		const detail = pg_error_detail(err);
		if (code === PG_ERRORS.unique_violation) throw new HttpError(409, 'value already exists in another row', { detail });
		if (code === PG_ERRORS.foreign_key_violation) throw new HttpError(400, 'referenced row does not exist', { detail });
		if (code === PG_ERRORS.check_violation) throw new HttpError(400, 'value breaks a table constraint', { detail });
		throw err;
	}
	await write_audit(tx, {
		action: 'admin_table_edit',
		actor: 'admin',
		actor_user_id: admin_id,
		entity_table: meta.name,
		entity_id: Object.values(key).map(String).join(','),
		details: { key, changes: values },
		undo: { table: meta.name, key, values: Object.fromEntries(Object.keys(values).map(k => [k, before[meta.keys.get(k)!] ?? null])) }
	});
}
