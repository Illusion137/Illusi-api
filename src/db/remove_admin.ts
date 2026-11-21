/**
 * Revokes the ADMIN role: `npm run db:remove-admin -- <email>`.
 *
 * The account is kept as a plain USER. Refuses to demote the last admin, which would lock everyone out of the dashboard.
 * Runs on the owner connection (MIGRATE_DATABASE_URL), like add_admin.ts. In production:
 * `docker compose run --rm migrate node --import tsx src/db/remove_admin.ts <email>`.
 */
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { use_compose_owner_url } from './cli_env';
import { create_pool, owner_database_url } from './index';
import { users_table } from './schema';
import { write_audit } from '../core/audit';

use_compose_owner_url();
const db = drizzle({ client: create_pool({ max: 1 }) });

const args_schema = z.tuple([z.email().max(256).transform(e => e.toLowerCase())]);

async function main() {
	if (!owner_database_url()) throw new Error('set MIGRATE_DATABASE_URL, DATABASE_URL or POSTGRES_PASSWORD in .env');
	const parsed = args_schema.safeParse(process.argv.slice(2));
	if (!parsed.success) throw new Error('usage: npm run db:remove-admin -- <email>');
	const [email] = parsed.data;

	const result = await db.transaction(async (tx) => {
		// Locks every admin row so two concurrent demotions can't both pass the last-admin check.
		const admins = await tx.select({ id: users_table.id, email: users_table.email }).from(users_table)
			.where(eq(users_table.role, 'ADMIN')).for('update');
		const target = admins.find(a => a.email === email);
		if (!target) {
			const [{ n }] = await tx.select({ n: count() }).from(users_table).where(eq(users_table.email, email));
			return n ? 'not_admin' : 'missing';
		}
		if (admins.length === 1) return 'last_admin';
		await tx.update(users_table).set({ role: 'USER', modified_at: new Date() }).where(eq(users_table.id, target.id));
		await write_audit(tx, { action: 'admin_user_edit', actor: 'cli', entity_table: 'users_table', entity_id: target.id, details: { changes: { role: 'USER' } }, undo: { role: 'ADMIN' } });
		return 'demoted';
	});

	switch (result) {
		case 'missing': throw new Error(`no account with email ${email}`);
		case 'not_admin': console.log(`${email} is not an admin`); break;
		case 'last_admin': throw new Error(`${email} is the only admin; add another admin first`);
		case 'demoted': console.log(`removed admin role from ${email}`); break;
	}
}

main()
	.catch((err: unknown) => {
		// Drizzle wraps driver errors ("Failed query: ..."); the cause says what actually went wrong.
		console.error(err instanceof Error ? [err.message, err.cause instanceof Error ? err.cause.message || (err.cause as { code?: string }).code : null].filter(Boolean).join(': ') : err);
		process.exitCode = 1;
	})
	.finally(() => db.$client.end());
