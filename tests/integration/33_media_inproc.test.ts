import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
const { API_BASE, add_to_library, api, contribute, create_user, mock_album, query, unique, uuid, wav_bytes } = await import('./helpers');
const { config } = await import('../../src/config');
const { db } = await import('../../src/db');
const { issue_action } = await import('../../src/core/actions');
const { pending_upload_actions } = await import('../../src/services/media');
const { token_target, user_can_access_tracks } = await import('../../src/services/media/store');

afterAll(async () => { await app.stop(); });

type User = Awaited<ReturnType<typeof create_user>>;
const auth_user = (u: User) => ({ id: u.id, role: 'USER' as const, sid: JSON.parse(Buffer.from(u.access_token.split('.')[1], 'base64url').toString()).sid as string });

const downloaded = () => ({ downloaded_at: new Date().toISOString() });

/** Imported tracks in the user's library (an upload without a token has to be for one) */
async function imported_track(user: User, n = 1) {
	const created = await contribute(user, mock_album({ artist: unique('Media Artist'), album: unique('Media Album'), n, imported: true }));
	const ids = Array.from({ length: n }, (_, i) => created.body.refs[`t${i}`] as string);
	await add_to_library(user, ids);
	return ids;
}

function form_with(parts: [string, string | Blob, string?][]) {
	const form = new FormData();
	for (const [name, value, filename] of parts) {
		if (filename === undefined) form.append(name, value);
		else form.append(name, value, filename);
	}
	return form;
}

const wav_blob = (seed = Math.floor(Math.random() * 100_000)) => new Blob([new Uint8Array(wav_bytes(seed))], { type: 'audio/wav' });

function upload(user: User, track_id: string, parts: [string, string | Blob, string?][]) {
	return api('POST', `/tracks/${track_id}/media`, { token: user.access_token, raw: form_with(parts) });
}

describe('media upload errors', () => {
	it('rejects bad ids, non-multipart bodies and missing or misnamed files', async () => {
		const user = await create_user('media-err');
		const [t] = await imported_track(user);
		expect((await upload(user, 'nope', [['file', wav_blob(), 'a.wav']])).status).toBe(400);
		expect((await api('POST', `/tracks/${t}/media`, { token: user.access_token, body: { x: 1 } })).status).toBe(400);
		expect((await upload(user, t, [['quality', 'lossless']])).body).toMatchObject({ error: expect.stringContaining('missing file') });
		// Only the first file part is read, and it has to be named `file`.
		expect((await upload(user, t, [['other', wav_blob(), 'a.wav']])).status).toBe(400);
		expect((await upload(user, t, [['file', wav_blob(), 'a.wav'], ['other', wav_blob(), 'b.wav']])).status).toBe(201);
		expect((await upload(user, uuid(), [['file', wav_blob(), 'a.wav']])).status).toBe(404);
	});

	it('rejects empty files, oversized fields, invalid fields and undecodable audio', async () => {
		const user = await create_user('media-err2');
		const [t] = await imported_track(user);
		expect((await upload(user, t, [['file', new Blob([]), 'a.wav']])).status).toBe(415);
		expect((await upload(user, t, [['quality', 'x'.repeat(9_000)], ['file', wav_blob(), 'a.wav']])).status).toBe(413);
		expect((await upload(user, t, [['quality', 'x'.repeat(40)], ['file', wav_blob(), 'a.wav']])).status).toBe(400);
		// Sniffs as WAV but has no decodable audio.
		const broken = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(300, 7)]);
		expect((await upload(user, t, [['file', new Blob([new Uint8Array(broken)]), 'a.wav']])).status).toBe(422);
		expect(await query(`select 1 from media_table where track_id = $1`, [t])).toHaveLength(0);
	});

	it('refuses an unsolicited upload outside the library, and any second upload, before reading the body', async () => {
		const user = await create_user('media-refuse');
		const created = await contribute(user, mock_album({ artist: unique('Refused Artist'), album: unique('Refused Album'), n: 1, imported: true }));
		const t: string = created.body.refs.t0;
		expect((await upload(user, t, [['file', wav_blob(), 'a.wav']])).body).toMatchObject({ code: 'NOT_IN_LIBRARY' });
		await add_to_library(user, [t]);
		const first = await upload(user, t, [['file', wav_blob(), 'a.wav']]);
		expect(first.status).toBe(201);
		const second = await upload(user, t, [['file', wav_blob(), 'a.wav']]);
		expect(second.status).toBe(409);
		expect(second.body).toMatchObject({ code: 'TRACK_HAS_MEDIA', media: { resource_id: first.body.media.resource_id } });
		// A token sent as a header is checked up front too
		const res = await api('POST', `/tracks/${t}/media`, { token: user.access_token, headers: { 'x-action-token': 'forged.token.value' }, raw: form_with([['file', wav_blob(), 'a.wav']]) });
		expect(res.body).toMatchObject({ code: 'ACTION_TOKEN_INVALID' });
	});

	it('refuses uploads over the size limit', async () => {
		const user = await create_user('media-big');
		const [t] = await imported_track(user);
		const original = config.MEDIA_MAX_BYTES;
		config.MEDIA_MAX_BYTES = 1_000;
		try {
			expect((await upload(user, t, [['file', wav_blob(), 'a.wav']])).status).toBe(413);
		} finally {
			config.MEDIA_MAX_BYTES = original;
		}
	});

	it('refuses invalid, replayed and misdirected upload tokens', async () => {
		const user = await create_user('media-token');
		const [t, other] = await imported_track(user, 2);
		expect((await upload(user, t, [['token', 'forged.token.value'], ['file', wav_blob(), 'a.wav']])).status).toBe(403);
		const for_other = (await issue_action(auth_user(user), { type: 'UPLOAD_MEDIA', track_id: other })).token;
		expect((await upload(user, t, [['token', for_other], ['file', wav_blob(), 'a.wav']])).status).toBe(403);
		expect(token_target('not a jwt', 'a', 'b')).toBe('b');
		expect(await query(`select 1 from media_table where track_id = $1`, [t])).toHaveLength(0);
	});

	it('accepts a token issued for the pre-merge id through its redirect', async () => {
		const user = await create_user('media-redirect');
		const [t] = await imported_track(user);
		const old = uuid();
		await query(`insert into service_ids_table (illusi_id) values ($1)`, [old]);
		await query(`insert into illusi_id_redirects_table (old_id, new_id) values ($1, $2)`, [old, t]);
		const token = (await issue_action(auth_user(user), { type: 'UPLOAD_MEDIA', track_id: old })).token;
		const res = await upload(user, old, [['token', token], ['file', wav_blob(), 'a.wav']]);
		expect(res.status).toBe(201);
		expect(res.body.media.track_id).toBe(t);
	});
});

describe('media streaming', () => {
	async function stored(user: User) {
		const [t] = await imported_track(user);
		await add_to_library(user, [t], downloaded());
		const res = await upload(user, t, [['file', wav_blob(), 'a.wav']]);
		return { track_id: t, resource_id: res.body.media.resource_id as string };
	}
	const get = (user: User, resource_id: string, headers: Record<string, string> = {}, method = 'GET') =>
		fetch(`${API_BASE}/media/${resource_id}`, { method, headers: { authorization: `Bearer ${user.access_token}`, ...headers } });

	it('serves HEAD, validators, If-Range and open-ended ranges', async () => {
		const user = await create_user('media-stream');
		const { resource_id } = await stored(user);
		const head = await get(user, resource_id, {}, 'HEAD');
		expect(head.status).toBe(200);
		const size = Number(head.headers.get('content-length'));
		expect(size).toBeGreaterThan(0);
		expect(head.headers.get('etag')).toBe(`"${resource_id}"`);
		expect(head.headers.get('cache-control')).toContain('immutable');
		expect(await head.text()).toBe('');

		const open = await get(user, resource_id, { range: 'bytes=10-' });
		expect(open.status).toBe(206);
		expect(open.headers.get('content-range')).toBe(`bytes 10-${size - 1}/${size}`);
		expect((await open.arrayBuffer()).byteLength).toBe(size - 10);

		const matching = await get(user, resource_id, { range: 'bytes=0-3', 'if-range': `"${resource_id}"` });
		expect(matching.status).toBe(206);
		await matching.arrayBuffer();
		const stale = await get(user, resource_id, { range: 'bytes=0-3', 'if-range': '"other"' });
		expect(stale.status).toBe(200);
		expect((await stale.arrayBuffer()).byteLength).toBe(size);
		const bad = await get(user, resource_id, { range: `bytes=${size}-` });
		expect(bad.status).toBe(416);
		expect(bad.headers.get('content-range')).toBe(`bytes */${size}`);
	});

	it('answers 404 for unknown or vanished media and 400 for odd ids, and streams to anyone with the id', async () => {
		const user = await create_user('media-missing');
		expect((await get(user, `${uuid()}.m4a`)).status).toBe(404);
		expect((await get(user, 'not-a-resource')).status).toBe(400);
		const { resource_id } = await stored(user);
		const outsider = await create_user('media-outsider');
		expect((await get(outsider, resource_id)).status).toBe(200);
		expect((await fetch(`${API_BASE}/media/${resource_id}`)).status).toBe(200);
		expect(await user_can_access_tracks(db, outsider.id, [])).toBe(false);
		await rm(path.join(config.MEDIA_DIR, resource_id));
		expect((await get(user, resource_id)).status).toBe(404);
	});

	it('redirects to the media bucket once the file has moved there, without a session', async () => {
		const user = await create_user('media-remote');
		const { resource_id } = await stored(user);
		await rm(path.join(config.MEDIA_DIR, resource_id));
		const original = config.MEDIA_PUBLIC_URL;
		config.MEDIA_PUBLIC_URL = 'https://bucket.example.com/abc:illusi-media';
		try {
			const res = await fetch(`${API_BASE}/media/${resource_id}`, { redirect: 'manual' });
			expect(res.status).toBe(302);
			expect(res.headers.get('location')).toBe(`https://bucket.example.com/abc:illusi-media/${resource_id}`);
		} finally {
			config.MEDIA_PUBLIC_URL = original;
		}
	});
});

describe('upload requests', () => {
	it('pages through pending requests and puts backpacked tracks first', async () => {
		const user = await create_user('media-requests');
		const ids = await imported_track(user, 3);
		await add_to_library(user, ids, downloaded());
		const first = await api('GET', '/media/requests?limit=2', { token: user.access_token });
		expect(first.body.actions).toHaveLength(2);
		expect(first.body.next_cursor).toBe(first.body.actions[1].track_id);
		const second = await api('GET', `/media/requests?limit=2&cursor=${first.body.next_cursor}`, { token: user.access_token });
		expect(second.body.actions.map((a: { track_id: string }) => a.track_id)).toEqual([[...ids].sort()[2]]);
		expect(second.body.next_cursor).toBeNull();
		expect((await api('GET', '/media/requests?limit=0', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', '/media/requests?cursor=nope', { token: user.access_token })).status).toBe(400);

		const u = auth_user(user);
		expect(await pending_upload_actions(u, 0)).toEqual([]);
		const last = [...ids].sort()[2];
		await query(`update tracks_table set backpacked = true, backpacked_at = now() - interval '2 days' where id = $1`, [last]);
		const mixed = await pending_upload_actions(u, 2);
		expect(mixed.map(a => a.track_id)[0]).toBe(last);
		expect(mixed).toHaveLength(2);
		expect(await pending_upload_actions(u, 1)).toHaveLength(1);
	});
});

describe('alignment requests', () => {
	it('queues each track once an hour, up to the per-user cap', async () => {
		const { on } = await import('../../src/core/events');
		const asked: string[] = [];
		on('alignment_requested', ({ track_id }) => { asked.push(track_id); });
		const user = await create_user('align-cap');
		const other = await create_user('align-cap-other');
		const tracks: string[] = [];
		for (let a = 0; a < 4; a++) {
			const created = await contribute(user, mock_album({ artist: unique('Align Cap'), album: unique('Align Cap Album'), n: 8 }));
			for (let i = 0; i < 8; i++) tracks.push(created.body.refs[`t${i}`] as string);
		}
		expect(new Set(tracks).size).toBe(32);
		const ask = (u: User, t: string) => api('GET', `/tracks/${t}/alignment`, { token: u.access_token });
		for (const t of tracks.slice(0, 2)) expect((await ask(user, t)).status).toBe(404);
		// The same track again doesn't use up the budget or queue it twice
		for (let i = 0; i < 5; i++) await ask(user, tracks[0]);
		for (const t of tracks.slice(2)) expect((await ask(user, t)).status).toBe(404);
		expect((await ask(other, tracks[31])).status).toBe(404);
		await vi.waitFor(() => expect(asked.filter(t => tracks.includes(t))).toHaveLength(31));
		expect(asked.filter(t => tracks.includes(t))).toEqual([...tracks.slice(0, 30), tracks[31]]);
	});
});
