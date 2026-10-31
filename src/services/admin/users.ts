import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { sessions_table, users_table, USER_ROLES } from '../../db/schema';
import { write_audit } from '../../core/audit';
import { forget_user } from '../../core/auth/middleware';
import { revoke_all_for_user } from '../../core/auth/sessions';
import { HttpError } from '../../core/http';
import { delete_account } from '../account/delete';

export const users_query_schema = z.object({
	q: z.string().trim().max(256).optional(),
	role: z.enum(USER_ROLES).optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const user_patch_schema = z.object({
	role: z.enum(USER_ROLES).optional(),
	email_verified: z.boolean().optional()
}).refine(p => p.role !== undefined || p.email_verified !== undefined, { message: 'empty patch' });

const escape_like = (s: string) => s.replace(/[\\%_]/gu, m => `\\${m}`);

// Spelled out: drizzle leaves columns unqualified in single-table selects, where `id` would bind to the subquery's table.
const user_id_ref = sql.raw('"users_table"."id"');

const user_columns = {
	id: users_table.id,
	username: users_table.username,
	email: users_table.email,
	role: users_table.role,
	email_verified_at: users_table.email_verified_at,
	created_at: users_table.created_at,
	active_sessions: sql<number>`(select count(*)::int from ${sessions_table} s where s.user_id = ${user_id_ref} and s.revoked_at is null and s.expires_at > now())`,
	last_seen_at: sql<string | null>`(select max(s.last_used_at) from ${sessions_table} s where s.user_id = ${user_id_ref})`
};

export async function list_users(q: z.infer<typeof users_query_schema>) {
	const filters: SQL[] = [];
	if (q.q) {
		const pattern = `%${escape_like(q.q)}%`;
		filters.push(or(ilike(users_table.email, pattern), ilike(users_table.username, pattern), sql`${users_table.id}::text = ${q.q}`)!);
	}
	if (q.role) filters.push(eq(users_table.role, q.role));
	const where = filters.length > 0 ? and(...filters) : undefined;
	const [{ total }] = await db.select({ total: count() }).from(users_table).where(where);
	const items = await db.select(user_columns).from(users_table).where(where)
		.orderBy(desc(users_table.created_at), desc(users_table.id)).limit(q.limit).offset((q.page - 1) * q.limit);
	return { items, total, page: q.page, limit: q.limit, has_more: q.page * q.limit < total };
}

export async function update_user(user_id: string, patch: z.infer<typeof user_patch_schema>, admin_id: string) {
	if (user_id === admin_id && patch.role === 'USER') throw new HttpError(400, 'you cannot remove your own admin role');
	return db.transaction(async (tx) => {
		const [before] = await tx.select({ role: users_table.role, email_verified_at: users_table.email_verified_at })
			.from(users_table).where(eq(users_table.id, user_id)).for('update');
		if (!before) throw new HttpError(404, 'user not found');
		const set: Partial<typeof users_table.$inferInsert> = {};
		if (patch.role !== undefined) set.role = patch.role;
		if (patch.email_verified !== undefined) set.email_verified_at = patch.email_verified ? before.email_verified_at ?? new Date() : null;
		await tx.update(users_table).set({ ...set, modified_at: new Date() }).where(eq(users_table.id, user_id));
		await write_audit(tx, {
			action: 'admin_user_edit',
			actor: 'admin',
			actor_user_id: admin_id,
			entity_table: 'users_table',
			entity_id: user_id,
			details: { changes: patch },
			undo: { role: before.role, email_verified_at: before.email_verified_at }
		});
		forget_user(user_id);
		const [after] = await tx.select(user_columns).from(users_table).where(eq(users_table.id, user_id));
		return after;
	});
}

/** Signs the user out everywhere: refresh tokens stop working, access tokens run out within their TTL. */
export async function revoke_user_sessions(user_id: string, admin_id: string) {
	const [user] = await db.select({ id: users_table.id }).from(users_table).where(eq(users_table.id, user_id));
	if (!user) throw new HttpError(404, 'user not found');
	await revoke_all_for_user(user_id);
	await db.transaction(async (tx) => {
		await write_audit(tx, { action: 'admin_revoke', actor: 'admin', actor_user_id: admin_id, entity_table: 'users_table', entity_id: user_id, details: {} });
	});
}

export async function admin_delete_user(user_id: string, admin_id: string) {
	if (user_id === admin_id) throw new HttpError(400, 'delete your own account from the app instead');
	await delete_account(user_id);
	forget_user(user_id);
	await db.transaction(async (tx) => {
		await write_audit(tx, { action: 'admin_delete', actor: 'admin', actor_user_id: admin_id, entity_table: 'users_table', entity_id: user_id, details: {} });
	});
}
