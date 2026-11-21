import { beforeAll, describe, expect, it } from 'vitest';
import { api, contribute, create_user, make_admin, mock_album, query, unique } from './helpers';
import type { TestUser } from './helpers';

let admin: TestUser;
let user: TestUser;
let track_id: string;

const get = (path: string) => api('GET', path, { token: admin.access_token });
const rows = (table: string, params: Record<string, string> = {}) => get(`/admin/tables/${table}/rows?${new URLSearchParams(params).toString()}`);
const patch = (table: string, body: unknown) => api('PATCH', `/admin/tables/${table}/rows`, { token: admin.access_token, body });

beforeAll(async () => {
	admin = await make_admin(await create_user('tbl'));
	user = await create_user('tbl-user');
	const created = await contribute(user, mock_album({ artist: unique('Tbl Artist'), album: unique('Tbl Album'), n: 2 }));
	track_id = created.body.refs.t0;
});

describe('admin table browser', () => {
	it('is admin only', async () => {
		expect((await api('GET', '/admin/tables', { token: user.access_token })).status).toBe(403);
		expect((await api('GET', '/admin/tables/users_table/rows', { token: user.access_token })).status).toBe(403);
	});

	it('lists every table with column metadata, hiding secrets and locking keys', async () => {
		const res = await get('/admin/tables');
		expect(res.status).toBe(200);
		const tables = new Map<string, any>(res.body.tables.map((t: any) => [t.name, t]));
		expect(tables.size).toBeGreaterThan(50);
		const users = tables.get('users_table');
		const col = (name: string) => users.columns.find((c: any) => c.name === name);
		expect(users.primary_key).toEqual(['id']);
		expect(col('password_hash')).toMatchObject({ redacted: true, editable: false });
		expect(col('id')).toMatchObject({ primary_key: true, editable: false, kind: 'uuid' });
		expect(col('created_at')).toMatchObject({ editable: false, kind: 'timestamp' });
		expect(col('role')).toMatchObject({ editable: true, kind: 'enum', enum_values: ['USER', 'ADMIN'] });
		expect(tables.get('audit_log_table').editable).toBe(false);
		expect(tables.get('playlist_tracks_table').primary_key).toEqual(['playlist_id', 'track_id']);
	});

	it('pages, sorts and filters rows without sending secrets', async () => {
		const res = await rows('users_table', { filters: JSON.stringify([{ column: 'email', op: 'eq', value: admin.email }]) });
		expect(res.status).toBe(200);
		expect(res.body.items).toHaveLength(1);
		expect(res.body.items[0]).toMatchObject({ id: admin.id, email: admin.email, role: 'ADMIN', password_hash: null });

		const page = await rows('users_table', { limit: '1', sort: 'created_at', dir: 'desc' });
		expect(page.body.items).toHaveLength(1);
		expect(page.body.has_more).toBe(true);

		const contains = await rows('tracks_table', { filters: JSON.stringify([{ column: 'id', op: 'eq', value: track_id }, { column: 'duration_ms', op: 'not_null' }]) });
		expect(contains.body.items.map((r: any) => r.id)).toEqual([track_id]);
	});

	it('rejects bad queries', async () => {
		expect((await rows('nope_table')).status).toBe(404);
		expect((await rows('users_table', { sort: 'password_hash' })).status).toBe(400);
		expect((await rows('users_table', { filters: JSON.stringify([{ column: 'password_hash', op: 'contains', value: 'a' }]) })).status).toBe(400);
		expect((await rows('users_table', { filters: 'not json' })).status).toBe(400);
		expect((await rows('users_table', { filters: JSON.stringify([{ column: 'created_at', op: 'gt', value: 'yesterday-ish' }]) })).status).toBe(400);
		expect((await rows('tracks_table', { filters: JSON.stringify([{ column: 'title', op: 'contains', value: "'; drop table tracks_table; --" }]) })).status).toBe(200);
	});

	it('reads one full row by key', async () => {
		const res = await api('POST', '/admin/tables/users_table/row', { token: admin.access_token, body: { key: { id: user.id } } });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: user.id, password_hash: null });
		expect((await api('POST', '/admin/tables/users_table/row', { token: admin.access_token, body: { key: { email: user.email } } })).status).toBe(400);
	});

	it('edits a row, bumps modified_at and writes the audit log with undo values', async () => {
		const before = (await query('select username, modified_at from users_table where id = $1', [user.id]))[0];
		const res = await patch('users_table', { key: { id: user.id }, values: { username: 'renamed-by-admin' } });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: user.id, username: 'renamed-by-admin', password_hash: null });
		const after = (await query('select username, modified_at from users_table where id = $1', [user.id]))[0];
		expect(after.username).toBe('renamed-by-admin');
		expect(after.modified_at.getTime()).toBeGreaterThan(before.modified_at.getTime());
		const [audit] = await query(`select * from audit_log_table where action = 'admin_table_edit' and entity_id = $1 order by id desc limit 1`, [user.id]);
		expect(audit).toMatchObject({ actor: 'admin', actor_user_id: admin.id, entity_table: 'users_table' });
		expect(audit.undo).toMatchObject({ table: 'users_table', key: { id: user.id }, values: { username: before.username } });
	});

	it('routes catalog fields through the entity editor', async () => {
		const res = await patch('tracks_table', { key: { id: track_id }, values: { title: '  Trimmed Title  ' } });
		expect(res.status).toBe(200);
		expect(res.body.title).toBe('Trimmed Title');
		const [audit] = await query(`select action from audit_log_table where entity_id = $1 order by id desc limit 1`, [track_id]);
		expect(audit.action).toBe('admin_edit');
	});

	it('refuses edits to locked columns, read-only tables, bad values and self-demotion', async () => {
		expect((await patch('users_table', { key: { id: user.id }, values: { password_hash: 'x' } })).status).toBe(400);
		expect((await patch('users_table', { key: { id: user.id }, values: { id: user.id } })).status).toBe(400);
		expect((await patch('users_table', { key: { id: user.id }, values: { created_at: new Date().toISOString() } })).status).toBe(400);
		expect((await patch('users_table', { key: { id: user.id }, values: { role: 'OWNER' } })).status).toBe(400);
		expect((await patch('users_table', { key: { id: user.id }, values: {} })).status).toBe(400);
		expect((await patch('audit_log_table', { key: { id: 1 }, values: { action: 'x' } })).status).toBe(403);
		expect((await patch('users_table', { key: { id: admin.id }, values: { role: 'USER' } })).status).toBe(400);
		expect((await patch('users_table', { key: { id: '00000000-0000-4000-8000-000000000000' }, values: { username: 'x' } })).status).toBe(404);
		expect((await patch('users_table', { key: { id: user.id }, values: { email: admin.email } })).status).toBe(409);
	});
});
