import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { api, create_user, mock_album, query, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

const app_url = process.env.DATABASE_URL;
const owner_url = process.env.MIGRATE_DATABASE_URL;
const configured = Boolean(app_url && owner_url && app_url !== owner_url);

const app_pool = new pg.Pool({ connectionString: app_url, max: 2 });
afterAll(() => app_pool.end());

/** Runs `fn` on the restricted role with `app.user_id` set, like an authenticated request. */
async function as_user<T>(user_id: string | null, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await app_pool.connect();
	try {
		await client.query('begin');
		if (user_id) await client.query(`select set_config('app.user_id', $1, true)`, [user_id]);
		return await fn(client);
	} finally {
		await client.query('rollback');
		client.release();
	}
}

async function playlist(user: TestUser, opts: { public?: boolean; deleted?: boolean } = {}): Promise<string> {
	const id = uuid();
	await query('insert into playlists_table (id, user_id, title, public, deleted) values ($1, $2, $3, $4, $5)', [id, user.id, unique('pl'), opts.public ?? false, opts.deleted ?? false]);
	return id;
}

describe.skipIf(!configured)('row-level security', () => {
	it('runs the API on a role that is neither superuser nor BYPASSRLS', async () => {
		const [role] = await as_user(null, async c => (await c.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user')).rows);
		expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
		const [tables] = await query<{ missing: string[] }>(`select coalesce(array_agg(c.relname::text), '{}'::text[]) as missing from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname in ('users_table', 'sessions_table', 'playlists_table', 'user_tracks_table', 'track_plays_table', 'export_jobs_table', 'sync_pushes_table', 'email_verifications_table')`);
		expect(tables.missing).toEqual([]);
	});

	it('shows no rows of user-owned tables without a user', async () => {
		const user = await create_user('norows');
		await playlist(user, { public: true });
		for (const table of ['users_table', 'sessions_table', 'playlists_table', 'email_verifications_table', 'export_jobs_table']) {
			expect(await as_user(null, async c => (await c.query(`select 1 from ${table}`)).rowCount), table).toBe(0);
		}
	});

	it('limits a user to their own rows', async () => {
		const [a, b] = [await create_user('rls-a'), await create_user('rls-b')];
		const seen = await as_user(a.id, async c => ({
			users: (await c.query('select id from users_table')).rows.map(r => r.id),
			sessions: (await c.query('select distinct user_id from sessions_table')).rows.map(r => r.user_id)
		}));
		expect(seen.users).toContain(a.id);
		expect(seen.users).not.toContain(b.id);
		expect(seen.sessions).toEqual([a.id]);
	});

	it('hides private playlists and their contents, but shows public ones', async () => {
		const [owner, other] = [await create_user('pl-owner'), await create_user('pl-other')];
		const priv = await playlist(owner);
		const pub = await playlist(owner, { public: true });
		const gone = await playlist(owner, { public: true, deleted: true });
		const seen = await as_user(other.id, async c => (await c.query('select id from playlists_table where user_id = $1', [owner.id])).rows.map(r => r.id));
		expect(seen).toEqual([pub]);
		expect(seen).not.toContain(priv);
		expect(seen).not.toContain(gone);
		expect(await as_user(owner.id, async c => (await c.query('select id from playlists_table where user_id = $1', [owner.id])).rowCount)).toBe(3);
	});

	it('shows the username of someone with a public playlist, and nothing about a user without one', async () => {
		const [host, other, lurker] = [await create_user('host'), await create_user('viewer'), await create_user('lurker')];
		await playlist(host, { public: true });
		const seen = await as_user(other.id, async c => (await c.query('select id from users_table where id = any($1)', [[host.id, lurker.id]])).rows.map(r => r.id));
		expect(seen).toEqual([host.id]);
	});

	it('refuses writes to rows of other users', async () => {
		const [owner, intruder] = [await create_user('w-owner'), await create_user('w-intruder')];
		const id = await playlist(owner, { public: true });
		const updated = await as_user(intruder.id, async c => (await c.query(`update playlists_table set title = 'hijacked' where id = $1`, [id])).rowCount);
		expect(updated).toBe(0);
		const deleted = await as_user(intruder.id, async c => (await c.query('delete from playlists_table where id = $1', [id])).rowCount);
		expect(deleted).toBe(0);
		await expect(as_user(intruder.id, c => c.query('insert into playlists_table (user_id, title) values ($1, $2)', [owner.id, 'forged']))).rejects.toThrow(/row-level security/u);
		await expect(as_user(intruder.id, c => c.query('insert into playlist_tracks_table (playlist_id, track_id) values ($1, $2)', [id, randomUUID()]))).rejects.toThrow(/row-level security/u);
		expect((await query('select title, user_id from playlists_table where id = $1', [id]))[0]).toMatchObject({ user_id: owner.id });
		expect(await as_user(intruder.id, async c => (await c.query('update users_table set username = $2 where id = $1', [owner.id, 'pwned'])).rowCount)).toBe(0);
	});

	it('refuses to read or forge another user\'s sessions and verification links', async () => {
		const [victim, attacker] = [await create_user('victim', { verified: false }), await create_user('attacker')];
		expect(await as_user(attacker.id, async c => (await c.query('select 1 from sessions_table where user_id = $1', [victim.id])).rowCount)).toBe(0);
		expect(await as_user(attacker.id, async c => (await c.query('select 1 from email_verifications_table where user_id = $1', [victim.id])).rowCount)).toBe(0);
		await expect(as_user(attacker.id, c => c.query(
			`insert into email_verifications_table (user_id, email, token_hash, expires_at) values ($1, 'x@example.test', $2, now() + interval '1 hour')`, [victim.id, randomUUID().replaceAll('-', '').padEnd(64, '0')]
		))).rejects.toThrow(/row-level security/u);
	});

	it('cannot be used to change the schema', async () => {
		await expect(as_user(null, c => c.query('create table rls_probe (id int)'))).rejects.toThrow(/permission denied/u);
		await expect(as_user(null, c => c.query('truncate users_table'))).rejects.toThrow(/permission denied/u);
		await expect(as_user(null, c => c.query('alter table users_table disable row level security'))).rejects.toThrow(/must be owner/u);
	});

	it('keeps the API working end to end under the policies', async () => {
		const [owner, other] = [await create_user('e2e-owner'), await create_user('e2e-other')];
		const created = await api('POST', '/contribute', { token: owner.access_token, body: { contribution_id: uuid(), ...mock_album({ artist: unique('A'), album: unique('B'), n: 1 }) } });
		expect(created.status).toBe(200);
		const id = await playlist(owner, { public: true });
		expect((await api('GET', `/playlists/${id}`, { token: other.access_token })).status).toBeLessThan(500);
		const private_id = await playlist(owner);
		expect((await api('GET', `/playlists/${private_id}`, { token: other.access_token })).status).toBe(404);
		expect((await api('GET', `/playlists/${private_id}`, { token: owner.access_token })).status).toBe(200);
	});
});
