import { beforeAll, describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

let user: TestUser;
let other: TestUser;
let track_id: string;
let artist_id: string;
let upload_token: string;

const expect_error = (res: { status: number; body: any }, status: number, message?: string) => {
	expect(res.status).toBe(status);
	expect(typeof res.body.error).toBe('string');
	if (message) expect(res.body.error).toBe(message);
};

beforeAll(async () => {
	user = await create_user('ing');
	other = await create_user('ing-other');
	const refs = (await contribute(user, mock_album({ artist: unique('Ing Artist'), album: unique('Ing Album'), n: 1, imported: true }))).body.refs;
	track_id = refs.t0;
	artist_id = refs.ar;
	await add_to_library(user, [track_id], { downloaded_at: new Date().toISOString() });
	upload_token = (await api('GET', '/media/requests', { token: user.access_token })).body.actions[0].token;
});

describe('ingest auth', () => {
	it('answers 401 without a token', async () => {
		const routes: [string, string][] = [
			['POST', '/ingest/genius'], ['POST', '/ingest/youtube_music_lyrics'], ['POST', '/ingest/soundcloud'], ['POST', '/ingest/new_releases'],
			['POST', '/ingest/track_research'], ['GET', `/tracks/${track_id}/lyrics`], ['GET', '/new-releases'], ['GET', '/new-releases/me'],
			['GET', '/backpack/requests'], ['POST', `/tracks/${track_id}/unavailable`]
		];
		for (const [method, path] of routes) expect_error(await api(method, path), 401, 'missing access token');
	});
});

describe('lyrics', () => {
	it('rejects a malformed id and answers 404 for an unknown track', async () => {
		expect_error(await api('GET', '/tracks/nope/lyrics', { token: user.access_token }), 400, 'invalid body');
		expect_error(await api('GET', `/tracks/${uuid()}/lyrics`, { token: user.access_token }), 404, 'track not found');
	});

	it('answers a stored-nothing lookup with null lyrics and client actions', async () => {
		const res = await api('GET', `/tracks/${track_id}/lyrics`, { token: user.access_token });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ track_id, lyrics: null });
		expect(Array.isArray(res.body.actions)).toBe(true);
		for (const a of res.body.actions) expect(typeof a.token).toBe('string');
	});

	it('validates the genius ingest body', async () => {
		const token = upload_token;
		for (const body of [{}, { token }, { token, track_id }, { token, track_id, preloaded_state: 'x' }, { token, track_id: 'nope', result: 'NOT_FOUND' }, { token: '', track_id, result: 'NOT_FOUND' }, { token, track_id, result: 'FOUND' }, { token: 'x'.repeat(4097), track_id, result: 'NOT_FOUND' }, { track_id, result: 'NOT_FOUND' }, { track_id }]) {
			expect_error(await api('POST', '/ingest/genius', { token: user.access_token, body }), 400, 'invalid body');
		}
	});

	it('validates the youtube music ingest body', async () => {
		for (const body of [{}, { token: upload_token }, { token: upload_token, track_id: 'nope' }, { token: upload_token, track_id, lyrics: 5 }, { token: upload_token, track_id, youtube_id: '' }, { token: upload_token, track_id, result: 'FOUND' }]) {
			expect_error(await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body }), 400, 'invalid body');
		}
	});

	it('rejects action tokens of the wrong type, user or signature', async () => {
		const wrong = [
			{ token: upload_token }, { token: 'garbage' }
		];
		expect_error(await api('POST', '/ingest/genius', { token: user.access_token, body: { ...wrong[0], track_id, result: 'NOT_FOUND' } }), 403, 'action token type mismatch');
		expect_error(await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body: { ...wrong[0], track_id, result: 'NOT_FOUND' } }), 403, 'action token type mismatch');
		expect_error(await api('POST', '/ingest/genius', { token: user.access_token, body: { ...wrong[1], track_id, result: 'NOT_FOUND' } }), 403, 'invalid or expired action token');
		expect_error(await api('POST', '/ingest/genius', { token: other.access_token, body: { ...wrong[0], track_id, result: 'NOT_FOUND' } }), 403, 'action token issued to another user');
	});

	it('answers an oversize genius body with 413', async () => {
		expect_error(await api('POST', '/ingest/genius', { token: user.access_token, body: { token: upload_token, track_id, preloaded_state: { x: 'y'.repeat(2_200_000) } } }), 413);
	});

	it('limits genius ingests to 30 per minute with 429', async () => {
		const u = await create_user('ing-rl');
		let last = 0;
		for (let i = 0; i < 31; i++) last = (await api('POST', '/ingest/genius', { token: u.access_token, body: {} })).status;
		expect(last).toBe(429);
		expect_error(await api('POST', '/ingest/genius', { token: u.access_token, body: {} }), 429, 'rate limited');
	});
});

describe('soundcloud ingest', () => {
	const post = (body: unknown, token = user.access_token) => api('POST', '/ingest/soundcloud', { token, body });

	it('accepts an empty list and counts malformed items as rejected', async () => {
		expect(await post({ items: [] })).toMatchObject({ status: 202, body: { accepted: 0, rejected: 0 } });
		expect(await post({ items: [1, 'x', {}] })).toMatchObject({ status: 202, body: { accepted: 0, rejected: 3 } });
	});

	it('rejects a missing, non-array or oversize items list', async () => {
		for (const body of [{}, { items: 'x' }, { items: Array.from({ length: 501 }, () => ({})) }]) expect_error(await post(body), 400, 'invalid body');
	});

	it('answers 413 when wrapped collections hold more than 500 items', async () => {
		const res = await post({ items: [{ collection: Array.from({ length: 300 }, () => ({})) }, { collection: Array.from({ length: 300 }, () => ({})) }] });
		expect_error(res, 413, 'too many items');
		expect(res.body.max_items).toBe(500);
	});

	it('answers 413 for a body above 4mb', async () => {
		expect_error(await post({ items: [{ blob: 'x'.repeat(4_300_000) }] }), 413);
	});
});

describe('new releases', () => {
	it('validates the limit', async () => {
		for (const q of ['limit=0', 'limit=501', 'limit=x', 'limit=1.5']) {
			for (const path of ['/new-releases', '/new-releases/me']) {
				const res = await api('GET', `${path}?${q}`, { token: user.access_token });
				expect_error(res, 400, 'invalid query');
				expect(Array.isArray(res.body.issues)).toBe(true);
			}
		}
	});

	it('returns the window and honors the limit', async () => {
		const res = await api('GET', '/new-releases?limit=1', { token: user.access_token });
		expect(res.status).toBe(200);
		expect(new Date(res.body.since).getTime()).toBeLessThan(new Date(res.body.until).getTime());
		expect(res.body.albums.length).toBeLessThanOrEqual(1);
		expect(res.body.actions).toBeUndefined();
	});

	it('hands out check actions only for known services and ignores the rest', async () => {
		const none = await api('GET', '/new-releases/me?services=bogus,', { token: user.access_token });
		expect(none.status).toBe(200);
		expect(none.body.actions).toBeUndefined();
		const res = await api('GET', '/new-releases/me?services=BOGUS,Spotify,spotify', { token: user.access_token });
		for (const a of res.body.actions ?? []) {
			expect(a).toMatchObject({ type: 'FETCH_NEW_RELEASES', service: 'spotify' });
		}
		expect((await api('GET', '/new-releases/me', { token: other.access_token })).body.albums).toEqual([]);
	});

	it('validates the ingest body', async () => {
		const token = upload_token;
		const bad = [
			{}, { token }, { token, artist_id: 'nope', service: 'spotify' }, { token, artist_id, service: 'bogus' }, { token, artist_id, service: 'spotify', contribution_id: 'nope' },
			{ token: '', artist_id, service: 'spotify' }, { token, artist_id, service: 'spotify', releases: 'x' },
			{ token, artist_id, service: 'soundcloud', soundcloud_items: Array.from({ length: 501 }, () => ({})) }
		];
		for (const body of bad) expect_error(await api('POST', '/ingest/new_releases', { token: user.access_token, body }), 400, 'invalid body');
	});

	it('answers 413 above the entity cap and 4mb', async () => {
		const tracks = Array.from({ length: 1001 }, (_, i) => ({ ref: `t${i}`, title: `T${i}` }));
		const res = await api('POST', '/ingest/new_releases', { token: user.access_token, body: { token: upload_token, artist_id, service: 'spotify', releases: { tracks } } });
		expect_error(res, 413, 'too many entities');
		expect_error(await api('POST', '/ingest/new_releases', { token: user.access_token, body: { token: upload_token, artist_id, service: 'spotify', releases: { tracks: [{ ref: 'a', title: 'x'.repeat(4_300_000) }] } } }), 413);
	});

	it('rejects tokens of the wrong type, another user and bad signatures', async () => {
		const body = { token: upload_token, artist_id, service: 'spotify' };
		expect_error(await api('POST', '/ingest/new_releases', { token: user.access_token, body }), 403, 'action token type mismatch');
		expect_error(await api('POST', '/ingest/new_releases', { token: other.access_token, body }), 403, 'action token issued to another user');
		expect_error(await api('POST', '/ingest/new_releases', { token: user.access_token, body: { ...body, token: 'garbage' } }), 403, 'invalid or expired action token');
	});

	it('accepts a real check action once, then refuses a replay', async () => {
		const fresh = await create_user('ing-nr');
		const refs = (await contribute(fresh, mock_album({ artist: unique('NR Artist'), album: unique('NR Album'), n: 1 }))).body.refs;
		await add_to_library(fresh, [refs.t0]);
		const listed = await api('GET', '/new-releases/me?services=spotify', { token: fresh.access_token });
		const action = listed.body.actions.find((a: { artist_id: string }) => a.artist_id === refs.ar);
		expect(action).toMatchObject({ type: 'FETCH_NEW_RELEASES', service: 'spotify' });
		expect((await api('GET', '/new-releases/me?services=spotify', { token: fresh.access_token })).body.actions).toBeUndefined();
		const body = { token: action.token, artist_id: action.artist_id, service: action.service };
		const first = await api('POST', '/ingest/new_releases', { token: fresh.access_token, body });
		expect(first.status).toBe(200);
		expect_error(await api('POST', '/ingest/new_releases', { token: fresh.access_token, body }), 403, 'action token already used');
		expect_error(await api('POST', '/ingest/new_releases', { token: fresh.access_token, body: { ...body, artist_id: uuid() } }), 403, 'action token target mismatch');
	});
});

describe('backpack', () => {
	const report = (id: string, body: unknown, token = user.access_token) => api('POST', `/tracks/${id}/unavailable`, { token, body });

	it('rejects bad ids, unknown tracks and malformed reports', async () => {
		expect_error(await report('nope', { service: 'youtube' }), 400, 'invalid track id');
		expect_error(await report(uuid(), { service: 'youtube' }), 404, 'track not found');
		for (const body of [{}, { service: 'spotify' }, { service: 'youtube', reason: 'r'.repeat(257) }, { service: 5 }, { service: 'youtube', reason: 5 }]) {
			expect_error(await report(track_id, body), 400, 'invalid body');
		}
		expect_error(await report(track_id, { service: 'youtube', reason: 'x'.repeat(9000) }), 413);
	});

	it('is idempotent and keeps backpacked_at stable across repeated and cross-user reports', async () => {
		const refs = (await contribute(user, mock_album({ artist: unique('BP Artist'), album: unique('BP Album'), n: 1 }))).body.refs;
		// Only a report from someone with the track in their library flags it
		await add_to_library(user, [refs.t0]);
		await add_to_library(other, [refs.t0]);
		const first = await report(refs.t0, { service: 'youtube', reason: 'one' });
		const second = await report(refs.t0, { service: 'youtube' });
		const third = await report(refs.t0, { service: 'soundcloud' }, other.access_token);
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ track_id: refs.t0, backpacked: true, has_media: false });
		expect(second.body.backpacked_at).toBe(first.body.backpacked_at);
		expect(third.body.backpacked_at).toBe(first.body.backpacked_at);
	});

	it('validates the requests limit and returns actions', async () => {
		for (const q of ['limit=0', 'limit=51', 'limit=x']) expect_error(await api('GET', `/backpack/requests?${q}`, { token: user.access_token }), 400, 'invalid query');
		const res = await api('GET', '/backpack/requests?limit=50', { token: user.access_token });
		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.actions)).toBe(true);
	});

	it('validates the research body', async () => {
		const token = upload_token;
		const bad = [
			{}, { token, track_id, service: 'youtube' }, { token, track_id, service: 'youtube', result: 'NOT_FOUND', service_id: 'x' },
			{ token, track_id: 'nope', service: 'youtube', result: 'NOT_FOUND' }, { token, track_id, service: 'spotify', result: 'NOT_FOUND' },
			{ token, track_id, service: 'youtube', result: 'FOUND' }, { token, track_id, service: 'youtube', service_id: '' },
			{ token, track_id, service: 'youtube', service_id: 'x'.repeat(513) }, { token: '', track_id, service: 'youtube', result: 'NOT_FOUND' }
		];
		for (const body of bad) expect_error(await api('POST', '/ingest/track_research', { token: user.access_token, body }), 400, 'invalid body');
	});

	it('rejects research tokens of the wrong type or user', async () => {
		const body = { token: upload_token, track_id, service: 'youtube', result: 'NOT_FOUND' };
		expect_error(await api('POST', '/ingest/track_research', { token: user.access_token, body }), 403, 'action token type mismatch');
		expect_error(await api('POST', '/ingest/track_research', { token: other.access_token, body }), 403, 'action token issued to another user');
		expect_error(await api('POST', '/ingest/track_research', { token: user.access_token, body: { ...body, token: 'garbage' } }), 403, 'invalid or expired action token');
	});

	it('limits reports to 60 per minute with 429', async () => {
		const u = await create_user('bp-rl');
		let last = 0;
		for (let i = 0; i < 61; i++) last = (await api('GET', '/backpack/requests', { token: u.access_token })).status;
		expect(last).toBe(429);
		expect_error(await api('GET', '/backpack/requests', { token: u.access_token }), 429, 'rate limited');
	});
});
