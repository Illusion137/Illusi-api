import { existsSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, eventually, mock_album, query, unique, uuid, wav_bytes } from './helpers';
import type { TestUser } from './helpers';

/** A valid `size`×`size` RGB PNG filled with one color. */
function png(size = 8, rgb: [number, number, number] = [200, 30, 90]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // RGB
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
	const pixels = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(pixels)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function upload_artwork(user: TestUser, playlist_id: string, file: Buffer, fields: Record<string, string> = {}) {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	form.append('file', new Blob([new Uint8Array(file)], { type: 'image/png' }), 'cover.png');
	return api('PUT', `/playlists/${playlist_id}/artwork`, { token: user.access_token, raw: form });
}

async function push(user: TestUser, changes: Record<string, unknown>) {
	const res = await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes } });
	if (res.status !== 200) throw new Error(`push failed: ${res.status} ${res.text}`);
	return res.body;
}

async function new_playlist(user: TestUser, extra: Record<string, unknown> = {}): Promise<string> {
	const id = uuid();
	await push(user, { playlists: [{ id, title: unique('Artwork Mix'), edited_at: new Date().toISOString(), ...extra }] });
	return id;
}

describe('playlist artwork', () => {
	it('uploads, normalizes, serves with access rules, syncs, and keeps the newest edit', async () => {
		const owner = await create_user('artwork');
		const other = await create_user('artwork-other');
		const playlist_id = await new_playlist(owner);

		const set = await upload_artwork(owner, playlist_id, png(2000));
		expect(set.status).toBe(200);
		expect(set.body.applied).toBe(true);
		const artwork_id: string = set.body.playlist.artwork_id;
		expect(artwork_id).toMatch(/^[0-9a-f-]{36}\.jpg$/u);
		expect(set.body.playlist.artwork_edited_at).toBeTruthy();

		const file = await fetch_artwork(owner, artwork_id);
		expect(file.status).toBe(200);
		expect(file.headers.get('content-type')).toBe('image/jpeg');
		expect(file.headers.get('cache-control')).toContain('immutable');
		const bytes = Buffer.from(await file.arrayBuffer());
		expect(bytes.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))).toBe(true);
		expect(jpeg_size(bytes)).toEqual({ width: 1024, height: 1024 });
		expect((await fetch_artwork(owner, artwork_id, { 'if-none-match': `"${artwork_id}"` })).status).toBe(304);

		// Private: hidden from others until the playlist is public.
		expect((await fetch_artwork(other, artwork_id)).status).toBe(404);
		await push(owner, { playlists: [{ id: playlist_id, public: true, edited_at: new Date().toISOString() }] });
		expect((await fetch_artwork(other, artwork_id)).status).toBe(200);
		const seen = await api('GET', `/playlists/${playlist_id}`, { token: other.access_token });
		expect(seen.body.artwork_id).toBe(artwork_id);

		// Other devices get it through sync pull, once the change is past the pull's safety margin.
		await new Promise(r => setTimeout(r, 2_200));
		const pulled = await api('POST', '/sync/pull', { token: owner.access_token, body: {} });
		expect(pulled.body.playlists.find((p: { id: string }) => p.id === playlist_id)?.artwork_id).toBe(artwork_id);

		// An older edit loses and leaves no file behind; a playlist row edit doesn't touch the artwork.
		const stale = await upload_artwork(owner, playlist_id, png(16, [1, 2, 3]), { edited_at: new Date(Date.now() - 3_600_000).toISOString() });
		expect(stale.status).toBe(200);
		expect(stale.body.applied).toBe(false);
		expect(stale.body.playlist.artwork_id).toBe(artwork_id);
		await push(owner, { playlists: [{ id: playlist_id, title: 'Renamed', edited_at: new Date().toISOString() }] });
		expect((await api('GET', `/playlists/${playlist_id}`, { token: owner.access_token })).body.artwork_id).toBe(artwork_id);

		// Replacing removes the old file; removing clears it.
		const replaced = await upload_artwork(owner, playlist_id, png(32, [9, 9, 9]));
		expect(replaced.body.applied).toBe(true);
		expect((await fetch_artwork(owner, artwork_id)).status).toBe(404);
		const removed = await api('DELETE', `/playlists/${playlist_id}/artwork`, { token: owner.access_token });
		expect(removed.status).toBe(200);
		expect(removed.body).toMatchObject({ applied: true, playlist: { artwork_id: null } });
		expect((await fetch_artwork(owner, replaced.body.playlist.artwork_id)).status).toBe(404);
	});

	it('rejects non-images, other users\' playlists and bad requests', async () => {
		const owner = await create_user('artwork-bad');
		const other = await create_user('artwork-bad-other');
		const playlist_id = await new_playlist(owner);
		expect((await upload_artwork(owner, playlist_id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'.repeat(4)))).status).toBe(415);
		expect((await upload_artwork(owner, playlist_id, wav_bytes())).status).toBe(415);
		const corrupt = Buffer.concat([png(4).subarray(0, 40), Buffer.alloc(64, 1)]);
		expect((await upload_artwork(owner, playlist_id, corrupt)).status).toBe(422);
		expect((await upload_artwork(other, playlist_id, png())).status).toBe(404);
		expect((await upload_artwork(owner, uuid(), png())).status).toBe(404);
		expect((await api('DELETE', `/playlists/${playlist_id}/artwork`, { token: other.access_token })).status).toBe(404);
		expect((await api('GET', '/artwork/..%2F..%2Fetc%2Fpasswd', { token: owner.access_token })).status).toBe(400);
		expect((await api('GET', `/artwork/${uuid()}.jpg`, { token: owner.access_token })).status).toBe(404);
		const leftovers = await query(`select count(*)::int as n from playlists_table where id = $1 and artwork_id is not null`, [playlist_id]);
		expect(leftovers[0].n).toBe(0);
	});
});

describe('data export', () => {
	it('runs in the background, can be polled and downloaded, and is rate limited', async () => {
		const user = await create_user('export');
		const created = await contribute(user, mock_album({ artist: unique('Export Artist'), album: unique('Export Album'), n: 2 }));
		const [t0, t1] = [created.body.refs.t0, created.body.refs.t1];
		await add_to_library(user, [t0]);
		const playlist_id = await new_playlist(user);
		await push(user, {
			playlist_tracks: [{ playlist_id, track_id: t1, edited_at: new Date().toISOString() }],
			track_plays: [{ client_id: uuid(), track_id: t0, created_at: new Date().toISOString() }]
		});

		const requested = await api('POST', '/me/export', { token: user.access_token });
		expect(requested.status).toBe(202);
		expect(requested.body).toMatchObject({ status: 'PENDING', size: null, expires_at: null });
		const id: string = requested.body.id;

		const again = await api('POST', '/me/export', { token: user.access_token });
		expect([409, 429]).toContain(again.status);
		expect(again.body.export.id).toBe(id);

		const ready = await eventually(async () => {
			const status = await api('GET', `/me/export/${id}`, { token: user.access_token });
			if (status.body.status !== 'READY') throw new Error(`still ${status.body.status}`);
			return status.body;
		}, 30_000);
		expect(ready.size).toBeGreaterThan(0);
		expect(new Date(ready.expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

		const file = await fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3000'}/api/v1/me/export/${id}/file`, { headers: { authorization: `Bearer ${user.access_token}` } });
		expect(file.status).toBe(200);
		expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="illusi-export-\d{4}-\d{2}-\d{2}\.json\.gz"$/u);
		const doc = JSON.parse(gunzipSync(Buffer.from(await file.arrayBuffer())).toString('utf8'));
		expect(doc).toMatchObject({ format: 'illusi-export', version: 1, user: { id: user.id, email: user.email } });
		expect(doc.user.password_hash).toBeUndefined();
		expect(doc.sessions.length).toBeGreaterThan(0);
		expect(doc.sessions[0].token_hash).toBeUndefined();
		expect(doc.library.map((r: { track_id: string }) => r.track_id)).toEqual([t0]);
		expect(doc.playlists).toHaveLength(1);
		expect(doc.playlists[0].tracks.map((r: { track_id: string }) => r.track_id)).toEqual([t1]);
		expect(doc.plays).toHaveLength(1);
		expect(doc.contributions.length).toBeGreaterThan(0);
		expect(Object.keys(doc.tracks).sort()).toEqual([t0, t1].sort());
		expect(doc.tracks[t0].artists[0].name).toMatch(/^Export Artist/u);

		// Done, but inside the cooldown.
		const cooled = await api('POST', '/me/export', { token: user.access_token });
		expect(cooled.status).toBe(429);
		expect(cooled.body.retry_after_s).toBeGreaterThan(0);
		expect(cooled.headers.get('retry-after')).toBeTruthy();

		const list = await api('GET', '/me/exports', { token: user.access_token });
		expect(list.body.items.map((j: { id: string }) => j.id)).toEqual([id]);

		// Someone else's export doesn't exist for this user.
		const other = await create_user('export-other');
		expect((await api('GET', `/me/export/${id}`, { token: other.access_token })).status).toBe(404);
		expect((await api('GET', `/me/export/${id}/file`, { token: other.access_token })).status).toBe(404);

		// Expired exports are gone.
		await query(`update export_jobs_table set status = 'EXPIRED', file_name = null where id = $1`, [id]);
		expect((await api('GET', `/me/export/${id}/file`, { token: user.access_token })).status).toBe(410);
	});
});

describe('account deletion', () => {
	it('requires the password, removes personal data, keeps contributed catalog data, and kills the access token', async () => {
		const user = await create_user('delete-me');
		const keeper = await create_user('delete-keeper');
		const created = await contribute(user, mock_album({ artist: unique('Deleted Artist'), album: unique('Deleted Album'), n: 1 }));
		const t0 = created.body.refs.t0;
		await add_to_library(user, [t0], { downloaded_at: new Date().toISOString() });
		const playlist_id = await new_playlist(user);
		const artwork = await upload_artwork(user, playlist_id, png());
		expect(artwork.status).toBe(200);
		await push(user, { track_plays: [{ client_id: uuid(), track_id: t0, created_at: new Date().toISOString() }] });
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(wav_bytes(Math.floor(Math.random() * 1000)))], { type: 'audio/wav' }), 'song.wav');
		expect((await api('POST', `/tracks/${t0}/media`, { token: user.access_token, raw: form })).status).toBe(201);
		await add_to_library(keeper, [t0]);
		const exported = await api('POST', '/me/export', { token: user.access_token });
		await eventually(async () => {
			const status = await api('GET', `/me/export/${exported.body.id}`, { token: user.access_token });
			if (status.body.status !== 'READY') throw new Error(`still ${status.body.status}`);
		}, 30_000);
		const plays_before = (await query(`select plays from track_play_counts_table where track_id = $1`, [t0]))[0]?.plays;
		expect(Number(plays_before)).toBe(1);

		expect((await api('DELETE', '/me', { token: user.access_token, body: {} })).status).toBe(400);
		expect((await api('DELETE', '/me', { token: user.access_token, body: { password: 'not-the-password' } })).status).toBe(401);
		expect((await api('GET', '/me', { token: user.access_token })).status).toBe(200);

		expect((await api('DELETE', '/me', { token: user.access_token, body: { password: user.password } })).status).toBe(204);

		// The still-unexpired access token and the refresh token stop working at once.
		expect((await api('GET', '/me', { token: user.access_token })).status).toBe(401);
		expect((await api('POST', '/auth/refresh', { body: { refresh_token: user.refresh_token } })).status).toBe(401);
		expect((await api('POST', '/auth/login', { body: { email: user.email, password: user.password } })).status).toBe(401);

		const personal = await query(`
			select
				(select count(*)::int from users_table where id = $1) as users,
				(select count(*)::int from sessions_table where user_id = $1) as sessions,
				(select count(*)::int from user_tracks_table where user_id = $1) as library,
				(select count(*)::int from playlists_table where user_id = $1) as playlists,
				(select count(*)::int from track_plays_table where user_id = $1) as plays,
				(select count(*)::int from contributions_log_table where user_id = $1) as contributions,
				(select count(*)::int from export_jobs_table where user_id = $1) as exports,
				(select count(*)::int from media_table where uploaded_by = $1) as uploads`, [user.id]);
		expect(personal[0]).toEqual({ users: 0, sessions: 0, library: 0, playlists: 0, plays: 0, contributions: 0, exports: 0, uploads: 0 });
		if (process.env.MEDIA_DIR) expect(existsSync(path.join(process.env.MEDIA_DIR, '.exports', `${exported.body.id}.json.gz`))).toBe(false);

		// The catalog they built stays, and so does what other users have of it.
		const catalog = await query(`
			select
				(select count(*)::int from tracks_table where id = $1) as tracks,
				(select count(*)::int from media_table where track_id = $1 and uploaded_by is null) as media,
				(select count(*)::int from contributions_log_table where user_id is null and entities::text like '%' || $1 || '%') as anonymous_contributions,
				(select count(*)::int from user_tracks_table where track_id = $1 and user_id = $2) as keeper_library,
				(select plays from track_play_counts_table where track_id = $1) as total_plays`, [t0, keeper.id]);
		expect(catalog[0]).toMatchObject({ tracks: 1, media: 1, keeper_library: 1 });
		expect(catalog[0].anonymous_contributions).toBeGreaterThan(0);
		expect(Number(catalog[0].total_plays)).toBe(0);

		// Their artwork file is gone too.
		expect((await fetch_artwork(keeper, artwork.body.playlist.artwork_id)).status).toBe(404);
		expect((await api('GET', '/me', { token: keeper.access_token })).status).toBe(200);
	});
});

function fetch_artwork(user: TestUser, artwork_id: string, headers: Record<string, string> = {}) {
	return fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3000'}/api/v1/artwork/${artwork_id}`, { headers: { authorization: `Bearer ${user.access_token}`, ...headers } });
}

/** Width and height from a JPEG's first SOFn segment. */
function jpeg_size(buf: Buffer): { width: number; height: number } | null {
	let i = 2;
	while (i + 9 < buf.length) {
		if (buf[i] !== 0xFF) return null;
		const marker = buf[i + 1];
		const length = buf.readUInt16BE(i + 2);
		if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		}
		i += 2 + length;
	}
	return null;
}
