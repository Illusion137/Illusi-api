import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run_in_context } from '../../src/core/context';
import type { RequestContext } from '../../src/core/context';
import { db } from '../../src/db';
import { pool, query, unique } from './helpers';

const configured = Boolean(process.env.DATABASE_URL && process.env.MIGRATE_DATABASE_URL && process.env.DATABASE_URL !== process.env.MIGRATE_DATABASE_URL);

const as_user = <T>(user_id: string | undefined, fn: () => Promise<T>, extra: Partial<RequestContext> = {}) =>
	run_in_context({ request_id: 'routing-test', user_id: () => user_id, ...extra }, fn);

const own_titles = async () => (await db.execute<{ title: string }>(sql`select title from playlists_table where title like ${`${prefix}%`} order by title`)).rows.map(r => r.title);
const current_setting = async () => (await db.execute<{ v: string | null }>(sql`select current_setting('app.user_id', true) as v`)).rows[0].v;

const prefix = unique('rp');
const users = [randomUUID(), randomUUID()];

describe.skipIf(!configured)('RoutingPool against Postgres', () => {
	beforeAll(async () => {
		for (const [i, id] of users.entries()) {
			await query('insert into users_table (id, username, email, password_hash) values ($1, $2, $3, $4)', [id, `${prefix}-${i}`, `${prefix}-${i}@example.test`, 'x']);
			await query('insert into playlists_table (user_id, title) values ($1, $2)', [id, `${prefix}-${i}`]);
		}
	});
	afterAll(async () => {
		await query('delete from users_table where id = any($1)', [users]);
		await pool.end();
	});

	it('without a request context the owner sees every row', async () => {
		expect(await own_titles()).toEqual([`${prefix}-0`, `${prefix}-1`]);
	});

	it('with a user the restricted role sees only that user\'s rows', async () => {
		expect(await as_user(users[0], own_titles)).toEqual([`${prefix}-0`]);
		expect(await as_user(users[1], own_titles)).toEqual([`${prefix}-1`]);
	});

	it('a context without a user (login, registration) runs as the owner', async () => {
		expect(await as_user(undefined, own_titles)).toHaveLength(2);
	});

	it('a privileged context bypasses row-level security', async () => {
		expect(await as_user(users[0], own_titles, { privileged: true })).toHaveLength(2);
	});

	it('privilege granted halfway applies to later queries only', async () => {
		const context: RequestContext = { request_id: 'r', user_id: () => users[0] };
		const [before, after] = await run_in_context(context, async () => {
			const first = await own_titles();
			context.privileged = true;
			return [first, await own_titles()];
		});
		expect(before).toHaveLength(1);
		expect(after).toHaveLength(2);
	});

	it('the setting is set inside the request and cleared for the next checkout', async () => {
		expect(await as_user(users[0], current_setting)).toBe(users[0]);
		const seen: (string | null)[] = [];
		for (let i = 0; i < 25; i++) seen.push(await as_user(undefined, async () => (await pool.query<{ v: string | null }>(`select current_setting('app.user_id', true) as v`)).rows[0].v));
		expect(seen.every(v => !v)).toBe(true);
	});

	it('no scoped connection leaks the previous user to another one', async () => {
		const results = await Promise.all(Array.from({ length: 30 }, (_, i) => as_user(users[i % 2], async () => ({ expected: users[i % 2], got: await current_setting(), titles: await own_titles() }))));
		for (const r of results) {
			expect(r.got).toBe(r.expected);
			expect(r.titles).toEqual([`${prefix}-${users.indexOf(r.expected)}`]);
		}
	});

	it('transactions stay on one scoped connection', async () => {
		const titles = await as_user(users[1], async () => await db.transaction(async tx => {
			const first = (await tx.execute<{ title: string }>(sql`select title from playlists_table where title like ${`${prefix}%`}`)).rows;
			const second = await tx.execute<{ v: string }>(sql`select current_setting('app.user_id') as v`);
			expect(second.rows[0].v).toBe(users[1]);
			return first.map(r => r.title);
		}));
		expect(titles).toEqual([`${prefix}-1`]);
	});

	it('writes for another user are refused by the policy', async () => {
		await expect(as_user(users[0], async () => await db.execute(sql`insert into playlists_table (user_id, title) values (${users[1]}, ${`${prefix}-forged`})`))).rejects.toMatchObject({ cause: { code: '42501' } });
		expect(await own_titles()).not.toContain(`${prefix}-forged`);
	});

	it('a failing query still leaves the connection clean', async () => {
		await expect(as_user(users[0], async () => await db.execute(sql`select 1/0`))).rejects.toThrow();
		expect(await as_user(undefined, current_setting)).toBeFalsy();
	});
});
