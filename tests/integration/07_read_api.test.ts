import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, query, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

async function seed_album(user: TestUser, opts: { artist?: string; album?: string; n?: number } = {}) {
	const graph = mock_album({ artist: opts.artist ?? unique('Read Artist'), album: opts.album ?? unique('Read Album'), n: opts.n ?? 3 });
	const res = await contribute(user, graph);
	expect(res.status).toBe(200);
	const refs: Record<string, string> = res.body.refs;
	return { graph, artist_id: refs.ar, album_id: refs.al, track_ids: graph.tracks.map(t => refs[t.ref]) };
}

async function push(user: TestUser, changes: object) {
	const res = await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes } });
	expect(res.status).toBe(200);
	return res.body;
}

const ids = (items: { id: string }[]) => items.map(i => i.id);

describe('read API: the caller', () => {
	it('returns the profile, library with overlay, sorting and query filtering', async () => {
		const user = await create_user('reader');
		const { track_ids, album_id, artist_id } = await seed_album(user, { n: 3 });
		await add_to_library(user, [track_ids[0]], { title: 'Zeta Override', downloaded_at: new Date().toISOString() });
		await add_to_library(user, [track_ids[1], track_ids[2]]);
		await push(user, { track_plays: [{ client_id: uuid(), track_id: track_ids[1], created_at: new Date().toISOString() }] });

		const me = await api('GET', '/me', { token: user.access_token });
		expect(me.status).toBe(200);
		expect(me.body.user.id).toBe(user.id);
		expect(me.body.user.password_hash).toBeUndefined();
		expect(me.body.stats).toEqual({ tracks: 3, playlists: 0, plays: 1 });

		const library = await api('GET', '/me/library?sort=ALPHABETICAL', { token: user.access_token });
		expect(library.status).toBe(200);
		expect(ids(library.body.items)).toEqual([track_ids[1], track_ids[2], track_ids[0]]);
		const overridden = library.body.items[2];
		expect(overridden.user).toMatchObject({ title: 'Zeta Override', plays: 0 });
		expect(overridden.user.downloaded_at).not.toBeNull();
		expect(overridden.album).toMatchObject({ id: album_id });
		expect(overridden.artists[0].id).toBe(artist_id);
		expect(overridden.track_number).toBe(1);
		expect(overridden.service_ids.spotify_id).toBeTruthy();
		expect(library.body.items[0].user.plays).toBe(1);

		const filtered = await api('GET', `/me/library?q=${encodeURIComponent('Zeta')}`, { token: user.access_token });
		expect(ids(filtered.body.items)).toEqual([track_ids[0]]);

		const paged = await api('GET', '/me/library?sort=ALPHABETICAL&limit=2', { token: user.access_token });
		expect(paged.body.items).toHaveLength(2);
		const rest = await api('GET', `/me/library?sort=ALPHABETICAL&limit=2&cursor=${paged.body.next_cursor}`, { token: user.access_token });
		expect(ids(rest.body.items)).toEqual([track_ids[0]]);
		expect(rest.body.next_cursor).toBeNull();

		expect((await api('GET', '/me/library?cursor=garbage', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', '/me/library?sort=NOPE', { token: user.access_token })).status).toBe(400);
	});

	it('lists plays, recent searches and linked playlists', async () => {
		const user = await create_user('history');
		const { track_ids } = await seed_album(user, { n: 1 });
		const play_id = uuid();
		await push(user, {
			track_plays: [{ client_id: play_id, track_id: track_ids[0], created_at: new Date().toISOString() }],
			recent_searches: [
				{ client_id: uuid(), text: 'older', created_at: new Date(Date.now() - 60_000).toISOString() },
				{ client_id: uuid(), text: 'newer', created_at: new Date().toISOString() }
			],
			linked_playlists: [
				{ service_uri: 'spotify:playlist:keep', edited_at: new Date().toISOString() },
				{ service_uri: 'spotify:playlist:gone', deleted: true, edited_at: new Date().toISOString() }
			]
		});

		const plays = await api('GET', '/me/plays', { token: user.access_token });
		expect(plays.body.items).toHaveLength(1);
		expect(plays.body.items[0]).toMatchObject({ client_id: play_id, track: { id: track_ids[0] } });

		const searches = await api('GET', '/me/recent_searches?limit=1', { token: user.access_token });
		expect(searches.body.items.map((s: { text: string }) => s.text)).toEqual(['newer']);

		const linked = await api('GET', '/me/linked_playlists', { token: user.access_token });
		expect(linked.body.items.map((l: { service_uri: string }) => l.service_uri)).toEqual(['spotify:playlist:keep']);
	});
});

describe('read API: playlists', () => {
	it('resolves inheritance, hides private playlists and inheritance rows from others', async () => {
		const owner = await create_user('owner');
		const other = await create_user('viewer');
		const { track_ids } = await seed_album(owner, { n: 3 });
		await add_to_library(owner, track_ids);
		await add_to_library(other, [track_ids[0]], { title: 'Viewer Title' });

		const base = uuid();
		const shared = uuid();
		const secret = uuid();
		const title = unique('Shared Mix');
		const now = new Date().toISOString();
		await push(owner, {
			playlists: [
				{ id: base, title: 'Base', edited_at: now },
				{ id: shared, title, public: true, edited_at: now },
				{ id: secret, title: 'Secret', edited_at: now }
			],
			playlist_tracks: [
				{ playlist_id: base, track_id: track_ids[0], edited_at: now },
				{ playlist_id: base, track_id: track_ids[1], edited_at: now },
				{ playlist_id: shared, track_id: track_ids[2], edited_at: now }
			],
			playlist_inherited_playlists: [{ temp_id: 'inh', playlist_id: shared, ref_id: base, mode: 'INCLUDE', edited_at: now }]
		});

		const mine = await api('GET', '/me/playlists', { token: owner.access_token });
		expect(mine.body.items).toHaveLength(3);
		const own_view = mine.body.items.find((p: { id: string }) => p.id === shared);
		expect(own_view).toMatchObject({ is_owner: true, track_count: 3, owner: { id: owner.id } });
		expect(own_view.inherited_playlists).toHaveLength(1);

		const seen = await api('GET', `/playlists/${shared}`, { token: other.access_token });
		expect(seen.status).toBe(200);
		expect(seen.body).toMatchObject({ is_owner: false, track_count: 3 });
		expect(seen.body.inherited_playlists).toBeUndefined();
		expect(seen.body.inherited_searches).toBeUndefined();

		const tracks = await api('GET', `/playlists/${shared}/tracks`, { token: other.access_token });
		expect(new Set(ids(tracks.body.items))).toEqual(new Set(track_ids));
		const t0 = tracks.body.items.find((t: { id: string }) => t.id === track_ids[0]);
		expect(t0.user.title).toBe('Viewer Title');
		expect(tracks.body.items.find((t: { id: string }) => t.id === track_ids[1]).user).toBeNull();

		expect((await api('GET', `/playlists/${secret}`, { token: other.access_token })).status).toBe(404);
		expect((await api('GET', `/playlists/${secret}/tracks`, { token: other.access_token })).status).toBe(404);
		expect((await api('GET', `/playlists/${secret}`, { token: owner.access_token })).status).toBe(200);
		expect((await api('GET', `/playlists/not-a-uuid`, { token: owner.access_token })).status).toBe(400);

		const theirs = await api('GET', `/users/${owner.id}/playlists`, { token: other.access_token });
		expect(ids(theirs.body.items)).toEqual([shared]);
		const own_list = await api('GET', `/users/${owner.id}/playlists`, { token: owner.access_token });
		expect(own_list.body.items).toHaveLength(3);

		const discovered = await api('GET', `/playlists/public?q=${encodeURIComponent(title)}`, { token: other.access_token });
		expect(ids(discovered.body.items)).toEqual([shared]);
	});
});

describe('read API: catalog', () => {
	it('reads tracks, follows merges, batches with missing ids', async () => {
		const user = await create_user('catalog');
		const { track_ids } = await seed_album(user, { n: 2 });

		const track = await api('GET', `/tracks/${track_ids[0]}`, { token: user.access_token });
		expect(track.status).toBe(200);
		expect(track.body).toMatchObject({ id: track_ids[0], has_media: false, has_lyrics: false, user: null });
		expect(track.body.redirected_from).toBeUndefined();

		const old_id = uuid();
		await query(`insert into illusi_id_redirects_table (old_id, new_id) values ($1, $2)`, [old_id, track_ids[1]]);
		const followed = await api('GET', `/tracks/${old_id}`, { token: user.access_token });
		expect(followed.body).toMatchObject({ id: track_ids[1], redirected_from: old_id });

		const missing = uuid();
		const batch = await api('POST', '/tracks/batch', { token: user.access_token, body: { ids: [track_ids[1], missing, old_id, track_ids[0]] } });
		expect(batch.status).toBe(200);
		expect(ids(batch.body.items)).toEqual([track_ids[1], track_ids[1], track_ids[0]]);
		expect(batch.body.items[1].redirected_from).toBe(old_id);
		expect(batch.body.missing).toEqual([missing]);

		expect((await api('GET', `/tracks/${uuid()}`, { token: user.access_token })).status).toBe(404);
		expect((await api('POST', '/tracks/batch', { token: user.access_token, body: { ids: ['x'] } })).status).toBe(400);
		const similar = await api('GET', `/tracks/${track_ids[0]}/similar`, { token: user.access_token });
		expect(similar.body).toEqual({ items: [] });
	});

	it('reads albums and artists with their albums, tracks and similar artists', async () => {
		const user = await create_user('artist');
		const first = await seed_album(user, { n: 3 });
		const second = await seed_album(user, { n: 1 });
		await add_to_library(user, [first.track_ids[0]]);
		await push(user, { track_plays: [1, 2].map(() => ({ client_id: uuid(), track_id: first.track_ids[2], created_at: new Date().toISOString() })) });
		const linked = await contribute(user, { relations: { similar_artists: [{ artist_ref: second.artist_id, similar_artist_ref: first.artist_id }] } });
		expect(linked.body.rejected).toEqual([]);

		const album = await api('GET', `/albums/${first.album_id}`, { token: user.access_token });
		expect(album.status).toBe(200);
		expect(album.body.album).toMatchObject({ id: first.album_id, artist: { id: first.artist_id }, track_count: 3 });
		expect(album.body.album.thumbnails[0].width).toBe(600);
		expect(ids(album.body.tracks)).toEqual(first.track_ids);

		const artist = await api('GET', `/artists/${first.artist_id}`, { token: user.access_token });
		expect(artist.body).toMatchObject({ id: first.artist_id, album_count: 1, track_count: 3, in_library: true });
		const not_mine = await api('GET', `/artists/${second.artist_id}`, { token: user.access_token });
		expect(not_mine.body.in_library).toBe(false);

		const albums = await api('GET', `/artists/${first.artist_id}/albums`, { token: user.access_token });
		expect(ids(albums.body.items)).toEqual([first.album_id]);
		expect((await api('GET', `/artists/${first.artist_id}/albums?album_type=SINGLE`, { token: user.access_token })).body.items).toEqual([]);

		const popular = await api('GET', `/artists/${first.artist_id}/tracks`, { token: user.access_token });
		expect(popular.body.items[0].id).toBe(first.track_ids[2]);
		const by_title = await api('GET', `/artists/${first.artist_id}/tracks?sort=title&limit=2`, { token: user.access_token });
		expect(ids(by_title.body.items)).toEqual(first.track_ids.slice(0, 2));
		expect(by_title.body.next_cursor).not.toBeNull();

		const similar = await api('GET', `/artists/${first.artist_id}/similar`, { token: user.access_token });
		expect(ids(similar.body.items)).toEqual([second.artist_id]);
	});
});

describe('read API: search', () => {
	it('finds tracks by title, artist + title, accents, links and ISRCs', async () => {
		const user = await create_user('search');
		const tag = unique('qz').replace('-', '');
		const artist = `Béyoncé ${tag}`;
		const { graph, track_ids, album_id, artist_id } = await seed_album(user, { artist, album: `Halo ${tag}`, n: 2 });

		const by_title = await api('GET', `/search?q=${encodeURIComponent(`Halo ${tag} Track 2`)}&types=track`, { token: user.access_token });
		expect(by_title.status).toBe(200);
		expect(by_title.body.tracks.items[0].id).toBe(track_ids[1]);
		expect(by_title.body.albums).toBeUndefined();

		const by_artist = await api('GET', `/search?q=${encodeURIComponent(`beyonce ${tag} halo ${tag} track 1`)}&types=track`, { token: user.access_token });
		expect(by_artist.body.tracks.items[0].id).toBe(track_ids[0]);

		const everything = await api('GET', `/search?q=${encodeURIComponent(`beyonce ${tag}`)}`, { token: user.access_token });
		expect(ids(everything.body.artists.items)).toContain(artist_id);
		expect(ids(everything.body.albums.items)).toContain(album_id);
		expect(everything.body.playlists.items).toEqual([]);

		const spotify = graph.tracks[1].service_ids.spotify_id;
		const by_link = await api('GET', `/search?q=${encodeURIComponent(`https://open.spotify.com/track/${spotify}`)}&types=track`, { token: user.access_token });
		expect(by_link.body.tracks.items[0].id).toBe(track_ids[1]);
		const by_isrc = await api('GET', `/search?q=${graph.tracks[0].service_ids.isrc}&types=track`, { token: user.access_token });
		expect(by_isrc.body.tracks.items[0].id).toBe(track_ids[0]);
	});

	it('finds albums by their primary and credited artists, in both scopes', async () => {
		const user = await create_user('album-artist');
		const tag = unique('cr').replace('-', '');
		const sp = (s: string) => `sp${tag}${s}`.padEnd(22, '0').slice(0, 22);
		const graph = {
			artists: [
				{ ref: 'credit', name: `Credit ${tag}`, service_ids: { spotify_id: sp('ac') } },
				{ ref: 'lead', name: `Lead ${tag}`, service_ids: { spotify_id: sp('al') } }
			],
			albums: [
				{ ref: 'own', name: 'Velvet Orchard', artist_ref: 'credit', album_type: 'ALBUM', track_count: 1, service_ids: { spotify_id: sp('bo') } },
				{ ref: 'featured', name: 'Granite Lullaby', artist_ref: 'lead', album_type: 'ALBUM', track_count: 1, service_ids: { spotify_id: sp('bf') } },
				{ ref: 'other', name: 'Paper Comet', artist_ref: 'lead', album_type: 'ALBUM', track_count: 1, service_ids: { spotify_id: sp('bx') } }
			],
			tracks: ['own', 'featured', 'other'].map(album => ({ ref: `t_${album}`, title: `Song ${album}`, album_ref: album, duration_ms: 200_000, service_ids: { spotify_id: sp(`t${album.slice(0, 2)}`) } })),
			relations: {
				tracks_artists: [
					{ track_ref: 't_own', artist_ref: 'credit' },
					{ track_ref: 't_featured', artist_ref: 'lead' },
					{ track_ref: 't_other', artist_ref: 'lead' }
				],
				album_tracks: ['own', 'featured', 'other'].map(album => ({ album_ref: album, track_ref: `t_${album}`, track_number: 1 })),
				artist_albums: [
					{ artist_ref: 'credit', album_ref: 'own', position: 0 },
					{ artist_ref: 'lead', album_ref: 'featured', position: 0 },
					{ artist_ref: 'credit', album_ref: 'featured', position: 1 },
					{ artist_ref: 'lead', album_ref: 'other', position: 0 }
				]
			}
		};
		const created = await contribute(user, graph);
		expect(created.status).toBe(200);
		const { own, featured, other, t_featured } = created.body.refs;

		// The query names the credited artist (plus noise words): its own album and the one it's credited on, not the lead's other album.
		const global = await api('GET', `/search?q=${encodeURIComponent(`new credit ${tag} music`)}&types=album`, { token: user.access_token });
		expect(global.status).toBe(200);
		expect(ids(global.body.albums.items)).toEqual(expect.arrayContaining([own, featured]));
		expect(ids(global.body.albums.items)).not.toContain(other);

		const lead = await api('GET', `/search?q=${encodeURIComponent(`lead ${tag}`)}&types=album`, { token: user.access_token });
		expect(ids(lead.body.albums.items)).toEqual(expect.arrayContaining([featured, other]));
		expect(ids(lead.body.albums.items)).not.toContain(own);

		await add_to_library(user, [t_featured]);
		const library = await api('GET', `/search?q=${encodeURIComponent(`credit ${tag}`)}&types=album&scope=library`, { token: user.access_token });
		expect(ids(library.body.albums.items)).toEqual([featured]);
	});

	it('limits library scope, pages one type, and validates the query', async () => {
		const user = await create_user('scope');
		const tag = unique('lib').replace('-', '');
		const { track_ids } = await seed_album(user, { album: `Scoped ${tag}`, n: 3 });
		await add_to_library(user, [track_ids[2]]);
		const now = new Date().toISOString();
		const playlist = uuid();
		await push(user, { playlists: [{ id: playlist, title: `Scoped ${tag} Mix`, edited_at: now }] });

		const library = await api('GET', `/search?q=${encodeURIComponent(`Scoped ${tag}`)}&scope=library`, { token: user.access_token });
		expect(ids(library.body.tracks.items)).toEqual([track_ids[2]]);
		expect(ids(library.body.playlists.items)).toEqual([playlist]);

		const first = await api('GET', `/search?q=${encodeURIComponent(`Scoped ${tag}`)}&types=track&limit=2`, { token: user.access_token });
		expect(first.body.tracks.items).toHaveLength(2);
		const next = await api('GET', `/search?q=${encodeURIComponent(`Scoped ${tag}`)}&types=track&limit=2&cursor=${first.body.tracks.next_cursor}`, { token: user.access_token });
		expect(next.body.tracks.items).toHaveLength(1);
		expect(new Set([...ids(first.body.tracks.items), ...ids(next.body.tracks.items)])).toEqual(new Set(track_ids));

		const stranger = await create_user('stranger');
		const hidden = await api('GET', `/search?q=${encodeURIComponent(`Scoped ${tag} Mix`)}&types=playlist`, { token: stranger.access_token });
		expect(hidden.body.playlists.items).toEqual([]);

		expect((await api('GET', '/search', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', '/search?q=x&types=song', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', `/search?q=x&cursor=${first.body.tracks.next_cursor}`, { token: user.access_token })).status).toBe(400);
	});
});
