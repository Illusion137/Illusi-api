import { beforeAll, describe, expect, it } from 'vitest';
import { api, contribute, create_user, mock_album, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

let user: TestUser;
let other: TestUser;
let track_id: string;

const expect_error = (res: { status: number; body: any }, status: number, message?: string) => {
	expect(res.status).toBe(status);
	expect(typeof res.body.error).toBe('string');
	if (message) expect(res.body.error).toBe(message);
};

const push = (token: string, changes: unknown, extra: Record<string, unknown> = {}) =>
	api('POST', '/sync/push', { token, body: { push_id: uuid(), changes, ...extra } });

beforeAll(async () => {
	user = await create_user('sv');
	other = await create_user('sv-other');
	track_id = (await contribute(user, mock_album({ artist: unique('SV Artist'), album: unique('SV Album'), n: 1 }))).body.refs.t0;
});

describe('sync auth and validation', () => {
	it('requires a token', async () => {
		expect_error(await api('POST', '/sync/pull', { body: {} }), 401, 'missing access token');
		expect_error(await api('POST', '/sync/push', { body: {} }), 401, 'missing access token');
		expect_error(await api('POST', '/contribute', { body: {} }), 401, 'missing access token');
		expect_error(await api('POST', '/resolve', { body: { items: [] } }), 401, 'missing access token');
	});

	it('accepts an empty or null pull body and rejects a bad cursor', async () => {
		expect((await api('POST', '/sync/pull', { token: user.access_token })).status).toBe(200);
		expect((await api('POST', '/sync/pull', { token: user.access_token, body: {} })).status).toBe(200);
		expect((await api('POST', '/sync/pull', { token: user.access_token, body: { cursor: null } })).status).toBe(200);
		expect_error(await api('POST', '/sync/pull', { token: user.access_token, body: { cursor: 'garbage' } }), 400, 'invalid cursor');
		expect_error(await api('POST', '/sync/pull', { token: user.access_token, body: { cursor: 5 } }), 400, 'invalid body');
		expect_error(await api('POST', '/sync/pull', { token: user.access_token, body: { cursor: 'x'.repeat(2049) } }), 400, 'invalid body');
	});

	it('answers an oversize pull body with 413', async () => {
		expect_error(await api('POST', '/sync/pull', { token: user.access_token, body: { cursor: 'x'.repeat(20_000) } }), 413);
	});

	it('treats an empty cursor string like no cursor', async () => {
		const res = await api('POST', '/sync/pull', { token: user.access_token, body: { cursor: '' } });
		expect(res.status).toBe(200);
		expect(typeof res.body.next_cursor).toBe('string');
	});

	it('rejects malformed push bodies', async () => {
		const t = user.access_token;
		for (const body of [undefined, {}, { push_id: 'nope', changes: {} }, { push_id: uuid() }, { push_id: uuid(), changes: [] }, { push_id: uuid(), changes: { user_tracks: 'x' } }, { push_id: uuid(), changes: { entities: { tracks: 'x' } } }]) {
			expect_error(await api('POST', '/sync/push', { token: t, body }), 400, 'invalid body');
		}
		expect_error(await push(t, {}, { base_cursor: 'garbage' }), 400, 'invalid base_cursor');
		expect_error(await push(t, {}, { base_cursor: 'x'.repeat(2049) }), 400, 'invalid body');
	});

	it('accepts an empty push and replays a retried push_id verbatim', async () => {
		const push_id = uuid();
		const body = { push_id, changes: { user_tracks: [{ track_id, edited_at: new Date().toISOString() }] } };
		const first = await api('POST', '/sync/push', { token: user.access_token, body });
		const second = await api('POST', '/sync/push', { token: user.access_token, body });
		expect(first.status).toBe(200);
		expect(second.body).toEqual(first.body);
		expect((await push(user.access_token, {})).status).toBe(200);
	});

	it('rejects an invalid row without failing the push', async () => {
		const res = await push(user.access_token, {
			user_tracks: [{ track_id, edited_at: 'not a date' }, { edited_at: new Date().toISOString() }],
			playlists: [{ id: 'nope', edited_at: new Date().toISOString() }, { id: uuid(), title: '   ', edited_at: new Date().toISOString() }],
			track_plays: [{ client_id: uuid(), track_id: 'x'.repeat(129), created_at: new Date().toISOString() }],
			profile: { username: '', edited_at: new Date().toISOString() }
		});
		expect(res.status).toBe(200);
		expect(res.body.rejected).toHaveLength(6);
		for (const r of res.body.rejected) expect(typeof r.reason).toBe('string');
		expect(res.body.rejected.map((r: { table: string }) => r.table).sort()).toEqual(['playlists', 'playlists', 'profile', 'track_plays', 'user_tracks', 'user_tracks']);
	});

	it('answers an oversize push with 413', async () => {
		const res = await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { user_tracks: [{ track_id, title: 'x'.repeat(17 * 1024 * 1024), edited_at: new Date().toISOString() }] } } });
		expect_error(res, 413);
	}, 60_000);

	it('keeps pushed rows private to their user', async () => {
		const id = uuid();
		await push(user.access_token, { playlists: [{ id, title: unique('Private'), edited_at: new Date().toISOString() }] });
		const pulled = await api('POST', '/sync/pull', { token: other.access_token, body: {} });
		expect(pulled.body.playlists.some((p: { id: string }) => p.id === id)).toBe(false);
		const hijack = await push(other.access_token, { playlists: [{ id, title: 'hijacked', edited_at: new Date(Date.now() + 5000).toISOString() }] });
		expect(hijack.status).toBe(200);
		expect(hijack.body.applied.playlists ?? 0).toBe(0);
		const mine = await api('GET', `/playlists/${id}`, { token: user.access_token });
		expect(mine.body.title).not.toBe('hijacked');
	});

	it('limits pulls to 240 per minute with 429', async () => {
		const limited = await create_user('sv-rl');
		let last = 0;
		for (let i = 0; i < 241; i++) last = (await api('POST', '/sync/pull', { token: limited.access_token, body: { cursor: 'bad' } })).status;
		expect(last).toBe(429);
		expect_error(await api('POST', '/sync/pull', { token: limited.access_token, body: {} }), 429, 'rate limited');
	}, 60_000);
});

describe('contribute validation', () => {
	const base = () => ({ contribution_id: uuid() });

	it('rejects a missing or malformed contribution_id', async () => {
		for (const body of [{}, { contribution_id: 'nope' }, { contribution_id: 5 }]) {
			expect_error(await api('POST', '/contribute', { token: user.access_token, body }), 400, 'invalid body');
		}
	});

	it('rejects malformed graphs', async () => {
		for (const extra of [{ tracks: 'x' }, { relations: 'x' }]) {
			expect_error(await api('POST', '/contribute', { token: user.access_token, body: { ...base(), ...extra } }), 400, 'invalid body');
		}
	});

	it('rejects malformed entities individually without failing the request', async () => {
		const res = await api('POST', '/contribute', { token: user.access_token, body: { ...base(), artists: [{}], tracks: [{ ref: 'a' }], albums: [{ ref: 'x', name: 5 }] } });
		expect(res.status).toBe(200);
		expect(res.body.created).toEqual([]);
		expect(res.body.rejected.map((r: { kind: string; reason: string }) => [r.kind, r.reason]).sort()).toEqual([['album', 'malformed'], ['artist', 'malformed'], ['track', 'malformed']]);
	});

	it('accepts an empty graph and replays it', async () => {
		const body = base();
		const first = await api('POST', '/contribute', { token: user.access_token, body });
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ refs: {}, created: [], matched: [], conflicts: [], rejected: [] });
		expect((await api('POST', '/contribute', { token: user.access_token, body })).body).toEqual(first.body);
	});

	it('answers 413 above the entity cap with the limits in the body', async () => {
		const tracks = Array.from({ length: 1001 }, (_, i) => ({ ref: `t${i}`, title: `T${i}` }));
		const res = await api('POST', '/contribute', { token: user.access_token, body: { ...base(), tracks } });
		expect_error(res, 413, 'too many entities');
		expect(res.body).toMatchObject({ max_entities: 1000, max_relations: 5000 });
	}, 60_000);

	it('answers 413 above the body size limit', async () => {
		const tracks = [{ ref: 't0', title: 'x'.repeat(5 * 1024 * 1024) }];
		expect_error(await api('POST', '/contribute', { token: user.access_token, body: { ...base(), tracks } }), 413);
	}, 60_000);

	it('answers 409 when another user already used the contribution_id', async () => {
		const body = { ...base(), ...mock_album({ artist: unique('Dup Artist'), album: unique('Dup Album'), n: 1 }) };
		expect((await api('POST', '/contribute', { token: user.access_token, body })).status).toBe(200);
		expect_error(await api('POST', '/contribute', { token: other.access_token, body }), 409, 'contribution_id already used');
	});
});

describe('resolve validation', () => {
	it('rejects malformed bodies', async () => {
		for (const body of [{}, { items: 'x' }, { items: [{}] }, { items: [{ ref: 'a', type: 'playlist' }] }, { items: [{ ref: '', type: 'track' }] }, { items: [{ ref: 'a', type: 'track', duration_ms: -1 }] }, { items: Array.from({ length: 501 }, (_, i) => ({ ref: `r${i}`, type: 'track' })) }]) {
			expect_error(await api('POST', '/resolve', { token: user.access_token, body }), 400, 'invalid body');
		}
	});

	it('answers an empty list with an empty object and unknown items with null', async () => {
		expect((await api('POST', '/resolve', { token: user.access_token, body: { items: [] } })).body).toEqual({});
		const res = await api('POST', '/resolve', { token: user.access_token, body: { items: [{ ref: 'x', type: 'track', title: unique('Nothing Here') }, { ref: 'y', type: 'artist' }] } });
		expect(res.body).toEqual({ x: null, y: null });
	});

	it('answers 413 above 1mb', async () => {
		expect_error(await api('POST', '/resolve', { token: user.access_token, body: { items: [{ ref: 'a', type: 'track', title: 'x'.repeat(1_100_000) }] } }), 413);
	});
});
