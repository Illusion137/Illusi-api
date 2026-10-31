import { beforeAll, describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, query, unique, uuid, wav_bytes } from './helpers';
import type { TestUser } from './helpers';

let user: TestUser;
let other: TestUser;
let track_id: string;

const expect_error = (res: { status: number; body: any }, status: number, message?: string) => {
	expect(res.status).toBe(status);
	expect(typeof res.body.error).toBe('string');
	if (message) expect(res.body.error).toBe(message);
};

const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function multipart(file: Buffer | null, fields: Record<string, string> = {}, type = 'image/png') {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	if (file) form.append('file', new Blob([new Uint8Array(file)], { type }), 'f.bin');
	return form;
}

async function new_playlist(owner: TestUser, extra: Record<string, unknown> = {}) {
	const id = uuid();
	await api('POST', '/sync/push', { token: owner.access_token, body: { push_id: uuid(), changes: { playlists: [{ id, title: unique('PL'), edited_at: new Date().toISOString(), ...extra }] } } });
	return id;
}

beforeAll(async () => {
	user = await create_user('amp');
	other = await create_user('amp-other');
	track_id = (await contribute(user, mock_album({ artist: unique('AMP Artist'), album: unique('AMP Album'), n: 1 }))).body.refs.t0;
	await add_to_library(user, [track_id]);
});

describe('auth required', () => {
	it('answers 401 without a token on account, media and playlist routes', async () => {
		const id = uuid();
		const routes: [string, string][] = [
			['POST', '/me/export'], ['GET', '/me/exports'], ['GET', `/me/export/${id}`], ['GET', `/me/export/${id}/file`], ['DELETE', '/me'],
			['POST', `/tracks/${track_id}/media`], ['GET', '/media/requests'], ['GET', '/media/abc.m4a'],
			['POST', `/playlists/${id}/copy`], ['PUT', `/playlists/${id}/artwork`], ['DELETE', `/playlists/${id}/artwork`], ['GET', `/artwork/${id}`]
		];
		for (const [method, path] of routes) expect_error(await api(method, path), 401, 'missing access token');
	});
});

async function seed_job(user_id: string, status: string): Promise<string> {
	return (await query(`insert into export_jobs_table (user_id, status) values ($1, $2) returning id`, [user_id, status]))[0].id;
}

describe('data export', () => {
	it('answers 409 while an export is in progress and lists it', async () => {
		const u = await create_user('exp');
		const running = await seed_job(u.id, 'RUNNING');
		const again = await api('POST', '/me/export', { token: u.access_token });
		expect_error(again, 409, 'an export is already in progress');
		expect(again.body.export).toMatchObject({ id: running, status: 'RUNNING', size: null, error: null });
		const list = await api('GET', '/me/exports', { token: u.access_token });
		expect(list.body.items.map((j: { id: string }) => j.id)).toEqual([running]);
		const one = await api('GET', `/me/export/${running}`, { token: u.access_token });
		expect(one.body.id).toBe(running);
		expect(one.headers.get('cache-control')).toBe('no-store');
	});

	it('starts an export with 202 for a user without one', async () => {
		const u = await create_user('exp-new');
		const started = await api('POST', '/me/export', { token: u.access_token });
		expect(started.status).toBe(202);
		expect(Object.keys(started.body).sort()).toEqual(['created_at', 'error', 'expires_at', 'finished_at', 'id', 'size', 'started_at', 'status']);
		expect((await api('GET', '/me/exports', { token: u.access_token })).body.items.map((j: { id: string }) => j.id)).toEqual([started.body.id]);
	});

	it('hides exports from other users and rejects bad ids', async () => {
		const u = await create_user('exp-own');
		const job = await seed_job(u.id, 'RUNNING');
		for (const path of [`/me/export/${job}`, `/me/export/${job}/file`]) {
			expect_error(await api('GET', path, { token: other.access_token }), 404, 'export not found');
		}
		expect((await api('GET', '/me/exports', { token: other.access_token })).body.items).toEqual([]);
		expect_error(await api('GET', '/me/export/nope', { token: u.access_token }), 400, 'invalid export id');
		expect_error(await api('GET', '/me/export/nope/file', { token: u.access_token }), 400, 'invalid export id');
		expect_error(await api('GET', `/me/export/${uuid()}`, { token: u.access_token }), 404, 'export not found');
	});

	it('answers 409 for a file that is not ready and 410 for expired or missing ones', async () => {
		const u = await create_user('exp-file');
		const job = await seed_job(u.id, 'RUNNING');
		const file = await api('GET', `/me/export/${job}/file`, { token: u.access_token });
		expect_error(file, 409, 'export is not ready');
		expect(file.body.export.status).toBe('RUNNING');

		await query(`update export_jobs_table set status = 'READY', file_name = $2, finished_at = now(), expires_at = now() + interval '1 day' where id = $1`, [job, `${uuid()}.json.gz`]);
		expect_error(await api('GET', `/me/export/${job}/file`, { token: u.access_token }), 410, 'export expired; request a new one');
		await query(`update export_jobs_table set expires_at = now() - interval '1 minute' where id = $1`, [job]);
		expect_error(await api('GET', `/me/export/${job}/file`, { token: u.access_token }), 410, 'export expired; request a new one');
		await query(`update export_jobs_table set status = 'EXPIRED' where id = $1`, [job]);
		expect_error(await api('GET', `/me/export/${job}/file`, { token: u.access_token }), 410, 'export expired; request a new one');
	});

	it('answers 429 with Retry-After inside the cooldown, and allows a retry after a failure', async () => {
		const u = await create_user('exp-cool');
		const job = await seed_job(u.id, 'READY');
		const limited = await api('POST', '/me/export', { token: u.access_token });
		expect_error(limited, 429, 'an export was requested recently');
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(limited.body.retry_after_s).toBeGreaterThan(0);
		expect(limited.body.export.id).toBe(job);
		await query(`update export_jobs_table set status = 'FAILED' where id = $1`, [job]);
		expect((await api('POST', '/me/export', { token: u.access_token })).status).toBe(202);
	});

	it('limits export routes to 30 requests per minute', async () => {
		const u = await create_user('exp-rl');
		let last = 0;
		for (let i = 0; i < 31; i++) last = (await api('GET', '/me/exports', { token: u.access_token })).status;
		expect(last).toBe(429);
		expect_error(await api('GET', '/me/exports', { token: u.access_token }), 429, 'rate limited');
	});
});

describe('account deletion validation', () => {
	it('rejects a missing, empty, non-string or oversize password', async () => {
		const u = await create_user('del');
		for (const body of [{}, { password: '' }, { password: 5 }, { password: 'x'.repeat(1025) }]) {
			expect_error(await api('DELETE', '/me', { token: u.access_token, body }), 400, 'invalid body');
		}
		expect_error(await api('DELETE', '/me', { token: u.access_token, body: { password: 'x'.repeat(5000) } }), 413);
		expect((await api('GET', '/me', { token: u.access_token })).status).toBe(200);
	});

	it('answers 401 for a wrong password, 429 after five attempts, and keeps the account', async () => {
		const u = await create_user('del-rl');
		for (let i = 0; i < 5; i++) expect_error(await api('DELETE', '/me', { token: u.access_token, body: { password: 'wrong-password' } }), 401, 'invalid password');
		expect_error(await api('DELETE', '/me', { token: u.access_token, body: { password: u.password } }), 429, 'too many attempts');
		expect((await api('GET', '/me', { token: u.access_token })).status).toBe(200);
	});
});

describe('media validation', () => {
	const upload = (token: string, id: string, body: FormData) => api('POST', `/tracks/${id}/media`, { token, raw: body });

	it('rejects bad track ids and unknown tracks', async () => {
		expect_error(await upload(user.access_token, 'nope', multipart(wav_bytes(1), {}, 'audio/wav')), 400, 'invalid track id');
		expect_error(await upload(user.access_token, uuid(), multipart(wav_bytes(1), {}, 'audio/wav')), 404, 'track not found');
	});

	it('rejects uploads that are not multipart, have no file, are empty or are not audio', async () => {
		expect_error(await api('POST', `/tracks/${track_id}/media`, { token: user.access_token, body: { a: 1 } }), 400, 'expected multipart/form-data');
		expect_error(await upload(user.access_token, track_id, multipart(null, { quality: 'x' })), 400, 'missing file part');
		expect_error(await upload(user.access_token, track_id, multipart(Buffer.alloc(0), {}, 'audio/wav')), 415);
		expect_error(await upload(user.access_token, track_id, multipart(Buffer.from('this is plainly not audio '.repeat(40)), {}, 'audio/wav')), 415);
	});

	it('rejects invalid upload fields', async () => {
		expect_error(await upload(user.access_token, track_id, multipart(wav_bytes(7), { quality: 'q'.repeat(33) }, 'audio/wav')), 400, 'invalid body');
		expect_error(await upload(user.access_token, track_id, multipart(wav_bytes(7), { token: 'x'.repeat(5000) }, 'audio/wav')), 400, 'invalid body');
	});

	it('rejects an upload with a forged token for a track outside the library', async () => {
		const res = await upload(other.access_token, track_id, multipart(wav_bytes(Math.floor(Math.random() * 100_000) + 10), { token: 'forged' }, 'audio/wav'));
		expect_error(res, 401, 'invalid or expired action token');
	});

	it('validates media request queries', async () => {
		for (const q of ['limit=0', 'limit=201', 'limit=x', 'cursor=nope']) {
			expect_error(await api('GET', `/media/requests?${q}`, { token: user.access_token }), 400, 'invalid query');
		}
		const res = await api('GET', '/media/requests?limit=1', { token: user.access_token });
		expect(res.status).toBe(200);
		expect(res.body.actions.length).toBeLessThanOrEqual(1);
	});

	it('rejects malformed resource ids and answers 404 for unknown ones', async () => {
		for (const id of ['nope', 'abc.m4a', '..%2Fetc%2Fpasswd', `${uuid()}.exe`, `${'a'.repeat(64)}`]) {
			expect_error(await api('GET', `/media/${id}`, { token: user.access_token }), 400, 'invalid resource id');
		}
		expect_error(await api('GET', `/media/${uuid()}.m4a`, { token: user.access_token }), 404, 'media not found');
	});
});

describe('playlist copy and artwork', () => {
	it('rejects bad ids and answers 404 for unknown or private playlists', async () => {
		expect_error(await api('POST', '/playlists/nope/copy', { token: user.access_token }), 400, 'invalid playlist id');
		expect_error(await api('POST', `/playlists/${uuid()}/copy`, { token: user.access_token }), 404, 'playlist not found');
		const priv = await new_playlist(user, { public: false });
		expect_error(await api('POST', `/playlists/${priv}/copy`, { token: other.access_token }), 404, 'playlist not found');
	});

	it('copies a public playlist as a private one owned by the caller, repeatedly', async () => {
		const pub = await new_playlist(user, { public: true });
		const a = await api('POST', `/playlists/${pub}/copy`, { token: other.access_token });
		const b = await api('POST', `/playlists/${pub}/copy`, { token: other.access_token });
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		expect(a.body.playlist.id).not.toBe(b.body.playlist.id);
		expect((await api('GET', `/playlists/${a.body.playlist.id}`, { token: other.access_token })).body.public).toBe(false);
	});

	it('does not copy a deleted public playlist for other users', async () => {
		const id = await new_playlist(user, { public: true });
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { playlists: [{ id, deleted: true, edited_at: new Date(Date.now() + 1000).toISOString() }] } } });
		expect_error(await api('POST', `/playlists/${id}/copy`, { token: other.access_token }), 404, 'playlist not found');
	});

	it('rejects artwork requests for bad ids, foreign playlists and unknown playlists', async () => {
		const mine = await new_playlist(user);
		expect_error(await api('PUT', '/playlists/nope/artwork', { token: user.access_token, raw: multipart(png()) }), 400, 'invalid playlist id');
		expect_error(await api('PUT', `/playlists/${uuid()}/artwork`, { token: user.access_token, raw: multipart(png()) }), 404, 'playlist not found');
		expect_error(await api('PUT', `/playlists/${mine}/artwork`, { token: other.access_token, raw: multipart(png()) }), 404, 'playlist not found');
		expect_error(await api('DELETE', `/playlists/${mine}/artwork`, { token: other.access_token }), 404, 'playlist not found');
		expect_error(await api('DELETE', '/playlists/nope/artwork', { token: user.access_token }), 400, 'invalid playlist id');
	});

	it('rejects bad artwork bodies', async () => {
		const mine = await new_playlist(user);
		const put = (form: FormData) => api('PUT', `/playlists/${mine}/artwork`, { token: user.access_token, raw: form });
		expect_error(await api('PUT', `/playlists/${mine}/artwork`, { token: user.access_token, body: { a: 1 } }), 400, 'expected multipart/form-data');
		expect_error(await put(multipart(null)), 400, 'missing file part');
		expect_error(await put(multipart(Buffer.alloc(0))), 415);
		expect_error(await put(multipart(Buffer.from('plain text, not an image '.repeat(30)), {}, 'image/png')), 415);
		expect_error(await put(multipart(png(), { edited_at: 'yesterday' })), 400, 'invalid body');
		expect_error(await put(multipart(png(), { edited_at: 'x'.repeat(2000) })), 413, 'field edited_at too large');
	});

	it('rejects an invalid edited_at on artwork removal', async () => {
		const mine = await new_playlist(user);
		expect_error(await api('DELETE', `/playlists/${mine}/artwork?edited_at=yesterday`, { token: user.access_token }), 400, 'invalid query');
		const res = await api('DELETE', `/playlists/${mine}/artwork`, { token: user.access_token });
		expect(res.status).toBe(200);
	});

	it('serves artwork to its owner, hides it from others while private and answers 304', async () => {
		const mine = await new_playlist(user);
		const set = await api('PUT', `/playlists/${mine}/artwork`, { token: user.access_token, raw: multipart(png()) });
		expect(set.status).toBe(200);
		const artwork_id: string = set.body.playlist.artwork_id;
		const got = await api('GET', `/artwork/${artwork_id}`, { token: user.access_token });
		expect(got.status).toBe(200);
		expect(got.headers.get('content-type')).toBe('image/jpeg');
		expect(got.headers.get('etag')).toBe(`"${artwork_id}"`);
		expect((await api('GET', `/artwork/${artwork_id}`, { token: user.access_token, headers: { 'if-none-match': `"${artwork_id}"` } })).status).toBe(304);
		expect_error(await api('GET', `/artwork/${artwork_id}`, { token: other.access_token }), 404, 'artwork not found');
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { playlists: [{ id: mine, public: true, edited_at: new Date(Date.now() + 1000).toISOString() }] } } });
		expect((await api('GET', `/artwork/${artwork_id}`, { token: other.access_token })).status).toBe(200);
	});

	it('rejects malformed artwork ids and answers 404 for unknown ones', async () => {
		expect_error(await api('GET', '/artwork/nope', { token: user.access_token }), 400, 'invalid artwork id');
		expect_error(await api('GET', `/artwork/${uuid()}`, { token: user.access_token }), 400, 'invalid artwork id');
		expect_error(await api('GET', `/artwork/${uuid()}.jpg`, { token: user.access_token }), 404, 'artwork not found');
	});
});
