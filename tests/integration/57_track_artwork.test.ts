import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, unique } from './helpers';
import type { TestUser } from './helpers';
import { png } from './images';

const base = `${process.env.API_URL ?? 'http://127.0.0.1:3000'}/api/v1`;

async function seed(user: TestUser, imported: boolean) {
	const graph = mock_album({ artist: unique('Artwork Artist'), album: unique('Artwork Album'), n: 1, imported });
	const res = await contribute(user, graph);
	expect(res.status).toBe(200);
	return (res.body.refs as Record<string, string>)[graph.tracks[0].ref];
}

function upload(user: TestUser, track_id: string, edited_at?: string) {
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(png(16))], { type: 'image/png' }), 'cover.png');
	if (edited_at) form.append('edited_at', edited_at);
	return api('PUT', `/tracks/${track_id}/artwork`, { token: user.access_token, raw: form });
}

describe('imported track artwork', () => {
	it('stores, serves publicly, and last-write-wins across the users who have the track', async () => {
		const owner = await create_user('track-art');
		const other = await create_user('track-art-other');
		const track_id = await seed(owner, true);
		await add_to_library(owner, [track_id]);

		expect((await upload(other, track_id)).status).toBe(404);

		const set = await upload(owner, track_id);
		expect(set.status).toBe(200);
		expect(set.body.applied).toBe(true);
		const artwork_id: string = set.body.track.artwork_id;
		expect(artwork_id).toMatch(/\.jpg$/);

		const view = await api('GET', `/tracks/${track_id}`, { token: other.access_token });
		expect(view.body.artwork_id).toBe(artwork_id);

		const served = await fetch(`${base}/track_artwork/${artwork_id}`);
		expect(served.status).toBe(200);
		expect(served.headers.get('content-type')).toBe('image/jpeg');

		const stale = await upload(owner, track_id, new Date(Date.now() - 60 * 60_000).toISOString());
		expect(stale.body).toMatchObject({ applied: false, track: { artwork_id } });

		await add_to_library(other, [track_id]);
		const removed = await api('DELETE', `/tracks/${track_id}/artwork`, { token: other.access_token });
		expect(removed.body).toMatchObject({ applied: true, track: { artwork_id: null } });
		expect((await fetch(`${base}/track_artwork/${artwork_id}`)).status).toBe(404);
	});

	it('refuses catalog tracks, and never serves playlist artwork publicly', async () => {
		const user = await create_user('track-art-catalog');
		const track_id = await seed(user, false);
		await add_to_library(user, [track_id]);
		const refused = await upload(user, track_id);
		expect(refused.status).toBe(409);
		expect(refused.body.code).toBe('NOT_IMPORTED');

		const playlist_id = crypto.randomUUID();
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: crypto.randomUUID(), changes: { playlists: [{ id: playlist_id, title: 'Private', edited_at: new Date().toISOString() }] } } });
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(png(16))], { type: 'image/png' }), 'cover.png');
		const playlist_art = await api('PUT', `/playlists/${playlist_id}/artwork`, { token: user.access_token, raw: form });
		expect(playlist_art.status).toBe(200);
		expect((await fetch(`${base}/track_artwork/${playlist_art.body.playlist.artwork_id}`)).status).toBe(404);
		expect((await fetch(`${base}/track_artwork/not-an-id`)).status).toBe(400);
	});
});
