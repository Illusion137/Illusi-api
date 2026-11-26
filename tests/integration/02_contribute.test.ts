import { describe, expect, it } from 'vitest';
import { api, contribute, create_user, mock_album, query, unique, uuid } from './helpers';

describe('global contributions (§9)', () => {
	it('creates a mock album graph with service ids, thumbnails and relations', async () => {
		const user = await create_user('contrib');
		const graph = mock_album({ artist: unique('Mock Artist One'), album: unique('First Light'), n: 3 });
		const res = await contribute(user, graph);
		expect(res.status).toBe(200);
		expect(res.body.created.map((c: { type: string }) => c.type).sort()).toEqual(['album', 'artist', 'track', 'track', 'track']);
		expect(res.body.rejected).toEqual([]);

		const { ar, al, t0, t1, t2 } = res.body.refs;
		const tracks = await query(`select t.id, t.title, at.track_number from tracks_table t join album_tracks_table at on at.track_id = t.id where at.album_id = $1 order by at.track_number`, [al]);
		expect(tracks.map(t => t.id)).toEqual([t0, t1, t2]);
		const artists = await query(`select artist_id from tracks_artists_table where track_id = $1`, [t1]);
		expect(artists).toEqual([{ artist_id: ar }]);
		const ids = await query(`select spotify_id, isrc from service_ids_table where illusi_id = $1`, [t0]);
		expect(ids[0].spotify_id).toBe(graph.tracks[0].service_ids.spotify_id);
		expect(ids[0].isrc).toBe(graph.tracks[0].service_ids.isrc);
		expect(await query(`select url, width from thumbnails_table where id = $1`, [al])).toEqual([{ url: graph.albums[0].thumbnails[0].url, width: 600 }]);
		// Provenance.
		const log = await query(`select source, user_id, jsonb_array_length(entities) as n from contributions_log_table where user_id = $1`, [user.id]);
		expect(log).toEqual([expect.objectContaining({ source: 'contribute', user_id: user.id })]);
	});

	it('is idempotent per contribution_id, and refuses another user reusing it', async () => {
		const user = await create_user('idem');
		const graph = mock_album({ artist: unique('Idem Artist'), album: unique('Twice'), n: 1 });
		const id = uuid();
		const first = await contribute(user, graph, id);
		const again = await contribute(user, graph, id);
		expect(again.status).toBe(200);
		expect(again.body).toEqual(first.body);
		expect(await query(`select count(*)::int as n from albums_table where name = $1`, [graph.albums[0].name])).toEqual([{ n: 1 }]);

		const other = await create_user('thief');
		expect((await contribute(other, graph, id)).status).toBe(409);
	});

	it('matches existing entities by service id instead of duplicating them', async () => {
		const a = await create_user('first');
		const b = await create_user('second');
		const graph = mock_album({ artist: unique('Shared Artist'), album: unique('Shared Album'), n: 2 });
		const created = await contribute(a, graph);
		// Same ids, differently spelled names: still the same entities.
		const renamed = structuredClone(graph);
		renamed.tracks[0].title = `${graph.albums[0].name.toLowerCase()} track 1 (remastered)`;
		const matched = await contribute(b, renamed);
		expect(matched.body.created).toEqual([]);
		expect(matched.body.refs).toEqual(created.body.refs);
		expect(matched.body.matched.every((m: { by: string }) => m.by === 'service_id' || m.by === 'metadata')).toBe(true);
	});

	it('matches by metadata (normalized names, ±3 s duration) when no ids are given', async () => {
		const user = await create_user('meta');
		const tag = unique('x');
		const graph = mock_album({ artist: `Beyoncé ${tag}`, album: `Métadata, Album ${tag}`, n: 1 });
		const created = await contribute(user, graph);
		const by_name = await contribute(user, {
			artists: [{ ref: 'a', name: `BEYONCE ${tag}` }],
			albums: [{ ref: 'b', name: `Metadata Album ${tag}`, artist_ref: 'a' }],
			tracks: [{ ref: 'c', title: `${graph.albums[0].name} Track 1`, album_ref: 'b', duration_ms: 181_500 }],
			relations: { tracks_artists: [{ track_ref: 'c', artist_ref: 'a' }], album_tracks: [{ album_ref: 'b', track_ref: 'c' }] }
		});
		expect(by_name.status).toBe(200);
		expect(by_name.body.refs.a).toBe(created.body.refs.ar);
		expect(by_name.body.refs.c).toBe(created.body.refs.t0);
		expect(by_name.body.refs.b).toBe(created.body.refs.al);
	});

	it('settles video titles and album disagreements by rule instead of review', async () => {
		const [a, b] = await Promise.all([create_user('rule-a'), create_user('rule-b')]);
		const artist = unique('Rule Artist');
		const reviews = (id: string) => query(`select field from review_items_table where entity_id = $1`, [id]);

		// A stored video title gives way to the clean one.
		const graph = mock_album({ artist, album: unique('Rule Album'), n: 1 });
		const track_id = (await contribute(a, graph)).body.refs.t0;
		await query(`update tracks_table set title = $2 where id = $1`, [track_id, `${artist} - ${graph.tracks[0].title}`]);
		await contribute(b, graph);
		expect(await query(`select title from tracks_table where id = $1`, [track_id])).toEqual([{ title: graph.tracks[0].title }]);

		// And a video title coming in is matched and stored by the song's title alone.
		const video = structuredClone(graph);
		video.tracks[0].title = `${artist} - ${graph.tracks[0].title}`;
		await contribute(b, video);
		expect(await query(`select title from tracks_table where id = $1`, [track_id])).toEqual([{ title: graph.tracks[0].title }]);
		const fresh = mock_album({ artist: unique('Video Artist'), album: unique('Video Album'), n: 1 });
		fresh.tracks[0].title = `${fresh.artists[0].name} - Clean Name`;
		const fresh_id = (await contribute(a, fresh)).body.refs.t0;
		expect(await query(`select title from tracks_table where id = $1`, [fresh_id])).toEqual([{ title: 'Clean Name' }]);

		// The single and the album: linked to both, the album becomes the primary one.
		const single = mock_album({ artist, album: unique('Rule Single'), album_type: 'SINGLE', n: 1 });
		const created = await contribute(a, single);
		const [song, single_id] = [created.body.refs.t0, created.body.refs.al];
		const on_album = structuredClone(single);
		on_album.albums[0] = { ...on_album.albums[0], name: unique('Rule LP'), album_type: 'ALBUM', service_ids: { spotify_id: `lp${unique('x')}`.padEnd(22, '0').slice(0, 22) } };
		const album_id = (await contribute(b, on_album)).body.refs.al;
		expect(album_id).not.toBe(single_id);
		expect(await query(`select album_id from tracks_table where id = $1`, [song])).toEqual([{ album_id }]);
		expect((await query<{ album_id: string }>(`select album_id from album_tracks_table where track_id = $1`, [song])).map(r => r.album_id).sort()).toEqual([album_id, single_id].sort());

		expect([...await reviews(track_id), ...await reviews(song)]).toEqual([]);
	});

	it('stores albums without Apple Music\'s " - Single" suffix, taking the type from it', async () => {
		const user = await create_user('suffix');
		const name = unique('Suffix Song');
		const graph = mock_album({ artist: unique('Suffix Artist'), album: `${name} - Single`, n: 1 });
		delete (graph.albums[0] as { album_type?: string }).album_type;
		const album_id = (await contribute(user, graph)).body.refs.al;
		expect(await query(`select name, album_type from albums_table where id = $1`, [album_id])).toEqual([{ name, album_type: 'SINGLE' }]);
		const again = structuredClone(graph);
		again.albums[0].name = name;
		expect((await contribute(user, again)).body.refs.al).toBe(album_id);
	});

	it('takes a single or EP claim over a stored ALBUM, unless it has too many tracks', async () => {
		const a = await create_user('type-a');
		const b = await create_user('type-b');
		const short = mock_album({ artist: unique('Type Artist'), album: unique('Type Single'), album_type: 'ALBUM', n: 2 });
		const long = mock_album({ artist: unique('Type Artist'), album: unique('Type LP'), album_type: 'ALBUM', n: 2 });
		const short_id = (await contribute(a, short)).body.refs.al;
		const long_id = (await contribute(a, long)).body.refs.al;
		await query(`update albums_table set track_count = 12 where id = $1`, [long_id]);
		await contribute(b, { albums: [{ ref: short_id, name: short.albums[0].name, album_type: 'SINGLE' }] });
		await contribute(b, { albums: [{ ref: long_id, name: long.albums[0].name, album_type: 'EP' }] });
		const types = await query(`select id, album_type from albums_table where id = any($1)`, [[short_id, long_id]]);
		expect(Object.fromEntries(types.map(r => [r.id, r.album_type]))).toEqual({ [short_id]: 'SINGLE', [long_id]: 'ALBUM' });
		expect(await query(`select field from review_items_table where entity_id = $1`, [long_id])).toEqual([{ field: 'album_type' }]);
		expect(await query(`select 1 from review_items_table where entity_id = $1`, [short_id])).toEqual([]);
	});

	it('first write wins on shared fields and conflicting values go to admin review (§9.3, §11.2)', async () => {
		const a = await create_user('writer-a');
		const b = await create_user('writer-b');
		const c = await create_user('writer-c');
		const graph = mock_album({ artist: unique('Conflict Artist'), album: unique('Conflict Album'), n: 1 });
		delete (graph.tracks[0] as { duration_ms?: number }).duration_ms;
		const created = await contribute(a, graph);
		const track_id = created.body.refs.t0;

		// Empty field: filled by the first writer.
		await contribute(b, { tracks: [{ ref: track_id, title: graph.tracks[0].title, explicit: true }] });
		// Clean from a service that marks clean versions, from two users: not applied, one deduped review item with both reporters.
		await contribute(b, { tracks: [{ ref: track_id, title: graph.tracks[0].title, explicit: false, source: 'Deezer' }] });
		await contribute(c, { tracks: [{ ref: track_id, title: graph.tracks[0].title, explicit: false, source: 'Deezer' }] });

		expect(await query(`select explicit from tracks_table where id = $1`, [track_id])).toEqual([{ explicit: true }]);
		const items = await query(`select kind, field, status, occurrences, source_user_ids from review_items_table where entity_id = $1 and field = 'explicit'`, [track_id]);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: 'FIELD_CONFLICT', status: 'OPEN', occurrences: 2 });
		expect([...items[0].source_user_ids].sort()).toEqual([b.id, c.id].sort());
	});

	it('weighs a track\'s explicit by the service it came from', async () => {
		const [a, b] = await Promise.all([create_user('explicit-a'), create_user('explicit-b')]);
		const graph = mock_album({ artist: unique('Explicit Artist'), album: unique('Explicit Album'), n: 1 });
		const track_id = (await contribute(a, graph)).body.refs.t0;
		const send = (explicit: boolean, source?: string) => contribute(b, { tracks: [{ ref: track_id, title: graph.tracks[0].title, explicit, ...(source ? { source } : {}) }] });
		const explicit = async () => (await query<{ explicit: boolean | null }>(`select explicit from tracks_table where id = $1`, [track_id]))[0].explicit;

		await send(true, 'YouTube');
		expect(await explicit()).toBeNull();
		await send(false, 'Spotify');
		expect(await explicit()).toBe(false);
		await send(true, 'SoundCloud');
		expect(await explicit()).toBe(true);
		await send(false);
		await send(false, 'Spotify');
		await send(false, 'YouTube');
		expect(await explicit()).toBe(true);
		await send(false, 'YouTube Music');
		expect(await explicit()).toBe(false);
		expect(await query(`select 1 from review_items_table where entity_id = $1`, [track_id])).toHaveLength(0);
		expect((await contribute(b, { tracks: [{ ref: track_id, title: graph.tracks[0].title, source: 'Napster' }] })).body.rejected).toEqual([]);
	});

	it('records a service id conflict when one id is already taken by another entity (§4.4)', async () => {
		const user = await create_user('sid');
		const one = await contribute(user, mock_album({ artist: unique('Sid One'), album: unique('Sid Album One'), n: 1 }));
		const two = await contribute(user, mock_album({ artist: unique('Sid Two'), album: unique('Sid Album Two'), n: 1 }));
		const taken = (await query(`select spotify_id from service_ids_table where illusi_id = $1`, [one.body.refs.t0]))[0].spotify_id;
		const am_id = String(1_400_000_000 + Math.floor(Math.random() * 99_999_999));
		const res = await contribute(user, { tracks: [{ ref: two.body.refs.t0, title: `${(await query(`select title from tracks_table where id = $1`, [two.body.refs.t0]))[0].title}`, service_ids: { applemusic_id: am_id, spotify_id: taken } }] });
		expect(res.status).toBe(200);
		// The free id is filled; the taken one stays with its owner and is recorded.
		const row = (await query(`select applemusic_id, spotify_id from service_ids_table where illusi_id = $1`, [two.body.refs.t0]))[0];
		expect(row.applemusic_id).toBe(am_id);
		expect(row.spotify_id).not.toBe(taken);
		const conflicts = await query(`select * from service_id_conflicts_table where incoming_value = $1`, [taken]);
		expect(conflicts.length).toBeGreaterThanOrEqual(1);
	});

	it('rejects malformed entities one by one and keeps the rest (§9.4)', async () => {
		const user = await create_user('partial');
		const res = await contribute(user, {
			artists: [{ ref: 'ok', name: unique('Partial Artist') }, { ref: 'bad' }],
			tracks: [{ ref: 't', title: 'Partial Track', duration_ms: -5 }],
			relations: { tracks_artists: [{ track_ref: 't', artist_ref: 'bad' }] }
		});
		expect(res.status).toBe(200);
		expect(Object.keys(res.body.refs)).toEqual(['ok']);
		expect(res.body.rejected.map((r: { kind: string }) => r.kind).sort()).toEqual(['artist', 'track', 'tracks_artists']);
	});

	it('enforces entity count limits', async () => {
		const user = await create_user('huge');
		const artists = Array.from({ length: 1001 }, (_, i) => ({ ref: `a${i}`, name: `Huge ${i}` }));
		expect((await contribute(user, { artists })).status).toBe(413);
	});
});

describe('POST /resolve (§8.3a)', () => {
	it('finds ids by service id or metadata without creating anything', async () => {
		const user = await create_user('resolver');
		const graph = mock_album({ artist: unique('Resolve Artist'), album: unique('Resolve Album'), n: 1 });
		const created = await contribute(user, graph);
		const before = (await query(`select count(*)::int as n from service_ids_table`))[0].n;
		const res = await api('POST', '/resolve', {
			token: user.access_token,
			body: {
				items: [
					{ ref: 'by-id', type: 'track', service_ids: { spotify_id: graph.tracks[0].service_ids.spotify_id } },
					{ ref: 'by-isrc', type: 'track', service_ids: { isrc: graph.tracks[0].service_ids.isrc } },
					{ ref: 'by-name', type: 'album', album: graph.albums[0].name, artist: graph.artists[0].name },
					{ ref: 'unknown', type: 'track', title: unique('Nothing Like This'), artist: unique('Nobody') }
				]
			}
		});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ 'by-id': created.body.refs.t0, 'by-isrc': created.body.refs.t0, 'by-name': created.body.refs.al, unknown: null });
		expect((await query(`select count(*)::int as n from service_ids_table`))[0].n).toBe(before);
	});
});
