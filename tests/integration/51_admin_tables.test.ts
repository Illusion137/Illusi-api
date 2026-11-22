import { beforeAll, describe, expect, it } from 'vitest';
import { api, contribute, create_user, make_admin, mock_album, query, unique } from './helpers';
import type { TestUser } from './helpers';

let admin: TestUser;
let user: TestUser;
let track_id: string;
/** Left alone by the delete tests. */
let kept_track_id: string;

const get = (path: string) => api('GET', path, { token: admin.access_token });
const rows = (table: string, params: Record<string, string> = {}) => get(`/admin/tables/${table}/rows?${new URLSearchParams(params).toString()}`);
const patch = (table: string, body: unknown) => api('PATCH', `/admin/tables/${table}/rows`, { token: admin.access_token, body });

beforeAll(async () => {
	admin = await make_admin(await create_user('tbl'));
	user = await create_user('tbl-user');
	const created = await contribute(user, mock_album({ artist: unique('Tbl Artist'), album: unique('Tbl Album'), n: 2 }));
	track_id = created.body.refs.t0;
	kept_track_id = created.body.refs.t1;
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

describe('admin table browser: insert and delete', () => {
	const insert = (table: string, values: unknown) => api('POST', `/admin/tables/${table}/rows`, { token: admin.access_token, body: { values } });
	const preview = (table: string, key: unknown) => api('POST', `/admin/tables/${table}/delete_preview`, { token: admin.access_token, body: { key } });
	const remove = (table: string, key: unknown) => api('DELETE', `/admin/tables/${table}/rows`, { token: admin.access_token, body: { key } });

	it('marks which tables take inserts and deletes', async () => {
		const tables = new Map<string, any>((await get('/admin/tables')).body.tables.map((t: any) => [t.name, t]));
		expect(tables.get('users_table').insert_blocked).toMatch(/registering/u);
		expect(tables.get('users_table').delete_blocked).toMatch(/Users page/u);
		expect(tables.get('media_table').delete_blocked).toMatch(/track page/u);
		expect(tables.get('audit_log_table').insert_blocked).toMatch(/read-only/u);
		expect(tables.get('track_vectors_table').insert_blocked).toMatch(/embedding/u);
		expect(tables.get('artists_table')).toMatchObject({ insert_blocked: null, delete_blocked: null });
		expect(tables.get('artists_table').columns.find((c: any) => c.name === 'search_name')).toMatchObject({ generated: true, editable: false, insertable: false });
	});

	it('inserts with defaults, audits, and refuses blocked tables and bad rows', async () => {
		// An artist's id is its service_ids row, whose id defaults.
		const ids = await insert('service_ids_table', {});
		expect(ids.status).toBe(201);
		expect(ids.body.illusi_id).toMatch(/^[0-9a-f-]{36}$/u);
		const name = unique('Inserted Artist');
		expect((await insert('artists_table', { id: ids.body.illusi_id, name, search_name: 'x' })).status).toBe(400);
		const res = await insert('artists_table', { id: ids.body.illusi_id, name });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ id: ids.body.illusi_id, name, search_name: expect.any(String) });
		expect(res.body.created_at).toBeTruthy();
		const [audit] = await query(`select * from audit_log_table where action = 'admin_table_insert' and entity_table = 'artists_table' and entity_id = $1`, [res.body.id]);
		expect(audit.undo).toMatchObject({ table: 'artists_table', key: { id: res.body.id }, delete: true });

		expect((await insert('users_table', { username: 'x', email: 'x@example.test' })).status).toBe(403);
		expect((await insert('audit_log_table', { action: 'x', actor: 'x' })).status).toBe(403);
		expect((await insert('artists_table', { created_at: new Date().toISOString(), name: 'x' })).status).toBe(400);
		expect((await insert('artists_table', {})).status).toBe(400);
		expect((await insert('artists_table', { id: res.body.id, name: 'dup' })).status).toBe(409);
		expect((await insert('artists_table', { id: '00000000-0000-4000-8000-000000000000', name: 'orphan' })).status).toBe(409);
	});

	it('previews cascades, deletes, and keeps the row in the audit log', async () => {
		const p = await preview('tracks_table', { id: track_id });
		expect(p.status).toBe(200);
		expect(p.body.blocked).toBe(false);
		expect(p.body.dependents).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'album_tracks_table', action: 'delete', rows: 1 })]));

		const res = await remove('tracks_table', { id: track_id });
		expect(res.status).toBe(204);
		expect(await query('select 1 from tracks_table where id = $1', [track_id])).toHaveLength(0);
		expect(await query('select 1 from album_tracks_table where track_id = $1', [track_id])).toHaveLength(0);
		const [audit] = await query(`select * from audit_log_table where action = 'admin_table_delete' and entity_id = $1`, [track_id]);
		expect(audit.undo.row).toMatchObject({ id: track_id, title: 'Trimmed Title' });

		expect((await remove('tracks_table', { id: track_id })).status).toBe(404);
		expect((await preview('tracks_table', { id: track_id })).status).toBe(404);
		expect((await remove('users_table', { id: user.id })).status).toBe(403);
		expect((await remove('audit_log_table', { id: 1 })).status).toBe(403);
	});

	it('marks foreign keys and previews the row they point at', async () => {
		const tables = new Map<string, any>((await get('/admin/tables')).body.tables.map((t: any) => [t.name, t]));
		const col = (table: string, name: string) => tables.get(table).columns.find((c: any) => c.name === name);
		expect(col('tracks_table', 'album_id').references).toEqual({ table: 'albums_table', column: 'id' });
		expect(col('tracks_table', 'id').references).toEqual({ table: 'service_ids_table', column: 'illusi_id' });
		expect(col('tracks_table', 'title').references).toBeNull();

		const preview = (table: string, key: unknown) => api('POST', `/admin/tables/${table}/preview`, { token: admin.access_token, body: { key } });
		const [track] = await query<{ title: string }>('select title from tracks_table where id = $1', [kept_track_id]);
		const res = await preview('tracks_table', { id: kept_track_id });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ table: 'tracks_table', label: track.title, entity: null });
		expect(res.body.fields.map(([k]: [string]) => k)).not.toContain('search_title');
		// Service ids name the entity they identify.
		expect((await preview('service_ids_table', { illusi_id: kept_track_id })).body).toMatchObject({ label: track.title, entity: { kind: 'track', table: 'tracks_table' } });
		// Secrets stay out of previews too.
		const user_preview = await preview('users_table', { id: user.id });
		expect(user_preview.body.fields.map(([k]: [string]) => k)).not.toContain('password_hash');
		expect((await preview('tracks_table', { id: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
		expect((await preview('tracks_table', { title: 'x' })).status).toBe(400);
		expect((await api('POST', '/admin/tables/tracks_table/preview', { token: user.access_token, body: { key: { id: kept_track_id } } })).status).toBe(403);
	});

	it('hides the merges and splits reconciliation made on its own when asked', async () => {
		const entity = kept_track_id;
		await query(`insert into review_items_table (kind, entity_table, entity_id, dedupe_key) values ('AUTO_MERGE', 'tracks_table', $1, $2), ('LYRICS_PARSE_FAILURE', 'tracks_table', $1, $3)`, [entity, unique('auto'), unique('lyr')]);
		const kinds = async (params: string) => ((await get(`/admin/review?limit=100&sort=age&order=desc&${params}`)).body.items as { kind: string; entity_id: string }[])
			.filter(i => i.entity_id === entity).map(i => i.kind);
		expect(await kinds('')).toEqual(['AUTO_MERGE', 'LYRICS_PARSE_FAILURE']);
		expect(await kinds('hide_auto=true')).toEqual(['LYRICS_PARSE_FAILURE']);
		// An explicit kind wins over the toggle.
		expect(await kinds('hide_auto=true&kind=AUTO_MERGE')).toEqual(['AUTO_MERGE']);
	});
});
