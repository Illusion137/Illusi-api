/**
 * Grants the ADMIN role: `npm run db:add-admin -- <email> [username]`.
 *
 * An existing account is promoted as is. Otherwise a verified account is created with the password from ADMIN_PASSWORD,
 * or typed at the prompt. Runs on the owner connection (MIGRATE_DATABASE_URL), since row-level security hides other
 * users' rows from DATABASE_URL. In production: `docker compose run --rm migrate node --import tsx src/db/add_admin.ts <email>`.
 */
import readline from 'node:readline';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { use_compose_owner_url } from './cli_env';
import { create_pool, owner_database_url } from './index';
import { users_table } from './schema';
import { write_audit } from '../core/audit';

use_compose_owner_url();
const db = drizzle({ client: create_pool({ max: 1 }) });

const args_schema = z.tuple([
	z.email().max(256).transform(e => e.toLowerCase()),
	z.string().trim().min(1).max(64).optional()
]);

function prompt_password(question: string): Promise<string> {
	if (!process.stdin.isTTY) throw new Error('no password: set ADMIN_PASSWORD or run in a terminal');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	// Echo the prompt only, not the keystrokes.
	(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
		if (s.includes(question) || s.includes('\n')) process.stdout.write(s);
	};
	return new Promise(resolve => rl.question(question, (answer) => {
		rl.close();
		process.stdout.write('\n');
		resolve(answer);
	}));
}

async function new_password(): Promise<string> {
	const password = process.env.ADMIN_PASSWORD ?? await prompt_password('Password: ');
	if (password.length < 8 || password.length > 1024) throw new Error('password must be 8 to 1024 characters');
	if (process.env.ADMIN_PASSWORD === undefined && password !== await prompt_password('Repeat password: ')) throw new Error('passwords do not match');
	return password;
}

async function main() {
	if (!owner_database_url()) throw new Error('set MIGRATE_DATABASE_URL, DATABASE_URL or POSTGRES_PASSWORD in .env');
	const parsed = args_schema.safeParse(process.argv.slice(2));
	if (!parsed.success) throw new Error('usage: npm run db:add-admin -- <email> [username]');
	const [email, username] = parsed.data;

	const [existing] = await db.select({ id: users_table.id, role: users_table.role }).from(users_table).where(eq(users_table.email, email));
	if (existing?.role === 'ADMIN') {
		console.log(`${email} is already an admin`);
		return;
	}

	const password_hash = existing ? null : await argon2.hash(await new_password(), { type: argon2.argon2id });
	await db.transaction(async (tx) => {
		if (existing) {
			await tx.update(users_table).set({ role: 'ADMIN', modified_at: new Date() }).where(eq(users_table.id, existing.id));
			await write_audit(tx, { action: 'admin_user_edit', actor: 'cli', entity_table: 'users_table', entity_id: existing.id, details: { changes: { role: 'ADMIN' } }, undo: { role: existing.role } });
			return;
		}
		const [user] = await tx.insert(users_table)
			.values({ username: username ?? email.split('@')[0].slice(0, 64), email, password_hash: password_hash!, role: 'ADMIN', email_verified_at: new Date() })
			.returning({ id: users_table.id });
		await write_audit(tx, { action: 'admin_user_create', actor: 'cli', entity_table: 'users_table', entity_id: user.id, details: { email, role: 'ADMIN' } });
	});
	console.log(existing ? `promoted ${email} to admin` : `created admin ${email}`);
}

main()
	.catch((err: unknown) => {
		// Drizzle wraps driver errors ("Failed query: ..."); the cause says what actually went wrong.
		console.error(err instanceof Error ? [err.message, err.cause instanceof Error ? err.cause.message || (err.cause as { code?: string }).code : null].filter(Boolean).join(': ') : err);
		process.exitCode = 1;
	})
	.finally(() => db.$client.end());
