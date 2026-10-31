import { beforeAll, describe, expect, it } from 'vitest';
import { api, contribute, create_user, make_admin, mock_album, query, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

let admin: TestUser;
let user: TestUser;
let track_id: string;
let artist_id: string;

const expect_error = (res: { status: number; body: any }, status: number, message?: string) => {
	expect(res.status).toBe(status);
	expect(typeof res.body.error).toBe('string');
	if (message) expect(res.body.error).toBe(message);
};

const patch = (table: string, id: string, body: unknown) => api('PATCH', `/admin/entities/${table}/${id}`, { token: admin.access_token, body });

beforeAll(async () => {
	admin = await make_admin(await create_user('adm'));
	user = await create_user('adm-user');
	const created = await contribute(user, mock_album({ artist: unique('Adm Artist'), album: unique('Adm Album'), n: 1 }));
	track_id = created.body.refs.t0;
	artist_id = created.body.refs.ar;
});

describe('admin access', () => {
	it('answers 401 without a token and 403 for non-admins on every route', async () => {
		const routes: [string, string][] = [['GET', '/admin/review'], ['POST', '/admin/review/1/apply'], ['POST', '/admin/review/1/dismiss'], ['PATCH', `/admin/entities/tracks/${track_id}`]];
		for (const [method, path] of routes) {
			expect_error(await api(method, path), 401, 'missing access token');
			expect_error(await api(method, path, { token: user.access_token, ...method === 'GET' ? {} : { body: {} } }), 403, 'admin only');
		}
	});

	it('does not leak admin routes to unknown paths', async () => {
		expect_error(await api('GET', '/admin/nothing', { token: user.access_token }), 403, 'admin only');
		expect_error(await api('GET', '/admin/nothing', { token: admin.access_token }), 404);
	});
});

describe('admin review validation', () => {
	it('rejects bad list queries with issues', async () => {
		for (const q of ['status=NOPE', 'kind=NOPE', 'sort=newest', 'order=up', 'page=0', 'page=x', 'limit=0', 'limit=101', `entity_table=${'a'.repeat(65)}`]) {
			const res = await api('GET', `/admin/review?${q}`, { token: admin.access_token });
			expect_error(res, 400, 'invalid query');
			expect(Array.isArray(res.body.issues)).toBe(true);
		}
	});

	it('lists with defaults and pages', async () => {
		const res = await api('GET', '/admin/review?limit=1&page=1', { token: admin.access_token });
		expect(res.status).toBe(200);
		expect(res.body.items.length).toBeLessThanOrEqual(1);
		expect((await api('GET', '/admin/review?page=100000&sort=age&order=desc&status=DISMISSED', { token: admin.access_token })).body.items).toEqual([]);
	});

	it('rejects bad review ids', async () => {
		for (const id of ['abc', '0', '-1', '1.5']) {
			expect_error(await api('POST', `/admin/review/${id}/apply`, { token: admin.access_token, body: {} }), 400, 'invalid review item id');
			expect_error(await api('POST', `/admin/review/${id}/dismiss`, { token: admin.access_token }), 400, 'invalid review item id');
		}
	});

	it('answers 404 for an unknown review item', async () => {
		expect_error(await api('POST', '/admin/review/2000000000/apply', { token: admin.access_token, body: {} }), 404, 'review item not found');
		expect_error(await api('POST', '/admin/review/2000000000/dismiss', { token: admin.access_token }), 404, 'review item not found');
	});

	it('rejects a malformed apply body', async () => {
		for (const body of [{ proposal_index: -1 }, { proposal_index: 'x' }, { proposal_index: 1.5 }]) {
			expect_error(await api('POST', '/admin/review/1/apply', { token: admin.access_token, body }), 400, 'invalid body');
		}
	});

	it('dismisses an open item once and then answers 409', async () => {
		const [item] = await query(`insert into review_items_table (kind, entity_table, entity_id, field, dedupe_key) values ('FIELD_CONFLICT', 'tracks_table', $1, 'duration_ms', $2) returning id`, [track_id, unique('dedupe')]);
		const first = await api('POST', `/admin/review/${item.id}/dismiss`, { token: admin.access_token });
		expect(first.status).toBe(200);
		expect_error(await api('POST', `/admin/review/${item.id}/dismiss`, { token: admin.access_token }), 409, 'review item is already DISMISSED');
		expect_error(await api('POST', `/admin/review/${item.id}/apply`, { token: admin.access_token, body: {} }), 409, 'review item is already DISMISSED');
	});
});

describe('admin entity patch validation', () => {
	it('answers 404 for unknown or non-editable tables', async () => {
		for (const table of ['users', 'users_table', 'playlists', 'nope']) {
			expect_error(await patch(table, track_id, { title: 'x' }), 404, 'unknown or non-editable table');
		}
	});

	it('rejects a malformed id', async () => {
		expect_error(await patch('tracks', 'nope', { title: 'x' }), 400, 'invalid id');
	});

	it('answers 404 for an unknown entity', async () => {
		expect_error(await patch('tracks', uuid(), { title: 'x' }), 404, 'entity not found');
	});

	it('rejects non-object and empty patches', async () => {
		expect_error(await api('PATCH', `/admin/entities/tracks/${track_id}`, { token: admin.access_token }), 400, 'patch must be an object');
		expect_error(await patch('tracks', track_id, []), 400, 'patch must be an object');
		expect_error(await api('PATCH', `/admin/entities/tracks/${track_id}`, { token: admin.access_token, headers: { 'content-type': 'application/json' }, raw: '"x"' }), 400);
		expect_error(await patch('tracks', track_id, {}), 400, 'empty patch');
	});

	it('rejects columns that are not editable and lists the editable ones', async () => {
		const res = await patch('tracks', track_id, { id: uuid(), created_at: '2020-01-01', title: 'ok' });
		expect_error(res, 400, 'column not editable');
		expect(res.body.columns.sort()).toEqual(['created_at', 'id']);
		expect(res.body.editable).toContain('title');
		expect_error(await patch('tracks', track_id, { __proto__x: 1 }), 400, 'column not editable');
		expect_error(await patch('tracks', track_id, { toString: 1 }), 400, 'column not editable');
	});

	it('rejects invalid values per column', async () => {
		for (const body of [{ title: '' }, { title: '  ' }, { title: 'x'.repeat(257) }, { duration_ms: -1 }, { duration_ms: 1.5 }, { explicit: 'yes' }, { album_id: 'nope' }, { imported: null }]) {
			const res = await patch('tracks', track_id, body);
			expect_error(res, 400, 'invalid value');
			expect(res.body.issues[0].column).toBe(Object.keys(body)[0]);
		}
		expect_error(await patch('artists', artist_id, { name: '' }), 400, 'invalid value');
		expect_error(await patch('albums', uuid(), { album_type: 'LP' }), 400, 'invalid value');
		expect_error(await patch('service_ids', artist_id, { spotify_id: 'not-a-spotify-id' }), 400, 'invalid value');
	});

	it('answers 400 for a foreign key to a missing entity', async () => {
		const res = await patch('tracks', track_id, { album_id: uuid() });
		expect_error(res, 400, 'referenced entity does not exist');
	});

	it('applies a valid patch through an alias and reports before and after', async () => {
		const title = unique('Patched');
		const res = await patch('track', track_id, { title, explicit: null });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ table: 'tracks_table', id: track_id, redirected_from: null });
		expect(res.body.after.title).toBe(title);
		expect(res.body.before).toHaveProperty('title');
		expect((await query('select title from tracks_table where id = $1', [track_id]))[0].title).toBe(title);
	});

	it('answers 413 for a body above 256kb', async () => {
		expect_error(await patch('tracks', track_id, { title: 'x'.repeat(300_000) }), 413);
	});
});
