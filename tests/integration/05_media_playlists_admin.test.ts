import { describe, expect, it } from 'vitest';
import { API_BASE, add_to_library, api, contribute, create_user, make_admin, mock_album, query, unique, uuid, wav_bytes } from './helpers';
import type { TestUser } from './helpers';

function upload(user: TestUser, track_id: string, file: Buffer, fields: Record<string, string> = {}, type = 'audio/wav') {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	form.append('file', new Blob([new Uint8Array(file)], { type }), 'song.wav');
	return api('POST', `/tracks/${track_id}/media`, { token: user.access_token, raw: form });
}

describe('media uploads (§13)', () => {
	it('asks for downloaded tracks, accepts the upload with the token, dedupes, and streams with ranges', async () => {
		const user = await create_user('media');
		const created = await contribute(user, mock_album({ artist: unique('Media Artist'), album: unique('Media Album'), n: 2 }));
		const [t0, t1] = [created.body.refs.t0, created.body.refs.t1];
		await add_to_library(user, [t0], { downloaded_at: new Date().toISOString() });
		await add_to_library(user, [t1]);

		const requests = await api('GET', '/media/requests', { token: user.access_token });
		expect(requests.body.actions.map((a: { track_id: string }) => a.track_id)).toEqual([t0]);
		const action = requests.body.actions[0];
		expect(action.type).toBe('UPLOAD_MEDIA');

		const file = wav_bytes(Math.floor(Math.random() * 1000));
		const stored = await upload(user, t0, file, { token: action.token, quality: 'lossless' });
		expect(stored.status).toBe(201);
		const resource_id: string = stored.body.media.resource_id;
		expect(resource_id).toMatch(/\.wav$/u);
		expect((await api('GET', '/media/requests', { token: user.access_token })).body.actions).toEqual([]);

		// Same bytes again (no token needed for a user's own library track): deduped by content hash.
		const dup = await upload(user, t0, file);
		expect(dup.status).toBe(200);
		expect(dup.body.duplicate).toBe(true);

		const full = await fetch_media(user, resource_id);
		expect(full.status).toBe(200);
		expect(Buffer.from(await full.arrayBuffer()).equals(file)).toBe(true);
		expect(full.headers.get('accept-ranges')).toBe('bytes');
		const part = await fetch_media(user, resource_id, { range: 'bytes=0-11' });
		expect(part.status).toBe(206);
		expect(part.headers.get('content-range')).toBe(`bytes 0-11/${file.length}`);
		expect(Buffer.from(await part.arrayBuffer()).toString('ascii', 8, 12)).toBe('WAVE');
		expect((await fetch_media(user, resource_id, { range: `bytes=${file.length + 10}-` })).status).toBe(416);

		// Another user only gets it once the track is in their library.
		const other = await create_user('media-other');
		expect((await fetch_media(other, resource_id)).status).toBe(403);
		await add_to_library(other, [t0]);
		expect((await fetch_media(other, resource_id)).status).toBe(200);
	});

	it('rejects non-audio files and tracks outside the user\'s library', async () => {
		const user = await create_user('media-bad');
		const created = await contribute(user, mock_album({ artist: unique('Bad Media'), album: unique('Bad Media Album'), n: 1 }));
		const t0 = created.body.refs.t0;
		const not_audio = await upload(user, t0, Buffer.from('#!/bin/sh\necho definitely not audio\n'.repeat(20)), {}, 'audio/wav');
		expect([403, 415]).toContain(not_audio.status);
		await add_to_library(user, [t0]);
		const after = await upload(user, t0, Buffer.from('<html>not audio</html>'.repeat(20)), {}, 'audio/wav');
		expect(after.status).toBe(415);
		expect((await upload(user, uuid(), wav_bytes())).status).toBe(404);
		expect((await api('GET', '/media/..%2F..%2Fetc%2Fpasswd', { token: user.access_token })).status).toBe(400);
	});
});

function fetch_media(user: TestUser, resource_id: string, headers: Record<string, string> = {}) {
	return fetch(`${API_BASE}/media/${resource_id}`, { headers: { authorization: `Bearer ${user.access_token}`, ...headers } });
}

describe('playlist copy (§10.2)', () => {
	it('copies another user\'s public playlist as a private one, and hides private ones', async () => {
		const owner = await create_user('pl-owner');
		const fan = await create_user('pl-fan');
		const created = await contribute(owner, mock_album({ artist: unique('PL Artist'), album: unique('PL Album'), n: 3 }));
		const tracks = [created.body.refs.t0, created.body.refs.t1, created.body.refs.t2];
		const now = new Date().toISOString();
		const [pub, priv] = [uuid(), uuid()];
		await api('POST', '/sync/push', {
			token: owner.access_token,
			body: {
				push_id: uuid(),
				changes: {
					playlists: [{ id: pub, title: 'Public Mix', public: true, edited_at: now }, { id: priv, title: 'Secret Mix', edited_at: now }],
					playlist_tracks: [...tracks.map(track_id => ({ playlist_id: pub, track_id, edited_at: now })), { playlist_id: priv, track_id: tracks[0], edited_at: now }]
				}
			}
		});

		const copy = await api('POST', `/playlists/${pub}/copy`, { token: fan.access_token });
		expect(copy.status).toBe(201);
		const new_id = copy.body.id ?? copy.body.playlist?.id;
		const [row] = await query(`select user_id, title, public from playlists_table where id = $1`, [new_id]);
		expect(row).toMatchObject({ user_id: fan.id, public: false });
		const copied = await query(`select track_id from playlist_tracks_table where playlist_id = $1 and not deleted`, [new_id]);
		expect(copied.map(r => r.track_id).sort()).toEqual([...tracks].sort());

		expect((await api('POST', `/playlists/${priv}/copy`, { token: fan.access_token })).status).toBe(404);
		expect((await api('POST', `/playlists/${uuid()}/copy`, { token: fan.access_token })).status).toBe(404);
	});
});

describe('admin review (§11)', () => {
	it('is admin-only, re-checking the role in the database', async () => {
		const user = await create_user('not-admin');
		expect((await api('GET', '/admin/review', { token: user.access_token })).status).toBe(403);
		const admin = await make_admin(await create_user('admin'));
		expect((await api('GET', '/admin/review', { token: admin.access_token })).status).toBe(200);
		// Demotion takes effect immediately, even with a token that still says ADMIN.
		await query(`update users_table set role = 'USER' where id = $1`, [admin.id]);
		expect((await api('GET', '/admin/review', { token: admin.access_token })).status).toBe(403);
	});

	it('lists a field conflict, applies the proposed value, and edits entities directly', async () => {
		const admin = await make_admin(await create_user('admin2'));
		const a = await create_user('rev-a');
		const b = await create_user('rev-b');
		const created = await contribute(a, mock_album({ artist: unique('Review Artist'), album: unique('Review Album'), n: 1 }));
		const track_id = created.body.refs.t0;
		const title = (await query(`select title from tracks_table where id = $1`, [track_id]))[0].title;
		await contribute(b, { tracks: [{ ref: track_id, title, duration_ms: 240_000 }] });

		const list = await api('GET', '/admin/review?kind=FIELD_CONFLICT&limit=100', { token: admin.access_token });
		const item = list.body.items.find((i: { entity_id: string; field: string }) => i.entity_id === track_id && i.field === 'duration_ms');
		expect(item).toBeDefined();
		const applied = await api('POST', `/admin/review/${item.id}/apply`, { token: admin.access_token, body: {} });
		expect(applied.status).toBe(200);
		expect((await query(`select duration_ms from tracks_table where id = $1`, [track_id]))[0].duration_ms).toBe('240000');
		expect((await query(`select status from review_items_table where id = $1`, [item.id]))[0].status).toBe('APPLIED');
		expect((await api('POST', `/admin/review/${item.id}/dismiss`, { token: admin.access_token })).status).toBe(409);

		const patched = await api('PATCH', `/admin/entities/tracks/${track_id}`, { token: admin.access_token, body: { title: `${title} (Admin Fix)`, explicit: true } });
		expect(patched.status).toBe(200);
		expect(await query(`select title, explicit from tracks_table where id = $1`, [track_id])).toEqual([{ title: `${title} (Admin Fix)`, explicit: true }]);
		const audit = await query(`select action, actor_user_id from audit_log_table where entity_id = $1 order by id`, [track_id]);
		expect(audit.map(r => r.actor_user_id)).toContain(admin.id);
		expect((await api('PATCH', `/admin/entities/users/${a.id}`, { token: admin.access_token, body: { role: 'ADMIN' } })).status).toBe(404);
	});
});
