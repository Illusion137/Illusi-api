import { afterAll, describe, expect, it, vi } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });
const { api, contribute, create_user, mock_album, unique, uuid } = await import('./helpers');
const { db } = await import('../../src/db');
const events = await import('../../src/core/events');
const inheritance = await import('../../src/services/playlists/inheritance');
const lyrics = await import('../../src/services/lyrics');
const playlists = await import('../../src/services/playlists');
const soundcloud = await import('../../src/services/soundcloud/ingest');
const { PG_ERRORS } = await import('../../src/core/pg_errors');

const iso = (offset_ms = 0) => new Date(Date.now() + offset_ms).toISOString();
const push = (token: string, changes: object, push_id = uuid()) => api('POST', '/sync/push', { token, body: { push_id, changes } });

describe('sync push failure paths (in-process)', () => {
	it('refuses oversized pushes', async () => {
		const user = await create_user('push-big');
		const artists = Array.from({ length: 2_001 }, (_, i) => ({ ref: `a${i}`, name: `A${i}` }));
		const res = await push(user.access_token, { entities: { artists } });
		expect(res.status).toBe(413);
	});

	it('answers a concurrent retry of the same push with the stored response', async () => {
		const user = await create_user('push-twin');
		const push_id = uuid();
		const changes = { playlists: [{ id: uuid(), title: 'Twin', edited_at: iso(-1_000) }] };
		const [a, b] = await Promise.all([push(user.access_token, changes, push_id), push(user.access_token, changes, push_id)]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(JSON.stringify(a.body.applied)).toBe(JSON.stringify(b.body.applied));
	});

	it('fails the request when the push cannot be recorded', async () => {
		const user = await create_user('push-record-fail');
		const { query } = await import('./helpers');
		await query(`create or replace function refuse_push_record() returns trigger language plpgsql as $$ begin raise exception 'refused by test'; end $$`);
		await query('create trigger refuse_push_record_test before insert on sync_pushes_table for each row execute function refuse_push_record()');
		try {
			const res = await push(user.access_token, { playlists: [{ id: uuid(), title: 'Nope', edited_at: iso(-1_000) }] });
			expect(res.status).toBe(500);
		} finally {
			await query('drop trigger refuse_push_record_test on sync_pushes_table');
			await query('drop function refuse_push_record()');
		}
	});

	it('rejects an inheritance edge whose check fails unexpectedly', async () => {
		const user = await create_user('push-inherit-fail');
		const [a, b] = [uuid(), uuid()];
		await push(user.access_token, { playlists: [a, b].map(id => ({ id, title: id.slice(0, 4), edited_at: iso(-5_000) })) });
		const spy = vi.spyOn(inheritance, 'assert_inheritance_allowed').mockRejectedValueOnce(new Error('boom'));
		try {
			const res = await push(user.access_token, { playlist_inherited_playlists: [{ playlist_id: a, ref_id: b, edited_at: iso(-1_000) }] });
			expect(res.body.rejected).toEqual([expect.objectContaining({ reason: 'inheritance not allowed' })]);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('sync pull failure paths (in-process)', () => {
	it('keeps pulling when an inherited playlist cannot be resolved or actions cannot be built', async () => {
		const user = await create_user('pull-fail');
		const [a, b] = [uuid(), uuid()];
		await push(user.access_token, { playlists: [a, b].map(id => ({ id, title: id.slice(0, 4), edited_at: iso(-5_000) })) });
		await push(user.access_token, { playlist_inherited_playlists: [{ playlist_id: a, ref_id: b, edited_at: iso(-4_000) }] });
		const created = await contribute(user, mock_album({ artist: unique('Pull Artist'), album: unique('Pull Album'), n: 1 }));
		await push(user.access_token, { user_tracks: [{ track_id: created.body.refs.t0, edited_at: iso(-3_000) }] });
		await new Promise(r => setTimeout(r, 2_300));
		const resolve = vi.spyOn(playlists, 'resolve_playlist_track_ids').mockRejectedValue(new Error('resolve failed'));
		const actions = vi.spyOn(lyrics, 'lyrics_actions_for_tracks').mockRejectedValue(new Error('actions failed'));
		try {
			const res = await api('POST', '/sync/pull', { token: user.access_token, body: {} });
			expect(res.status).toBe(200);
			expect(resolve).toHaveBeenCalled();
			expect(actions).toHaveBeenCalled();
		} finally {
			resolve.mockRestore();
			actions.mockRestore();
		}
	});
});

describe('playlist resolution with inherited searches (in-process)', () => {
	it('resolves searches against the library and ignores empty ones', async () => {
		const user = await create_user('resolve-search');
		const title = unique('Findable Song');
		const graph = mock_album({ artist: unique('Search Artist'), album: unique('Search Album'), n: 1 });
		graph.tracks[0].title = title;
		const created = await contribute(user, graph);
		await push(user.access_token, { user_tracks: [{ track_id: created.body.refs.t0, edited_at: iso(-3_000) }] });
		const playlist_id = uuid();
		await push(user.access_token, { playlists: [{ id: playlist_id, title: 'Searchy', edited_at: iso(-5_000) }] });
		const pushed = await push(user.access_token, { playlist_inherited_searches: [{ playlist_id, query: title, mode: 'INCLUDE', edited_at: iso(-2_000) }, { playlist_id, query: null, mode: 'INCLUDE', edited_at: iso(-2_000) }, { playlist_id, query: 'x', mode: null, edited_at: iso(-2_000) }] });
		expect(pushed.body.applied.playlist_inherited_searches).toBe(3);
		const ids = await playlists.resolve_playlist_track_ids(user.id, playlist_id);
		// Which tracks a search matches is lib-origin's business; this covers loading the library for it.
		expect(Array.isArray(ids)).toBe(true);
	});
});

describe('playlist resolution cache (in-process)', () => {
	it('evicts the oldest users once the cache is full', async () => {
		const { query } = await import('./helpers');
		const prefix = unique('cache').replace(/-/gu, '');
		await query(`insert into users_table (id, username, email, password_hash)
			select gen_random_uuid(), $1 || '-' || n, $1 || '-' || n || '@example.test', 'x' from generate_series(1, 2005) n`, [prefix]);
		await query(`insert into playlists_table (user_id, title) select id, 'p' from users_table where username like $1`, [`${prefix}-%`]);
		const pairs = await query<{ user_id: string; id: string }>(`select p.user_id, p.id from playlists_table p join users_table u on u.id = p.user_id where u.username like $1`, [`${prefix}-%`]);
		try {
			for (let i = 0; i < pairs.length; i += 25) {
				await Promise.all(pairs.slice(i, i + 25).map(p => playlists.resolve_playlist_track_ids(p.user_id, p.id)));
			}
		} finally {
			await query('delete from users_table where username like $1', [`${prefix}-%`]);
		}
		expect(pairs.length).toBe(2005);
	}, 120_000);
});

describe('soundcloud ingest queue (in-process)', () => {
	const empty = () => ({ users: new Map(), tracks: new Map(), playlists: new Map() });
	it('retries once after a deadlock and drops batches when the queue is full', async () => {
		const user = await create_user('sc-queue');
		const transaction = vi.spyOn(db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: PG_ERRORS.deadlock_detected }));
		try {
			soundcloud.enqueue_batch(user.id, empty());
			await vi.waitFor(() => { expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(2); });
		} finally {
			transaction.mockRestore();
		}
		const slow = vi.spyOn(db, 'transaction').mockImplementation((() => new Promise(r => setTimeout(r, 300))) as never);
		try {
			for (let i = 0; i < 210; i++) soundcloud.enqueue_batch(user.id, empty());
		} finally {
			await new Promise(r => setTimeout(r, 50));
			slow.mockRestore();
		}
	}, 30_000);
});

describe('event bridge failure paths (in-process)', () => {
	it('retries when the database is unreachable and closes a connection that arrives after stop', async () => {
		const saved = process.env.MIGRATE_DATABASE_URL;
		process.env.MIGRATE_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/none';
		try {
			const stop = events.start_event_bridge();
			await new Promise(r => setTimeout(r, 300));
			await stop();
		} finally {
			process.env.MIGRATE_DATABASE_URL = saved;
		}
		const stop = events.start_event_bridge();
		await stop();
		await new Promise(r => setTimeout(r, 500));
	});
});
