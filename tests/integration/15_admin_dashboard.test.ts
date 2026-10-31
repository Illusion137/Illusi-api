import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, eventually, make_admin, mock_album, query, unique, uuid, wav_bytes } from './helpers';
import type { TestUser } from './helpers';

let admin: TestUser;

const get = (p: string, token = admin.access_token) => api('GET', p, { token });
const youtube_id = () => randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/gu, 'a').slice(0, 11);

async function backpacked_track(owner: TestUser) {
	const created = await contribute(owner, mock_album({ artist: unique('Dash Artist'), album: unique('Dash Album'), n: 1 }));
	const track_id: string = created.body.refs.t0;
	await add_to_library(owner, [track_id], { downloaded_at: new Date().toISOString() });
	const report = await api('POST', `/tracks/${track_id}/unavailable`, { token: owner.access_token, body: { service: 'youtube', reason: 'removed' } });
	expect(report.body.backpacked).toBe(true);
	return track_id;
}

const is_backpacked = async (id: string) => (await query<{ backpacked: boolean }>('select backpacked from tracks_table where id = $1', [id]))[0].backpacked;

beforeAll(async () => {
	admin = await make_admin(await create_user('dash-admin'));
});

describe('admin dashboard', () => {
	it('serves the dashboard page without auth, and every data route is admin-only', async () => {
		const page = await api('GET', '/admin/', { root: true });
		expect(page.status).toBe(200);
		expect(page.text).toContain('Illusi Admin');

		const user = await create_user('dash-user');
		for (const p of ['/admin/status', '/admin/logs/files', '/admin/users', '/admin/backpack', '/admin/audit', `/admin/tracks/${uuid()}`]) {
			expect((await api('GET', p)).status).toBe(401);
			expect((await get(p, user.access_token)).status).toBe(403);
		}
	});

	it('reports a live status snapshot', async () => {
		const res = await get('/admin/status');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.body).toMatchObject({
			process: { uptime_s: expect.any(Number), draining: false, background_services: false },
			database: { ok: true, latency_ms: expect.any(Number), pool: { total: expect.any(Number) } },
			analyzer: { ok: expect.any(Boolean) },
			disk: { free_gb: expect.any(Number), total_gb: expect.any(Number) },
			queues: { backpacked_tracks: expect.any(Number), users: { total: expect.any(Number) } }
		});
		expect(res.body.leaders.map((l: { role: string }) => l.role)).toEqual(['background_services', 'exports']);
		expect(res.body.leaders.find((l: { role: string }) => l.role === 'exports').held).toBe(true);
		expect(res.body.database.connections.length).toBeGreaterThan(0);
	});

	it('reads the log files, filtered by request id', async (ctx) => {
		const files = await get('/admin/logs/files');
		if (files.status === 404) ctx.skip();
		const marker = await api('GET', '/auth/me', { token: admin.access_token, headers: { 'x-request-id': `dash-${randomBytes(6).toString('hex')}` } });
		const request_id = marker.headers.get('x-request-id')!;
		const today = new Date().toISOString().slice(0, 10);
		const service = (await eventually(async () => {
			const list = (await get('/admin/logs/files')).body.files as { service: string; day: string }[];
			const found = list.find(f => f.day === today);
			if (!found) throw new Error('no log file yet');
			return found;
		})).service;
		const lines = await eventually(async () => {
			const res = await get(`/admin/logs?service=${service}&day=${today}&request_id=${request_id}`);
			expect(res.status).toBe(200);
			if (res.body.lines.length === 0) throw new Error('access line not written yet');
			return res.body.lines;
		});
		expect(lines[0].entry).toMatchObject({ scope: 'access', path: '/api/v1/auth/me', status: 200, request_id });
		expect((await get(`/admin/logs?service=${service}&day=${today}&request_id=${request_id}&access=false`)).body.lines).toEqual([]);
		expect((await get('/admin/logs?service=../x&day=2026-01-01')).status).toBe(400);
		expect((await get(`/admin/logs?service=${service}&day=2000-01-01`)).status).toBe(404);
	});

	it('lists, edits, signs out and deletes users, never demoting or deleting yourself', async () => {
		const target = await create_user('dash-target');
		const listed = await get(`/admin/users?q=${encodeURIComponent(target.email)}`);
		expect(listed.body).toMatchObject({ total: 1, items: [{ id: target.id, role: 'USER', active_sessions: 1 }] });

		const promoted = await api('PATCH', `/admin/users/${target.id}`, { token: admin.access_token, body: { role: 'ADMIN', email_verified: false } });
		expect(promoted.body).toMatchObject({ role: 'ADMIN', email_verified_at: null });
		expect((await get('/admin/status', target.access_token)).status).toBe(403);
		await api('PATCH', `/admin/users/${target.id}`, { token: admin.access_token, body: { email_verified: true } });
		expect((await get('/admin/status', target.access_token)).status).toBe(200);
		expect((await api('PATCH', `/admin/users/${target.id}`, { token: admin.access_token, body: {} })).status).toBe(400);

		expect((await api('POST', `/admin/users/${target.id}/revoke_sessions`, { token: admin.access_token })).status).toBe(204);
		expect((await api('POST', '/auth/refresh', { body: { refresh_token: target.refresh_token } })).status).toBe(401);

		expect((await api('PATCH', `/admin/users/${admin.id}`, { token: admin.access_token, body: { role: 'USER' } })).status).toBe(400);
		expect((await api('DELETE', `/admin/users/${admin.id}`, { token: admin.access_token })).status).toBe(400);

		expect((await api('DELETE', `/admin/users/${target.id}`, { token: admin.access_token })).status).toBe(204);
		expect(await query('select id from users_table where id = $1', [target.id])).toEqual([]);
		expect((await api('DELETE', `/admin/users/${target.id}`, { token: admin.access_token })).status).toBe(404);

		const audit = await get(`/admin/audit?entity_id=${target.id}`);
		expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(['admin_delete', 'admin_revoke', 'admin_user_edit', 'admin_user_edit']);
		expect(audit.body.items[0]).toMatchObject({ actor: 'admin', actor_user_id: admin.id });
	});

	it('shows backpacked tracks with their reports, and finds tracks by title or id', async () => {
		const owner = await create_user('dash-owner');
		const track_id = await backpacked_track(owner);
		const [{ title }] = await query<{ title: string }>('select title from tracks_table where id = $1', [track_id]);

		const overview = await get('/admin/backpack?sort=age&limit=100');
		const row = overview.body.items.find((t: { id: string }) => t.id === track_id);
		expect(row).toMatchObject({ title, reports: 1, reporters: 1, reported_services: ['youtube'], research: null, media_count: 0 });
		expect((await get('/admin/backpack?exhausted=true&limit=100')).body.items.some((t: { id: string }) => t.id === track_id)).toBe(false);

		expect((await get(`/admin/tracks?q=${encodeURIComponent(title)}`)).body.items.map((t: { id: string }) => t.id)).toContain(track_id);
		expect((await get(`/admin/tracks?q=${track_id}`)).body.items).toHaveLength(1);
		const detail = await get(`/admin/tracks/${track_id}`);
		expect(detail.body).toMatchObject({ track: { id: track_id, backpacked: true }, reports: [{ service: 'youtube', reason: 'removed' }], media: [] });
	});

	it('clears backpacked when an admin gives the track a playable id', async () => {
		const owner = await create_user('dash-yt');
		const track_id = await backpacked_track(owner);
		const res = await api('PATCH', `/admin/entities/service_ids/${track_id}`, { token: admin.access_token, body: { youtube_id: youtube_id() } });
		expect(res.status).toBe(200);
		expect(await is_backpacked(track_id)).toBe(false);

		const other = await backpacked_track(owner);
		await api('PATCH', `/admin/entities/service_ids/${other}`, { token: admin.access_token, body: { isrc: 'USAAA2600001' } });
		expect(await is_backpacked(other)).toBe(true);
	});

	it('clears backpacked when a resolved conflict moves a playable id onto the track', async () => {
		const owner = await create_user('dash-move');
		const to = await backpacked_track(owner);
		const yt = youtube_id();
		const from = uuid();
		await query('insert into service_ids_table (illusi_id, youtube_id) values ($1, $2)', [from, yt]);
		await query('insert into tracks_table (id, title) values ($1, $2)', [from, unique('Misattributed')]);
		const steps = [{ type: 'move', from, to, values: { youtube_id: yt }, facet_source: 'youtube', thumbnails: [], auto: false, reasons: ['test'] }];
		const plan = { group_key: to, kind: 'track', node_ids: [to, from], steps, conflict_ids: [] };
		const [{ id }] = await query<{ id: number }>(
			`insert into review_items_table (kind, entity_table, entity_id, proposed_values, dedupe_key) values ('SERVICE_ID_CONFLICT', 'tracks_table', $1, $2, $3) returning id`,
			[from, JSON.stringify([{ value: { signature: unique('sig'), steps }, plan, source_user_ids: [], occurrences: 1 }]), unique('dedupe')]
		);
		const applied = await api('POST', `/admin/review/${id}/apply`, { token: admin.access_token, body: {} });
		expect(applied.body.steps).toEqual([expect.objectContaining({ type: 'move', applied: true })]);
		expect(await query('select youtube_id from service_ids_table where illusi_id = $1', [to])).toEqual([{ youtube_id: yt }]);
		expect(await is_backpacked(to)).toBe(false);
	});

	it('removes a media file, its row and its vocal analysis', async () => {
		const owner = await create_user('dash-media');
		const created = await contribute(owner, mock_album({ artist: unique('Media Dash'), album: unique('Media Dash Album'), n: 1, imported: true }));
		const track_id: string = created.body.refs.t0;
		await add_to_library(owner, [track_id], { downloaded_at: new Date().toISOString() });
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(wav_bytes(Math.floor(Math.random() * 1000)))], { type: 'audio/wav' }), 'song.wav');
		const stored = await api('POST', `/tracks/${track_id}/media`, { token: owner.access_token, raw: form });
		expect(stored.status).toBe(201);
		const { id, resource_id } = stored.body.media;
		await query(`insert into track_vocals_table (track_id, resource_id, status) values ($1, $2, 'DONE')`, [track_id, resource_id]);

		const detail = await get(`/admin/tracks/${track_id}`);
		expect(detail.body.media).toEqual([expect.objectContaining({ id, resource_id, uploaded_by: owner.id })]);

		const removed = await api('DELETE', `/admin/media/${id}`, { token: admin.access_token });
		expect(removed.body).toEqual({ id, track_id, resource_id });
		expect(await query('select id from media_table where id = $1', [id])).toEqual([]);
		expect(await query('select track_id from track_vocals_table where track_id = $1', [track_id])).toEqual([]);
		if (process.env.MEDIA_DIR) expect(existsSync(path.join(process.env.MEDIA_DIR, resource_id))).toBe(false);
		expect((await api('DELETE', `/admin/media/${id}`, { token: admin.access_token })).status).toBe(404);
		expect((await api('DELETE', '/admin/media/abc', { token: admin.access_token })).status).toBe(400);

		const audit = await get(`/admin/audit?entity_id=${track_id}&action=admin_delete`);
		expect(audit.body.items[0].details.media).toMatchObject({ id, resource_id });
	});
});
