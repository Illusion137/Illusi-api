import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { query } from './helpers';

const owner_url = process.env.MIGRATE_DATABASE_URL;
const app_url = process.env.DATABASE_URL;
const configured = Boolean(owner_url && app_url && owner_url !== app_url);

/** Imports src/db/migrate.ts afresh (it runs on import) and resolves once it has closed its pool or exited. */
async function run_migrate(env: Record<string, string | undefined> = {}) {
	vi.resetModules();
	const saved = { ...process.env };
	Object.assign(process.env, env);
	for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
	const end = vi.spyOn(pg.Pool.prototype, 'end');
	const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
	const done = new Promise<void>(resolve => {
		end.mockImplementation(function (this: pg.Pool) { resolve(); return Promise.resolve(); });
		exit.mockImplementation((() => { resolve(); }) as never);
	});
	try {
		await import('../../src/db/migrate');
		await done;
		await new Promise(resolve => setTimeout(resolve, 50)); // a failed run exits right after closing its pool
		return { exited: exit.mock.calls.length > 0 };
	} finally {
		end.mockRestore();
		exit.mockRestore();
		process.env = saved;
	}
}

describe.skipIf(!configured)('db/migrate (in-process)', () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it('is idempotent and re-syncs the restricted role with its grants', async () => {
		const role = decodeURIComponent(new URL(app_url!).username);
		const result = await run_migrate();
		expect(result.exited).toBe(false);
		const rows = await query<{ rolbypassrls: boolean; rolsuper: boolean }>('select rolbypassrls, rolsuper from pg_roles where rolname = $1', [role]);
		expect(rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
	});

	it('runs without a separate owner (single role)', async () => {
		const result = await run_migrate({ MIGRATE_DATABASE_URL: owner_url, DATABASE_URL: owner_url });
		expect(result.exited).toBe(false);
	});

	it('refuses a role name that cannot be quoted safely', async () => {
		const bad = new URL(app_url!);
		bad.username = 'Bad-Role';
		const result = await run_migrate({ DATABASE_URL: bad.toString() });
		expect(result.exited).toBe(true);
	});

	it('refuses the same role for owner and app', async () => {
		const same = new URL(app_url!);
		const owner = new URL(owner_url!);
		same.username = owner.username;
		same.password = owner.password;
		same.searchParams.set('application_name', 'other'); // a different URL, so it isn't the single-role setup
		const result = await run_migrate({ DATABASE_URL: same.toString() });
		expect(result.exited).toBe(true);
	});

	it('exits non-zero when a migration cannot be applied', async () => {
		const result = await run_migrate({ MIGRATIONS_DIR: '/nonexistent-migrations-dir' });
		expect(result.exited).toBe(true);
	});

	it('creates the restricted role when it does not exist yet', async () => {
		const fresh = new URL(app_url!);
		fresh.username = 'illusi_migrate_probe';
		fresh.password = 'probe';
		try {
			const result = await run_migrate({ DATABASE_URL: fresh.toString() });
			expect(result.exited).toBe(false);
			const rows = await query('select 1 from pg_roles where rolname = $1', ['illusi_migrate_probe']);
			expect(rows).toHaveLength(1);
		} finally {
			await query('reassign owned by illusi_migrate_probe to current_user').catch(() => undefined);
			await query('drop owned by illusi_migrate_probe').catch(() => undefined);
			await query('drop role if exists illusi_migrate_probe');
		}
	});
});
