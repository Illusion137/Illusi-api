import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, query, unique } from './helpers';
import type { TestUser } from './helpers';

const CHANNEL = () => `UC${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;

async function seed(user: TestUser, graph: ReturnType<typeof mock_album>) {
	const res = await contribute(user, graph);
	expect(res.status).toBe(200);
	const refs = res.body.refs as Record<string, string>;
	return { artist_id: refs.ar, album_id: refs.al, track_ids: graph.tracks.map(t => refs[t.ref]) };
}

describe('artist service links', () => {
	it('fills the links of artists in the caller\'s library and returns them with the artist', async () => {
		const user = await create_user('artist-links');
		const stranger = await create_user('artist-links-other');
		const { artist_id, track_ids } = await seed(user, mock_album({ artist: unique('Linked Artist'), album: unique('Linked Album'), n: 1 }));
		const channel = CHANNEL();
		const permalink = unique('linked-artist').toLowerCase();
		const links = { items: [{ artist_id, service_ids: { youtube_id: channel, soundcloud_permalink: `https://soundcloud.com/${permalink}` } }] };

		const refused = await api('POST', '/artists/service_ids', { token: stranger.access_token, body: links });
		expect(refused.body).toEqual({ filled: 0 });

		await add_to_library(user, track_ids);
		const sent = await api('POST', '/artists/service_ids', { token: user.access_token, body: links });
		expect(sent.status).toBe(200);
		expect(sent.body).toEqual({ filled: 2 });

		const view = await api('GET', `/artists/${artist_id}`, { token: stranger.access_token });
		expect(view.body.service_ids).toMatchObject({ youtube_id: channel, soundcloud_permalink: permalink });

		const again = await api('POST', '/artists/service_ids', { token: user.access_token, body: { items: [{ artist_id, service_ids: { youtube_id: CHANNEL() } }] } });
		expect(again.body).toEqual({ filled: 0 });
		expect((await api('GET', `/artists/${artist_id}`, { token: user.access_token })).body.service_ids.youtube_id).toBe(channel);
	});

	it('fills nothing on a locked artist, and records no conflicts', async () => {
		const user = await create_user('artist-links-locked');
		const { artist_id, track_ids } = await seed(user, mock_album({ artist: unique('Locked Artist'), album: unique('Locked Album'), n: 1 }));
		await add_to_library(user, track_ids);
		await query(`insert into service_links_locks_table (illusi_id) values ($1)`, [artist_id]);

		const sent = await api('POST', '/artists/service_ids', { token: user.access_token, body: { items: [{ artist_id, service_ids: { youtube_id: CHANNEL() } }] } });
		expect(sent.body).toEqual({ filled: 0 });
		expect((await api('GET', `/artists/${artist_id}`, { token: user.access_token })).body.service_ids.youtube_id ?? null).toBeNull();
		expect(await query(`select 1 from service_id_conflicts_table where illusi_id = $1`, [artist_id])).toHaveLength(0);
	});

	it('rejects unknown columns', async () => {
		const user = await create_user('artist-links-bad');
		const res = await api('POST', '/artists/service_ids', { token: user.access_token, body: { items: [{ artist_id: crypto.randomUUID(), service_ids: { isrc: 'US1234567890' } }] } });
		expect(res.status).toBe(400);
	});
});

describe('album artwork', () => {
	it('falls back to a track\'s thumbnails when the album has none', async () => {
		const user = await create_user('album-track-art');
		const graph = mock_album({ artist: unique('Bare Artist'), album: unique('Bare Album'), n: 2 });
		const [album] = graph.albums;
		const bare = {
			...graph,
			albums: [{ ...album, thumbnails: undefined }],
			tracks: graph.tracks.map((track, i) => ({ ...track, thumbnails: [{ url: `https://img.example.test/${album.ref}-${unique('t')}-${i}.jpg`, width: 300, height: 300 }] }))
		};
		const { album_id } = await seed(user, bare);
		const view = await api('GET', `/albums/${album_id}`, { token: user.access_token });
		expect(view.status).toBe(200);
		expect(view.body.album.thumbnails).toHaveLength(1);
		expect(view.body.album.thumbnails[0].url).toBe(bare.tracks[0].thumbnails[0].url);
	});
});
