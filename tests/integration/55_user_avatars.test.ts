import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { api, create_user, eventually, unique, uuid } from './helpers';
import type { TestUser } from './helpers';
import { png } from './images';

function upload_avatar(user: TestUser, file: Buffer, type = 'image/png') {
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(file)], { type }), 'me.png');
	return api('PUT', '/me/avatar', { token: user.access_token, raw: form });
}

function fetch_avatar(user: TestUser, avatar_id: string, headers: Record<string, string> = {}) {
	return fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3000'}/api/v1/avatars/${avatar_id}`, { headers: { authorization: `Bearer ${user.access_token}`, ...headers } });
}

const stored = (avatar_id: string) => (process.env.MEDIA_DIR ? existsSync(path.join(process.env.MEDIA_DIR, 'avatars', avatar_id)) : true);

/** Width and height of a lossy (VP8) WebP. */
function webp_size(buf: Buffer): { width: number; height: number } | null {
	if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
	const vp8 = buf.indexOf('VP8 ', 12, 'latin1');
	return vp8 < 0 ? null : { width: buf.readUInt16LE(vp8 + 14) & 0x3FFF, height: buf.readUInt16LE(vp8 + 16) & 0x3FFF };
}

describe('user avatars', () => {
	it('sets, serves, replaces and clears the caller\'s avatar', async () => {
		const user = await create_user('avatar');
		const other = await create_user('avatar-other');
		expect((await api('GET', '/auth/me', { token: user.access_token })).body.avatar_id).toBeNull();

		const set = await upload_avatar(user, png(1500));
		expect(set.status).toBe(200);
		const avatar_id: string = set.body.avatar_id;
		expect(avatar_id).toMatch(/^[0-9a-f-]{36}\.webp$/u);
		expect(stored(avatar_id)).toBe(true);
		expect((await api('GET', '/auth/me', { token: user.access_token })).body.avatar_id).toBe(avatar_id);
		expect((await api('GET', '/me', { token: user.access_token })).body.user.avatar_id).toBe(avatar_id);

		// Others see it where they see the user: next to a playlist of theirs. It's re-encoded as a webp of at most
		// AVATAR_MAX_PX a side and cached by id.
		expect((await fetch_avatar(other, avatar_id)).status).toBe(404);
		const playlist_id = uuid();
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { playlists: [{ id: playlist_id, title: unique('Avatar Mix'), public: true, edited_at: new Date().toISOString() }] } } });
		expect((await api('GET', `/playlists/${playlist_id}`, { token: other.access_token })).body.owner).toEqual(expect.objectContaining({ id: user.id, avatar_id }));
		const file = await fetch_avatar(other, avatar_id);
		expect(file.status).toBe(200);
		expect(file.headers.get('content-type')).toBe('image/webp');
		expect(webp_size(Buffer.from(await file.arrayBuffer()))).toEqual({ width: 512, height: 512 });
		expect((await fetch_avatar(other, avatar_id, { 'if-none-match': `"${avatar_id}"` })).status).toBe(304);

		// It reaches the user's other devices with the profile row (once past the pull's watermark margin).
		await eventually(async () => expect((await api('POST', '/sync/pull', { token: user.access_token, body: {} })).body.user?.avatar_id).toBe(avatar_id));

		const replaced = await upload_avatar(user, png(64, [1, 2, 3]));
		const next: string = replaced.body.avatar_id;
		expect(next).not.toBe(avatar_id);
		expect(stored(avatar_id)).toBe(false);
		expect((await fetch_avatar(other, avatar_id)).status).toBe(404);

		const cleared = await api('DELETE', '/me/avatar', { token: user.access_token });
		expect(cleared.body).toEqual({ avatar_id: null });
		expect(stored(next)).toBe(false);
		expect((await fetch_avatar(user, next)).status).toBe(404);
	});

	it('rejects files that are not images and malformed ids', async () => {
		const user = await create_user('avatar-bad');
		expect((await upload_avatar(user, Buffer.from('not an image at all'), 'image/png')).status).toBe(415);
		expect((await api('PUT', '/me/avatar', { token: user.access_token, body: {} })).status).toBe(400);
		expect((await fetch_avatar(user, `${uuid()}.jpg`)).status).toBe(400);
		expect((await fetch_avatar(user, `${uuid()}.webp`)).status).toBe(404);
		expect((await api('GET', '/auth/me', { token: user.access_token })).body.avatar_id).toBeNull();
	});

	it('removes the avatar file with the account', async () => {
		const user = await create_user('avatar-delete');
		const avatar_id: string = (await upload_avatar(user, png(16))).body.avatar_id;
		expect((await api('DELETE', '/me', { token: user.access_token, body: { password: user.password } })).status).toBe(204);
		expect(stored(avatar_id)).toBe(false);
	});
});
