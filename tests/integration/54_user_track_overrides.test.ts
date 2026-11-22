import { describe, expect, it } from 'vitest';
import { api, contribute, create_user, mock_album, query, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

const push = (user: TestUser, changes: object) =>
	api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes } });

async function catalog_album(user: TestUser) {
	const artist = unique('Known Artist');
	const album = unique('Known Album');
	const res = await contribute(user, mock_album({ artist, album, n: 1 }));
	expect(res.status).toBe(200);
	return { artist, album, artist_id: res.body.refs.ar as string, album_id: res.body.refs.al as string, track_id: res.body.refs.t0 as string };
}

describe('user track overrides', () => {
	it('links credited names to catalog entities and creates the ones it lacks, leaving the catalog credits alone', async () => {
		const user = await create_user('overrides');
		const known = await catalog_album(user);
		const own = await catalog_album(user);
		const new_artist = unique('Brand New Artist');
		const new_album = unique('Brand New Album');
		const now = new Date().toISOString();

		const res = await push(user, { user_tracks: [{ track_id: own.track_id, artists: [{ name: known.artist.toUpperCase() }, { name: new_artist }], album: { name: new_album }, edited_at: now }] });
		expect(res.status).toBe(200);
		expect(res.body.rejected).toEqual([]);

		const [row] = await query(`select artist_ids, album_id from user_tracks_table where user_id = $1 and track_id = $2`, [user.id, own.track_id]);
		expect(row.artist_ids[0]).toBe(known.artist_id);
		const [created] = await query(`select id, name from artists_table where id = $1`, [row.artist_ids[1]]);
		expect(created.name).toBe(new_artist);
		const [album] = await query(`select name, artist_id from albums_table where id = $1`, [row.album_id]);
		expect(album).toEqual({ name: new_album, artist_id: known.artist_id });

		expect(res.body.rows.artists.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining(row.artist_ids));
		expect(res.body.rows.albums.map((a: { id: string }) => a.id)).toContain(row.album_id);
		const credits = await query(`select artist_id from tracks_artists_table where track_id = $1`, [own.track_id]);
		expect(credits).toEqual([{ artist_id: own.artist_id }]);
	});

	it('links an album name to that artist\'s album, and null goes back to the catalog credits', async () => {
		const user = await create_user('overrides-album');
		const known = await catalog_album(user);
		const own = await catalog_album(user);
		const at = (s: number) => new Date(Date.now() - 60_000 + s * 1_000).toISOString();

		await push(user, { user_tracks: [{ track_id: own.track_id, artists: [{ id: known.artist_id, name: known.artist }], album: { name: known.album }, edited_at: at(1) }] });
		const [linked] = await query(`select artist_ids, album_id from user_tracks_table where user_id = $1 and track_id = $2`, [user.id, own.track_id]);
		expect(linked).toEqual({ artist_ids: [known.artist_id], album_id: known.album_id });

		await push(user, { user_tracks: [{ track_id: own.track_id, artists: null, album: null, edited_at: at(2) }] });
		const [cleared] = await query(`select artist_ids, album_id from user_tracks_table where user_id = $1 and track_id = $2`, [user.id, own.track_id]);
		expect(cleared).toEqual({ artist_ids: null, album_id: null });
	});
});

describe('user lyrics', () => {
	it('keeps one USER version per user and track, updated by each edit', async () => {
		const user = await create_user('user-lyrics');
		const { track_id } = await catalog_album(user);
		const put = (raw_content: string, format = 'LRC', sync_type = 'LINE') =>
			api('PUT', `/tracks/${track_id}/lyrics/user`, { token: user.access_token, body: { format, sync_type, raw_content } });

		const first = await put('[00:01.00] first line\n[00:03.00] second line');
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ service: 'USER', sync_type: 'LINE' });
		const second = await put('[00:01.00] first line fixed\n[00:03.00] second line');
		expect(second.status).toBe(200);
		expect(JSON.stringify(second.body.lyrics)).toContain('first line fixed');

		const rows = await query(`select raw_content from track_lyrics_table where track_id = $1 and service = 'USER' and source_user_id = $2`, [track_id, user.id]);
		expect(rows).toHaveLength(1);
		expect(rows[0].raw_content).toContain('fixed');
	});

	it('refuses lyrics that don\'t parse and unknown tracks', async () => {
		const user = await create_user('user-lyrics-bad');
		const { track_id } = await catalog_album(user);
		expect((await api('PUT', `/tracks/${track_id}/lyrics/user`, { token: user.access_token, body: { format: 'TTML', sync_type: 'LINE', raw_content: 'not ttml' } })).status).toBe(400);
		expect((await api('PUT', `/tracks/${uuid()}/lyrics/user`, { token: user.access_token, body: { format: 'PLAIN', sync_type: 'NONE', raw_content: 'la' } })).status).toBe(404);
	});
});
