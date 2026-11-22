import { describe, expect, it } from 'vitest';
import { api, contribute, create_user, mock_album, query, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

/** Pull snapshots stop 2 s before "now": rows newer than that come with the next pull. */
const settle = () => new Promise(r => setTimeout(r, 2_200));

const push = (user: TestUser, changes: object, extra: object = {}) =>
	api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes, ...extra } });

async function pull_all(user: TestUser, cursor?: string) {
	const pages = [];
	let next = cursor;
	for (;;) {
		const res = await api('POST', '/sync/pull', { token: user.access_token, body: next ? { cursor: next } : {} });
		expect(res.status).toBe(200);
		pages.push(res.body);
		next = res.body.next_cursor;
		if (!res.body.has_more) break;
	}
	const merged: Record<string, unknown[]> = {};
	for (const page of pages) {
		for (const [k, v] of Object.entries(page)) if (Array.isArray(v)) merged[k] = [...(merged[k] ?? []), ...v];
	}
	const user_row = pages.map(p => p.user).find(u => u != null) ?? null;
	return { rows: merged as Record<string, any[]>, cursor: next!, user: user_row, pages: pages.length };
}

describe('sync (§8)', () => {
	it('first import: pushes a local library with temp ids and gets illusi_ids back', async () => {
		const user = await create_user('importer');
		const graph = mock_album({ artist: unique('Local Artist'), album: unique('Local Album'), n: 2 });
		const now = new Date().toISOString();
		const playlist_id = uuid();
		const res = await push(user, {
			entities: graph,
			user_tracks: [
				{ track_id: 't0', title: 'my custom title', downloaded_at: now, start_at: 1000, edited_at: now },
				{ track_id: 't1', edited_at: now }
			],
			playlists: [{ id: playlist_id, title: 'Road Trip', edited_at: now }],
			playlist_tracks: [{ playlist_id, track_id: 't1', edited_at: now }],
			track_plays: [{ client_id: uuid(), track_id: 't0', created_at: now }],
			recent_searches: [{ client_id: uuid(), text: 'local album', created_at: now }],
			linked_playlists: [{ service_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', edited_at: now }],
			profile: { username: 'importer-renamed', edited_at: now }
		});
		expect(res.status).toBe(200);
		const body = res.body;
		expect(Object.keys(body.id_map).sort()).toEqual(['al', 'ar', 't0', 't1']);
		expect(body.rejected).toEqual([]);
		expect(body.applied).toMatchObject({ user_tracks: 2, playlists: 1, playlist_tracks: 1, track_plays: 1, recent_searches: 1, linked_playlists: 1, profile: 1 });
		expect(body.progress).toMatchObject({ created: 4 });

		const t0 = body.id_map.t0;
		const lib = await query(`select track_id, title, start_at, downloaded_at is not null as dl from user_tracks_table where user_id = $1 order by title nulls last`, [user.id]);
		expect(lib).toEqual([{ track_id: t0, title: 'my custom title', start_at: '1000', dl: true }, expect.objectContaining({ title: null })]);
		expect(await query(`select username from users_table where id = $1`, [user.id])).toEqual([{ username: 'importer-renamed' }]);
	});

	it('pull returns everything the user touches, then only changes after the cursor', async () => {
		const user = await create_user('puller');
		const graph = mock_album({ artist: unique('Pull Artist'), album: unique('Pull Album'), n: 2 });
		const now = new Date().toISOString();
		const pushed = await push(user, { entities: graph, user_tracks: [{ track_id: 't0', edited_at: now }] });
		const t0 = pushed.body.id_map.t0;

		await settle();
		const full = await pull_all(user);
		expect(full.rows.redirects).toEqual([]);
		expect(full.user).toMatchObject({ id: user.id });
		expect(full.user).not.toHaveProperty('password_hash');
		expect(full.rows.user_tracks.map(r => r.track_id)).toEqual([t0]);
		expect(full.rows.tracks.map(r => r.id)).toContain(t0);
		expect(full.rows.artists.map(r => r.id)).toContain(pushed.body.id_map.ar);
		expect(full.rows.albums.map(r => r.id)).toContain(pushed.body.id_map.al);
		expect(full.rows.service_ids.map(r => r.illusi_id)).toContain(t0);
		expect(full.rows.thumbnails.length).toBeGreaterThan(0);
		// Untouched tracks of the same album are not "touched" by this user.
		expect(full.rows.user_tracks.map(r => r.track_id)).not.toContain(pushed.body.id_map.t1);

		const quiet = await pull_all(user, full.cursor);
		expect(quiet.rows.user_tracks ?? []).toEqual([]);
		expect(quiet.rows.tracks ?? []).toEqual([]);

		await push(user, { user_tracks: [{ track_id: pushed.body.id_map.t1, edited_at: new Date().toISOString() }] });
		await settle();
		const delta = await pull_all(user, full.cursor);
		expect(delta.rows.user_tracks.map(r => r.track_id)).toEqual([pushed.body.id_map.t1]);
		expect(delta.rows.tracks.map(r => r.id)).toContain(pushed.body.id_map.t1);
	});

	it('keeps plays and searches with the same client id apart for different users', async () => {
		const [a, b] = [await create_user('cid-a'), await create_user('cid-b')];
		const track_id: string = (await contribute(a, mock_album({ artist: unique('Cid Artist'), album: unique('Cid Album'), n: 1 }))).body.refs.t0;
		// Ids derived from the same data on two users' devices (e.g. a search's text)
		const changes = { recent_searches: [{ client_id: uuid(), text: 'drake', created_at: new Date().toISOString() }], track_plays: [{ client_id: uuid(), track_id, created_at: new Date().toISOString() }] };
		for (const user of [a, b]) {
			const res = await push(user, changes);
			expect(res.status).toBe(200);
			expect(res.body.applied).toMatchObject({ recent_searches: 1, track_plays: 1 });
		}
		// The same user again is deduped
		expect((await push(a, changes)).body.applied.recent_searches ?? 0).toBe(0);
		expect(await query('select count(*)::int as n from user_recent_searches where client_id = $1', [changes.recent_searches[0].client_id])).toEqual([{ n: 2 }]);
	});

	it('corrects only recent device times for clock skew', async () => {
		const user = await create_user('skew');
		const track_id: string = (await contribute(user, mock_album({ artist: unique('Skew Artist'), album: unique('Skew Album'), n: 2 }))).body.refs.t0;
		const hour = 3_600_000;
		const client_now = Date.now() - hour; // the device runs an hour slow
		const old = Date.parse('2019-05-01T00:00:00Z');
		const res = await push(user, { user_tracks: [{ track_id, added_at: old, edited_at: client_now - 60_000 }] }, { client_now });
		expect(res.status).toBe(200);
		const [row] = await query<{ created_at: Date; edited_at: Date }>('select created_at, edited_at from user_tracks_table where user_id = $1 and track_id = $2', [user.id, track_id]);
		expect(row.created_at.getTime()).toBe(old);
		expect(Math.abs(row.edited_at.getTime() - (client_now - 60_000 + hour))).toBeLessThan(5_000);
	});

	it('a retried push_id is applied once and replays the same response', async () => {
		const user = await create_user('retry');
		const graph = mock_album({ artist: unique('Retry Artist'), album: unique('Retry Album'), n: 1 });
		const body = { push_id: uuid(), changes: { entities: graph, track_plays: [{ client_id: uuid(), track_id: 't0', created_at: new Date().toISOString() }] } };
		const first = await api('POST', '/sync/push', { token: user.access_token, body });
		const second = await api('POST', '/sync/push', { token: user.access_token, body });
		expect(second.body).toEqual(first.body);
		expect(await query(`select count(*)::int as n from track_plays_table where user_id = $1`, [user.id])).toEqual([{ n: 1 }]);
		// The same play pushed again under a new push_id is still deduped by client_id.
		await api('POST', '/sync/push', { token: user.access_token, body: { ...body, push_id: uuid() } });
		expect(await query(`select count(*)::int as n from track_plays_table where user_id = $1`, [user.id])).toEqual([{ n: 1 }]);
	});

	it('user-owned rows are last-write-wins by edited_at across devices (§8.4, §8.5)', async () => {
		const user = await create_user('lww');
		const created = await contribute(user, mock_album({ artist: unique('LWW Artist'), album: unique('LWW Album'), n: 1 }));
		const track_id = created.body.refs.t0;
		const t = (offset_s: number) => new Date(Date.now() + offset_s * 1000).toISOString();

		await push(user, { user_tracks: [{ track_id, title: 'phone title', edited_at: t(-10) }] });
		// A laptop with an older copy loses.
		const stale = await push(user, { user_tracks: [{ track_id, title: 'laptop title', edited_at: t(-60) }] });
		expect(stale.body.applied.user_tracks ?? 0).toBe(0);
		expect(stale.body.rows.user_tracks[0].title).toBe('phone title');
		// A newer edit wins, including a soft delete.
		await push(user, { user_tracks: [{ track_id, title: 'tablet title', deleted: true, edited_at: t(-1) }] });
		expect(await query(`select title, deleted from user_tracks_table where user_id = $1`, [user.id])).toEqual([{ title: 'tablet title', deleted: true }]);
		// A device clock in the future is clamped to server time, so it can't win forever.
		await push(user, { user_tracks: [{ track_id, title: 'future clock', deleted: false, edited_at: t(3600) }] });
		const [row] = await query(`select title, edited_at from user_tracks_table where user_id = $1`, [user.id]);
		expect(row.title).toBe('future clock');
		expect(new Date(row.edited_at).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
		await push(user, { user_tracks: [{ track_id, title: 'next edit', edited_at: t(1) }] });
		expect((await query(`select title from user_tracks_table where user_id = $1`, [user.id]))[0].title).toBe('next edit');
	});

	it('shared fields are first-write-wins through push too, and the response carries the server value', async () => {
		const a = await create_user('push-a');
		const b = await create_user('push-b');
		const graph = mock_album({ artist: unique('Shared Push Artist'), album: unique('Shared Push Album'), n: 1 });
		graph.tracks[0].duration_ms = 200_000;
		const first = await push(a, { entities: graph, user_tracks: [{ track_id: 't0', edited_at: new Date().toISOString() }] });
		const other = structuredClone(graph);
		other.tracks[0].duration_ms = 201_000;
		(other.tracks[0] as { explicit?: boolean }).explicit = true;
		const second = await push(b, { entities: other, user_tracks: [{ track_id: 't0', edited_at: new Date().toISOString() }] });
		expect(second.body.id_map.t0).toBe(first.body.id_map.t0);
		const track = second.body.rows.tracks.find((r: { id: string }) => r.id === first.body.id_map.t0);
		expect(track).toMatchObject({ duration_ms: 200_000, explicit: true });
	});

	it('rejects malformed rows individually and refuses tracks it cannot resolve', async () => {
		const user = await create_user('badrows');
		const res = await push(user, {
			user_tracks: [{ track_id: uuid(), edited_at: new Date().toISOString() }, { edited_at: 'not a date' }],
			playlists: [{ id: 'not-a-uuid', title: 'x', edited_at: new Date().toISOString() }]
		});
		expect(res.status).toBe(200);
		expect(res.body.rejected.map((r: { table: string }) => r.table).sort()).toEqual(['playlists', 'user_tracks', 'user_tracks']);
		expect((await api('POST', '/sync/pull', { token: user.access_token, body: { cursor: 'garbage' } })).status).toBe(400);
	});

	it('playlist inheritance: same owner only, no cycles (§10.1)', async () => {
		const user = await create_user('inherit');
		const other = await create_user('inherit-other');
		const now = new Date().toISOString();
		const [p1, p2, p3] = [uuid(), uuid(), uuid()];
		await push(user, { playlists: [p1, p2].map(id => ({ id, title: `pl ${id.slice(0, 4)}`, edited_at: now })) });
		await push(other, { playlists: [{ id: p3, title: 'theirs', public: true, edited_at: now }] });

		const ok = await push(user, { playlist_inherited_playlists: [{ temp_id: 'e1', playlist_id: p1, ref_id: p2, edited_at: now }] });
		expect(ok.body.applied.playlist_inherited_playlists).toBe(1);
		expect(ok.body.inherited_id_map.playlist_inherited_playlists.e1).toEqual(expect.any(Number));

		const cycle = await push(user, { playlist_inherited_playlists: [{ temp_id: 'e2', playlist_id: p2, ref_id: p1, edited_at: now }] });
		expect(cycle.body.applied.playlist_inherited_playlists ?? 0).toBe(0);
		expect(cycle.body.rejected.length).toBe(1);

		const foreign = await push(user, { playlist_inherited_playlists: [{ temp_id: 'e3', playlist_id: p1, ref_id: p3, edited_at: now }] });
		expect(foreign.body.applied.playlist_inherited_playlists ?? 0).toBe(0);
		expect(foreign.body.rejected.length).toBe(1);
	});

	it('a user cannot write into another user\'s playlist', async () => {
		const owner = await create_user('owner');
		const intruder = await create_user('intruder');
		const created = await contribute(owner, mock_album({ artist: unique('Own Artist'), album: unique('Own Album'), n: 1 }));
		const playlist_id = uuid();
		const now = new Date().toISOString();
		await push(owner, { playlists: [{ id: playlist_id, title: 'mine', edited_at: now }] });
		const res = await push(intruder, {
			playlists: [{ id: playlist_id, title: 'hijacked', edited_at: new Date(Date.now() + 1000).toISOString() }],
			playlist_tracks: [{ playlist_id, track_id: created.body.refs.t0, edited_at: now }]
		});
		expect(res.body.applied.playlists ?? 0).toBe(0);
		expect(res.body.applied.playlist_tracks ?? 0).toBe(0);
		expect(await query(`select title, user_id from playlists_table where id = $1`, [playlist_id])).toEqual([{ title: 'mine', user_id: owner.id }]);
	});
});
