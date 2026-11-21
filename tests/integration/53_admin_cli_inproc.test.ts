import readline from 'node:readline';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create_user, query, unique } from './helpers';

/**
 * Imports a CLI script afresh (it runs on import) with the given arguments and env, and resolves once it has closed
 * its pool. Returns what it printed and whether it failed.
 */
async function run_cli(script: 'add_admin' | 'remove_admin', args: string[], env: Record<string, string | undefined> = {}) {
	vi.resetModules();
	const saved_env = { ...process.env };
	const saved_argv = process.argv;
	Object.assign(process.env, env);
	for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
	process.argv = ['node', script, ...args];
	const output: string[] = [];
	const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });
	const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });
	const real_end = pg.Pool.prototype.end;
	const end = vi.spyOn(pg.Pool.prototype, 'end');
	const done = new Promise<void>(resolve => {
		end.mockImplementation(function (this: pg.Pool) { resolve(); return real_end.call(this); });
	});
	try {
		await import(`../../src/db/${script}`);
		await done;
		return { failed: process.exitCode === 1, output: output.join('\n') };
	} finally {
		end.mockRestore();
		log.mockRestore();
		error.mockRestore();
		process.argv = saved_argv;
		process.env = saved_env;
		process.exitCode = undefined;
	}
}

/** A terminal that answers each prompt in turn, for the interactive password prompt. */
function fake_terminal(answers: string[]) {
	const stdin = process.stdin as { isTTY?: boolean };
	const was_tty = stdin.isTTY;
	stdin.isTTY = true;
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(readline, 'createInterface').mockImplementation(() => {
		const rl = {
			_writeToOutput: (_s: string) => undefined,
			question(question: string, cb: (answer: string) => void) {
				rl._writeToOutput(question);
				rl._writeToOutput('*'); // a keystroke: not echoed
				cb(answers.shift() ?? '');
			},
			close: () => undefined
		};
		return rl as unknown as readline.Interface;
	});
	return () => { stdin.isTTY = was_tty; };
}

const role_of = async (email: string) => (await query<{ role: string; verified: boolean }>(
	`select role::text, email_verified_at is not null as verified from users_table where email = $1`, [email]))[0];
const audits = (email: string, action: string) => query(
	`select 1 from audit_log_table a join users_table u on u.id::text = a.entity_id where u.email = $1 and a.action = $2 and a.actor = 'cli'`, [email, action]);

describe('db/add_admin and db/remove_admin (in-process)', () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it('creates a verified admin, then leaves an existing admin alone', async () => {
		const email = `${unique('cli-admin')}@example.test`;
		const created = await run_cli('add_admin', [email.toUpperCase(), 'cli admin'], { ADMIN_PASSWORD: 'long-enough-password' });
		expect(created).toEqual({ failed: false, output: `created admin ${email}` });
		expect(await role_of(email)).toEqual({ role: 'ADMIN', verified: true });
		expect(await audits(email, 'admin_user_create')).toHaveLength(1);
		expect(await run_cli('add_admin', [email])).toEqual({ failed: false, output: `${email} is already an admin` });
	});

	it('promotes an existing user and demotes them again', async () => {
		const user = await create_user('cli-promote');
		expect(await run_cli('add_admin', [user.email])).toEqual({ failed: false, output: `promoted ${user.email} to admin` });
		expect((await role_of(user.email)).role).toBe('ADMIN');
		expect(await run_cli('remove_admin', [user.email])).toEqual({ failed: false, output: `removed admin role from ${user.email}` });
		expect((await role_of(user.email)).role).toBe('USER');
		expect(await audits(user.email, 'admin_user_edit')).toHaveLength(2);
		expect(await run_cli('remove_admin', [user.email])).toEqual({ failed: false, output: `${user.email} is not an admin` });
	});

	it('prompts for the password in a terminal and checks the repeat', async () => {
		const email = `${unique('cli-prompt')}@example.test`;
		let restore = fake_terminal(['typed-password', 'typed-password']);
		expect(await run_cli('add_admin', [email], { ADMIN_PASSWORD: undefined })).toEqual({ failed: false, output: `created admin ${email}` });
		restore();
		vi.restoreAllMocks();
		const other = `${unique('cli-prompt')}@example.test`;
		restore = fake_terminal(['typed-password', 'different-one']);
		expect(await run_cli('add_admin', [other], { ADMIN_PASSWORD: undefined })).toEqual({ failed: true, output: 'passwords do not match' });
		restore();
		expect(await role_of(other)).toBeUndefined();
	});

	it('refuses bad input', async () => {
		const email = `${unique('cli-bad')}@example.test`;
		expect(await run_cli('add_admin', ['not-an-email'])).toMatchObject({ failed: true, output: expect.stringContaining('usage: npm run db:add-admin') });
		expect(await run_cli('add_admin', [email], { ADMIN_PASSWORD: 'short' })).toEqual({ failed: true, output: 'password must be 8 to 1024 characters' });
		const stdin = process.stdin as { isTTY?: boolean };
		const was_tty = stdin.isTTY;
		stdin.isTTY = false;
		expect(await run_cli('add_admin', [email], { ADMIN_PASSWORD: undefined })).toMatchObject({ failed: true, output: expect.stringContaining('no password') });
		stdin.isTTY = was_tty;
		expect(await run_cli('add_admin', [email], { MIGRATE_DATABASE_URL: undefined, DATABASE_URL: undefined, POSTGRES_PASSWORD: undefined })).toMatchObject({ failed: true, output: expect.stringContaining('set MIGRATE_DATABASE_URL') });
		expect(await run_cli('remove_admin', [])).toMatchObject({ failed: true, output: expect.stringContaining('usage: npm run db:remove-admin') });
		expect(await run_cli('remove_admin', [email])).toEqual({ failed: true, output: `no account with email ${email}` });
		expect(await run_cli('remove_admin', [email], { MIGRATE_DATABASE_URL: undefined, DATABASE_URL: undefined, POSTGRES_PASSWORD: undefined })).toMatchObject({ failed: true, output: expect.stringContaining('set MIGRATE_DATABASE_URL') });
		expect(await role_of(email)).toBeUndefined();
	});

	it('reports the cause of a database error', async () => {
		const bad = new URL(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL!);
		bad.password = 'wrong-password';
		const out = await run_cli('remove_admin', [`${unique('cli-db')}@example.test`], { MIGRATE_DATABASE_URL: bad.toString() });
		expect(out).toMatchObject({ failed: true, output: expect.stringContaining('password authentication failed') });
	});

	it('will not demote the last admin', async () => {
		// Files run one at a time, so the other files' admins can step aside for this test.
		const others = await query<{ id: string }>(`update users_table set role = 'USER' where role = 'ADMIN' returning id`);
		try {
			const user = await create_user('cli-last');
			await query(`update users_table set role = 'ADMIN' where id = $1`, [user.id]);
			expect(await run_cli('remove_admin', [user.email])).toEqual({ failed: true, output: `${user.email} is the only admin; add another admin first` });
			expect((await role_of(user.email)).role).toBe('ADMIN');
		} finally {
			await query(`update users_table set role = 'ADMIN' where id = any($1::uuid[])`, [others.map(o => o.id)]);
		}
	});

	it('builds the owner URL from a compose .env', async () => {
		const { use_compose_owner_url } = await import('../../src/db/cli_env');
		const saved = { ...process.env };
		try {
			delete process.env.MIGRATE_DATABASE_URL;
			delete process.env.DATABASE_URL;
			delete process.env.POSTGRES_PASSWORD;
			use_compose_owner_url();
			expect(process.env.MIGRATE_DATABASE_URL).toBeUndefined();
			Object.assign(process.env, { POSTGRES_PASSWORD: 'p@ss/word', POSTGRES_USER: '', POSTGRES_DB: '' });
			use_compose_owner_url();
			expect(process.env.MIGRATE_DATABASE_URL).toBe('postgres://illusi:p%40ss%2Fword@127.0.0.1:5432/illusi');
			process.env.POSTGRES_USER = 'owner';
			process.env.POSTGRES_DB = 'db';
			delete process.env.MIGRATE_DATABASE_URL;
			use_compose_owner_url();
			expect(process.env.MIGRATE_DATABASE_URL).toBe('postgres://owner:p%40ss%2Fword@127.0.0.1:5432/db');
			process.env.MIGRATE_DATABASE_URL = 'postgres://already/set';
			use_compose_owner_url();
			expect(process.env.MIGRATE_DATABASE_URL).toBe('postgres://already/set');
		} finally {
			process.env = saved;
		}
	});
});
