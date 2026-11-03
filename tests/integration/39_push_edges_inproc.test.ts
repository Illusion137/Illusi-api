import { afterAll, describe, expect, it } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });
const { api, contribute, create_user, mock_album, query, unique, uuid } = await import('./helpers');
type TestUser = Awaited<ReturnType<typeof create_user>>;

const push = (user: TestUser, changes: object) => api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes } });
const iso = (offset_ms = 0) => new Date(Date.now() + offset_ms).toISOString();

describe('sync push edge cases (in-process)', () => {
	it('keeps the newer write when a stale one arrives, for every user table', async () => {
		const user = await create_user('push-stale');
		const created = await contribute(user, mock_album({ artist: unique('PS Artist'), album: unique('PS Album'), n: 1 }));
		const track_id = created.body.refs.t0;
		const playlist_id = uuid();
		const uri = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';
		const new_ = iso(-1_000);
		const old = iso(-60_000);

		await push(user, { playlists: [{ id: playlist_id, title: 'Newer', edited_at: new_ }], playlist_tracks: [{ playlist_id, track_id, edited_at: new_ }], linked_playlists: [{ service_uri: uri, edited_at: new_ }] });
		const stale = await push(user, {
			playlists: [{ id: playlist_id, title: 'Older', edited_at: old }],
			playlist_tracks: [{ playlist_id, track_id, deleted: true, edited_at: old }],
			linked_playlists: [{ service_uri: uri, deleted: true, edited_at: old }]
		});
		expect(stale.status).toBe(200);
		expect(stale.body.applied.playlists ?? 0).toBe(0);
		expect(stale.body.applied.playlist_tracks ?? 0).toBe(0);
		expect(stale.body.applied.linked_playlists ?? 0).toBe(0);
		expect((await query('select title from playlists_table where id = $1', [playlist_id]))[0].title).toBe('Newer');

		const newer = await push(user, {
			playlist_tracks: [{ playlist_id, track_id, deleted: true, edited_at: iso(-500) }],
			linked_playlists: [{ service_uri: uri, deleted: true, edited_at: iso(-500) }]
		});
		expect(newer.body.applied).toMatchObject({ playlist_tracks: 1, linked_playlists: 1 });
	});

	it('rejects playlist rows for an unknown playlist or track, and plays of unknown tracks', async () => {
		const user = await create_user('push-reject');
		const playlist_id = uuid();
		await push(user, { playlists: [{ id: playlist_id, title: 'Mine', edited_at: iso(-1_000) }] });
		const res = await push(user, {
			playlist_tracks: [{ playlist_id: uuid(), track_id: uuid(), edited_at: iso(-1_000) }, { playlist_id, track_id: uuid(), edited_at: iso(-1_000) }],
			track_plays: [{ client_id: uuid(), track_id: uuid(), created_at: iso(-1_000) }],
			playlist_inherited_searches: [{ playlist_id: uuid(), query: 'x', mode: 'INCLUDE', edited_at: iso(-1_000) }],
			playlist_inherited_playlists: [{ playlist_id: uuid(), ref_id: uuid(), edited_at: iso(-1_000) }]
		});
		expect(res.status).toBe(200);
		const tables = res.body.rejected.map((r: { table: string }) => r.table).sort();
		expect(tables).toEqual(['playlist_inherited_playlists', 'playlist_inherited_searches', 'playlist_tracks', 'playlist_tracks', 'track_plays']);
	});

	it('inherited searches: new row, retried push without ids, by id, stale, unknown id', async () => {
		const user = await create_user('push-search');
		const playlist_id = uuid();
		await push(user, { playlists: [{ id: playlist_id, title: 'S', edited_at: iso(-10_000) }] });
		const first = await push(user, { playlist_inherited_searches: [{ temp_id: 's1', playlist_id, query: 'daft punk', mode: 'INCLUDE', edited_at: iso(-5_000) }] });
		const id = first.body.inherited_id_map.playlist_inherited_searches.s1 as number;
		expect(id).toEqual(expect.any(Number));

		// A retried push with a new push_id and no server id resolves to the same row.
		const retry = await push(user, { playlist_inherited_searches: [{ temp_id: 's1', playlist_id, query: 'daft punk', mode: 'INCLUDE', edited_at: iso(-2_000) }] });
		expect(retry.body.inherited_id_map.playlist_inherited_searches.s1).toBe(id);
		// A null query matches the row with a null query.
		const none = await push(user, { playlist_inherited_searches: [{ temp_id: 's2', playlist_id, query: null, mode: 'INCLUDE', edited_at: iso(-4_000) }] });
		const none_id = none.body.inherited_id_map.playlist_inherited_searches.s2 as number;
		const again = await push(user, { playlist_inherited_searches: [{ temp_id: 's2', playlist_id, query: null, mode: 'INCLUDE', edited_at: iso(-3_000) }] });
		expect(again.body.inherited_id_map.playlist_inherited_searches.s2).toBe(none_id);

		const by_id = await push(user, { playlist_inherited_searches: [{ id, playlist_id, query: 'daft punk live', deleted: false, edited_at: iso(-1_000) }] });
		expect(by_id.body.applied.playlist_inherited_searches).toBe(1);
		const stale = await push(user, { playlist_inherited_searches: [{ id, temp_id: 'x', playlist_id, query: 'old', edited_at: iso(-50_000) }] });
		expect(stale.body.applied.playlist_inherited_searches ?? 0).toBe(0);
		const unknown = await push(user, { playlist_inherited_searches: [{ id: 999_999_999, playlist_id, query: 'x', edited_at: iso(-500) }] });
		expect(unknown.body.rejected).toEqual([expect.objectContaining({ table: 'playlist_inherited_searches', reason: 'unknown row' })]);
	});

	it('inherited playlists: update by id, delete, stale, retried push and unknown id', async () => {
		const user = await create_user('push-inherit');
		const [a, b] = [uuid(), uuid()];
		await push(user, { playlists: [a, b].map(id => ({ id, title: id.slice(0, 4), edited_at: iso(-10_000) })) });
		const first = await push(user, { playlist_inherited_playlists: [{ temp_id: 'e1', playlist_id: a, ref_id: b, mode: 'INCLUDE', edited_at: iso(-5_000) }] });
		const id = first.body.inherited_id_map.playlist_inherited_playlists.e1 as number;

		const retry = await push(user, { playlist_inherited_playlists: [{ temp_id: 'e1', playlist_id: a, ref_id: b, mode: 'INCLUDE', edited_at: iso(-4_000) }] });
		expect(retry.body.inherited_id_map.playlist_inherited_playlists.e1).toBe(id);
		const stale = await push(user, { playlist_inherited_playlists: [{ id, playlist_id: a, ref_id: b, deleted: true, edited_at: iso(-60_000) }] });
		expect(stale.body.applied.playlist_inherited_playlists ?? 0).toBe(0);
		const removed = await push(user, { playlist_inherited_playlists: [{ id, temp_id: 'e1', playlist_id: a, ref_id: b, deleted: true, edited_at: iso(-1_000) }] });
		expect(removed.body.applied.playlist_inherited_playlists).toBe(1);
		const unknown = await push(user, { playlist_inherited_playlists: [{ id: 999_999_999, playlist_id: a, ref_id: b, edited_at: iso(-500) }] });
		expect(unknown.body.rejected).toEqual([expect.objectContaining({ reason: 'unknown row' })]);
	});
});
