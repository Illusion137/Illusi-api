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
	/** Can be given a value when inserting a row (keys too; managed timestamps, secrets and binary data never). */
	insertable: boolean;
	/** Computed by Postgres; never written. */
	generated: boolean;
	/** Never sent: shown as hidden, not filterable or sortable. */
	redacted: boolean;
	/** The row this value points at, for single-column foreign keys onto another table's primary key. */
	references: { table: string; column: string } | null;
}

interface TableMeta {
	name: string;
	table: PgTable;
	primary_key: string[];
	editable: boolean;
	/** Why rows can't be added or removed here, or null. */
	insert_blocked: string | null;
	delete_blocked: string | null;
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
/** Rows these tables hold need more than a row change: the dedicated tools do the rest. */
const INSERT_BLOCKED: Record<string, string> = {
	users_table: 'Create accounts by registering, or with scripts/admin.sh.',
	media_table: 'Media rows come from uploading a file.'
};
const DELETE_BLOCKED: Record<string, string> = {
	users_table: 'Delete accounts from the Users page: it also erases their personal data and signs them out.',
	media_table: 'Delete media from the track page: it also removes the file from disk.'
};
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

function primary_key_of(table: PgTable): string[] {
	const config = getTableConfig(table);
	return config.primaryKeys[0]?.columns.map(c => c.name) ?? config.columns.filter(c => c.primary).map(c => c.name);
}

function describe_table(table: PgTable): TableMeta {
	const config = getTableConfig(table);
	const primary_key = primary_key_of(table);
	const references = new Map<string, { table: string; column: string }>();
	for (const fk of config.foreignKeys) {
		const ref = fk.reference();
		const target_key = primary_key_of(ref.foreignTable);
		if (ref.columns.length === 1 && target_key.length === 1 && target_key[0] === ref.foreignColumns[0].name) {
			references.set(ref.columns[0].name, { table: getTableConfig(ref.foreignTable).name, column: target_key[0] });
		}
	}
	const editable = !READ_ONLY_TABLES.has(config.name);
	const keys = new Map(Object.entries(getTableColumns(table)).map(([key, c]) => [c.name, key]));
	const refs = new Map<string, Column>();
	const values = new Map<string, z.ZodType>();
	const columns = config.columns.map((c): ColumnInfo => {
		const kind = column_kind(c);
		const redacted = REDACTED_COLUMNS.has(`${config.name}.${c.name}`);
		// Computed by Postgres (search columns): writing one is an error.
		const generated = Boolean(c.generated || c.generatedIdentity?.type === 'always');
		const writable = editable && !redacted && !generated && !MANAGED_COLUMNS.has(c.name) && !READ_ONLY_KINDS.has(kind);
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
			editable: writable && !primary_key.includes(c.name),
			insertable: writable,
			generated,
			redacted,
			references: references.get(c.name) ?? null
		};
	});
	const required = columns.find(c => !c.insertable && !c.nullable && !c.has_default && !c.generated);
	const insert_blocked = !editable
		? 'This table is read-only.'
		: INSERT_BLOCKED[config.name] ?? (required ? `New rows need ${required.name}, which can't be set here.` : null);
	const delete_blocked = !editable ? 'This table is read-only.' : DELETE_BLOCKED[config.name] ?? null;
	return { name: config.name, table, primary_key, editable, insert_blocked, delete_blocked, columns, refs, keys, values };
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
			insert_blocked: t.insert_blocked,
			delete_blocked: t.delete_blocked,
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

/** Columns that name a row, best first: the preview's heading. */
const LABEL_COLUMNS = ['title', 'name', 'full_title', 'username', 'display_name', 'email', 'permalink'];
const PREVIEW_FIELDS = 10;
const PREVIEW_TEXT = 120;

/**
 * A short summary of one row for the hover card on a foreign key: a label and the first few set, readable columns.
 * A service ids row also names the track, album or artist it identifies.
 */
export async function preview_row(name: string, raw_key: unknown) {
	const meta = table_meta(name);
	const key = parse_key(meta, raw_key);
	const [row] = await db.select().from(meta.table).where(key_where(meta, key)) as Record<string, unknown>[];
	if (!row) throw new HttpError(404, 'row not found');
	const out = serialize_row(meta, row, false);
	const label_column = LABEL_COLUMNS.find(c => typeof out[c] === 'string' && meta.columns.some(x => x.name === c && !x.redacted));
	let label = label_column ? String(out[label_column]) : null;
	let entity: { kind: string; table: string } | null = null;
	if (name === 'service_ids_table') {
		const id = String(out.illusi_id);
		for (const [kind, table, column] of [['track', schema.tracks_table, 'title'], ['album', schema.albums_table, 'name'], ['artist', schema.artists_table, 'name']] as const) {
			const [hit] = await db.select().from(table).where(eq(table.id, id)) as Record<string, unknown>[];
			if (hit) {
				label = typeof hit[column] === 'string' ? hit[column] : null;
				entity = { kind, table: getTableConfig(table).name };
				break;
			}
		}
	}
	const fields: [string, unknown][] = [];
	for (const c of meta.columns) {
		if (fields.length >= PREVIEW_FIELDS) break;
		const v = out[c.name];
		if (v == null || c.redacted || c.generated || c.name === label_column || (!SCALAR_KINDS.has(c.kind) && c.kind !== 'array')) continue;
		const text = typeof v === 'string' ? v : JSON.stringify(v);
		fields.push([c.name, text.length > PREVIEW_TEXT ? `${text.slice(0, PREVIEW_TEXT)}…` : v]);
	}
	return { table: name, key, label, entity, fields };
}

export const row_patch_schema = z.object({
	key: z.record(z.string(), z.unknown()),
	values: z.record(z.string(), z.unknown())
});

function parse_values(meta: TableMeta, raw: Record<string, unknown>, mode: 'edit' | 'insert'): Record<string, unknown> {
	const entries = Object.entries(raw);
	if (entries.length === 0 && mode === 'edit') throw new HttpError(400, 'empty patch');
	const flag = mode === 'edit' ? 'editable' : 'insertable';
	const locked = entries.map(([k]) => k).filter(k => !meta.columns.find(c => c.name === k)?.[flag]);
	if (locked.length) throw new HttpError(400, `column not `, { columns: locked });
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
	const values = parse_values(meta, body.values, 'edit');
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
		throw constraint_error(err) ?? err;
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

/** A constraint the change broke, as the 4xx the dashboard shows; null for anything else. */
function constraint_error(err: unknown, foreign_key_message = 'referenced row does not exist'): HttpError | null {
	const code = pg_error_code(err);
	const detail = pg_error_detail(err);
	if (code === PG_ERRORS.unique_violation) return new HttpError(409, 'value already exists in another row', { detail });
	if (code === PG_ERRORS.foreign_key_violation) return new HttpError(409, foreign_key_message, { detail });
	if (code === PG_ERRORS.check_violation) return new HttpError(400, 'value breaks a table constraint', { detail });
	// not_null_violation
	if (code === '23502') return new HttpError(400, 'a required column has no value', { detail });
	return null;
}

const row_key = (meta: TableMeta, row: Record<string, unknown>) => Object.fromEntries(meta.primary_key.map(k => [k, row[meta.keys.get(k)!]]));

export const row_insert_schema = z.object({ values: z.record(z.string(), z.unknown()) });

/** Adds a row. Columns left out take their defaults (generated ids, timestamps); the database enforces the rest. */
export async function insert_row(name: string, body: z.infer<typeof row_insert_schema>, admin_id: string) {
	const meta = table_meta(name);
	if (meta.insert_blocked) throw new HttpError(403, meta.insert_blocked);
	const values = parse_values(meta, body.values, 'insert');
	const row = Object.fromEntries(Object.entries(values).map(([k, v]) => [meta.keys.get(k)!, v]));
	const key = await db.transaction(async (tx) => {
		let created: Record<string, unknown>;
		try {
			[created] = await tx.insert(meta.table).values(row).returning() as Record<string, unknown>[];
		} catch (err) {
			throw constraint_error(err) ?? err;
		}
		const key = row_key(meta, created);
		await write_audit(tx, {
			action: 'admin_table_insert',
			actor: 'admin',
			actor_user_id: admin_id,
			entity_table: meta.name,
			entity_id: Object.values(key).map(String).join(','),
			details: { key, values },
			undo: { table: meta.name, key, delete: true }
		});
		return key;
	});
	return get_row(name, key);
}

interface ChildRef {
	child: TableMeta;
	columns: Column[];
	parent_columns: Column[];
	on_delete: string;
}

/** Foreign keys pointing at each table, for showing what a delete takes with it. */
const CHILDREN = new Map<string, ChildRef[]>();
for (const meta of TABLES.values()) {
	for (const fk of getTableConfig(meta.table).foreignKeys) {
		const ref = fk.reference();
		const parent = getTableConfig(ref.foreignTable).name;
		if (!CHILDREN.has(parent)) CHILDREN.set(parent, []);
		CHILDREN.get(parent)!.push({ child: meta, columns: ref.columns, parent_columns: ref.foreignColumns, on_delete: fk.onDelete ?? 'no action' });
	}
}

const tuple = (columns: Column[]) => columns.length === 1 ? sql`${columns[0]}` : sql`(${sql.join(columns.map(c => sql`${c}`), sql`, `)})`;

/** Cascades stop here; a deeper chain is still deleted by Postgres, just not counted. */
const MAX_CASCADE_DEPTH = 4;

export interface Dependent { table: string; action: 'delete' | 'unlink' | 'blocks'; rows: number }

/** Counts the rows a delete would remove (cascades, followed a few levels), unlink (set null) or be refused by. */
async function count_dependents(meta: TableMeta, where: SQL, depth: number, path: Set<string>, out: Map<string, Dependent>) {
	for (const ref of CHILDREN.get(meta.name) ?? []) {
		if (ref.child.name === meta.name || path.has(ref.child.name)) continue;
		const child_where = sql`${tuple(ref.columns)} in (select ${tuple(ref.parent_columns)} from ${meta.table} where ${where})`;
		const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(ref.child.table).where(child_where);
		if (n === 0) continue;
		const action = ref.on_delete === 'cascade' ? 'delete' : ref.on_delete === 'set null' || ref.on_delete === 'set default' ? 'unlink' : 'blocks';
		const id = `${ref.child.name}:${action}`;
		out.set(id, { table: ref.child.name, action, rows: (out.get(id)?.rows ?? 0) + n });
		if (action === 'delete' && depth < MAX_CASCADE_DEPTH) await count_dependents(ref.child, child_where, depth + 1, new Set([...path, ref.child.name]), out);
	}
}

export async function preview_delete(name: string, raw_key: unknown) {
	const meta = table_meta(name);
	if (meta.delete_blocked) throw new HttpError(403, meta.delete_blocked);
	const key = parse_key(meta, raw_key);
	const where = key_where(meta, key)!;
	const [exists] = await db.select({ n: sql<number>`1` }).from(meta.table).where(where);
	if (!exists) throw new HttpError(404, 'row not found');
	const out = new Map<string, Dependent>();
	await count_dependents(meta, where, 1, new Set([meta.name]), out);
	const dependents = [...out.values()].sort((a, b) => b.rows - a.rows);
	return {
		dependents,
		blocked: dependents.some(d => d.action === 'blocks'),
		// Synced tables mark deletions with a flag so clients hear about them; removing the row skips that.
		soft_delete_column: meta.keys.has('deleted') ? 'deleted' : null
	};
}

/** Deletes a row (Postgres cascades the rest) and keeps the whole row in the audit log. */
export async function delete_row(name: string, raw_key: unknown, admin_id: string) {
	const meta = table_meta(name);
	if (meta.delete_blocked) throw new HttpError(403, meta.delete_blocked);
	const key = parse_key(meta, raw_key);
	await db.transaction(async (tx) => {
		let deleted: Record<string, unknown> | undefined;
		try {
			[deleted] = await tx.delete(meta.table).where(key_where(meta, key)).returning() as Record<string, unknown>[];
		} catch (err) {
			throw constraint_error(err, 'other rows still reference this row') ?? err;
		}
		if (!deleted) throw new HttpError(404, 'row not found');
		await write_audit(tx, {
			action: 'admin_table_delete',
			actor: 'admin',
			actor_user_id: admin_id,
			entity_table: meta.name,
			entity_id: Object.values(key).map(String).join(','),
			details: { key },
			undo: { table: meta.name, key, row: serialize_row(meta, deleted, false) }
		});
	});
}
