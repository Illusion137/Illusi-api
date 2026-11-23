import { beforeAll, describe, expect, it } from 'vitest';
import { api, contribute, create_user, make_admin, query, unique } from './helpers';
import type { TestUser } from './helpers';

let user: TestUser;
let admin: TestUser;

beforeAll(async () => {
	user = await create_user('match');
	admin = await make_admin(await create_user('credits-admin'));
});

const song = (ref: string, title: string, artist_ref: string, ms = 180_000) => ({
	graph: { ref, title, duration_ms: ms },
	link: { track_ref: ref, artist_ref }
});

async function push(artist: { name: string; service_ids?: Record<string, string> }, tracks: { ref: string; title: string; duration_ms?: number }[]) {
	const res = await contribute(user, {
		artists: [{ ref: 'ar', ...artist }],
		tracks,
		relations: { tracks_artists: tracks.map(t => ({ track_ref: t.ref, artist_ref: 'ar' })) }
	});
	expect(res.status).toBe(200);
	return res.body as { refs: Record<string, string>; conflicts: { kind: string }[] };
}

describe('artists matched by name', () => {
	it('a new song by an artist already in the catalog joins that artist', async () => {
		const name = unique('Lelo');
		const first = await push({ name }, [song('a', unique('Like Sunday'), 'ar').graph]);
		const second = await push({ name: name.toUpperCase() }, [song('b', unique('Another'), 'ar').graph]);
		expect(second.refs.ar).toBe(first.refs.ar);
		expect(await query('select 1 from artists_table where lower(name) = lower($1)', [name])).toHaveLength(1);
	});

	it('keeps same-name artists apart when their ids on a service differ, but not YouTube channels', async () => {
		const name = unique('Sudo');
		const a = await push({ name, service_ids: { spotify_id: unique('sp').replace(/-/gu, '').padEnd(22, 'x').slice(0, 22) } }, [song('a', unique('One'), 'ar').graph]);
		const b = await push({ name, service_ids: { spotify_id: unique('sp').replace(/-/gu, '').padEnd(22, 'y').slice(0, 22) } }, [song('b', unique('Two'), 'ar').graph]);
		expect(b.refs.ar).not.toBe(a.refs.ar);

		const yt = unique('Brentlafou');
		const c = await push({ name: yt, service_ids: { youtube_id: `UC${'a'.repeat(22)}` } }, [song('c', unique('Three'), 'ar').graph]);
		const d = await push({ name: yt, service_ids: { youtube_id: `UC${'b'.repeat(22)}` } }, [song('d', unique('Four'), 'ar').graph]);
		expect(d.refs.ar).toBe(c.refs.ar);
	});
});

describe('joint credits sent as one artist', () => {
	const credits = async (track_id: string) => (await query<{ name: string }>(
		'select a.name from tracks_artists_table ta join artists_table a on a.id = ta.artist_id where ta.track_id = $1', [track_id])).map(r => r.name).sort();
	const permalink = () => unique('sc').toLowerCase();

	it('split into each artist when the account belongs to one of them', async () => {
		const owner = unique('StanWill');
		const sc = permalink();
		const first = await push({ name: owner, service_ids: { soundcloud_permalink: sc } }, [song('a', unique('Solo'), 'ar').graph]);
		const guest = unique('NASAAN');
		const joint = await push({ name: `${owner} & ${guest}`, service_ids: { soundcloud_permalink: sc } }, [song('b', unique('Lime Light'), 'ar').graph]);
		expect(joint.refs.ar).toBe(first.refs.ar);
		expect(await credits(joint.refs.b)).toEqual([guest, owner].sort());
		expect((await query('select name from artists_table where id = $1', [first.refs.ar]))[0].name).toBe(owner);
		expect(await query('select 1 from review_items_table where entity_id = $1', [first.refs.ar])).toEqual([]);

		// The owner needn't be named first; the account stays with its owner either way.
		const other = unique('Guest');
		const flipped = await push({ name: `${other}, and ${owner}`, service_ids: { soundcloud_permalink: sc } }, [song('c', unique('Flipped'), 'ar').graph]);
		expect(flipped.refs.ar).toBe(first.refs.ar);
		expect(await credits(flipped.refs.c)).toEqual([other, owner].sort());
		expect(await query('select 1 from artists_table a join service_ids_table s on s.illusi_id = a.id where s.soundcloud_permalink = $1', [sc])).toHaveLength(1);
	});

	it('drop separators sent as artists', async () => {
		const [a, b] = [unique('waera'), unique('imnotvrycreative')];
		const res = await contribute(user, {
			artists: [{ ref: 'a', name: a }, { ref: 'sep', name: ' & ' }, { ref: 'mark', name: '\u200e' }, { ref: 'b', name: b }],
			tracks: [{ ref: 't', title: unique('MALCOLM'), duration_ms: 150_000 }],
			relations: { tracks_artists: ['a', 'sep', 'mark', 'b'].map(artist_ref => ({ track_ref: 't', artist_ref })) }
		});
		expect(res.status).toBe(200);
		expect(await credits(res.body.refs.t)).toEqual([a, b].sort());
	});

	it('split when the parts are already artists, and kept whole otherwise', async () => {
		const [a, b, c] = [unique('Shitty'), unique('Tron'), unique('Trdee')];
		const known = await contribute(user, { artists: [{ ref: 'a', name: a }, { ref: 'b', name: b }] });
		expect(known.status).toBe(200);
		const list = await push({ name: `${a}, ${b}, and ${c}` }, [song('t', unique('Five Guys'), 'ar').graph]);
		expect(await credits(list.refs.t)).toEqual([a, b, c].sort());
		expect(await query('select 1 from artists_table where name = $1', [`${a}, ${b}, and ${c}`])).toEqual([]);

		// A duo nobody knows apart, an artist whose name has a comma, and a service's own joint artist stay as they are.
		const duo = unique('Joey Valence & Brae');
		const kept = await push({ name: duo }, [song('d', unique('Punk Tactics'), 'ar').graph]);
		expect(await credits(kept.refs.d)).toEqual([duo]);
		const comma = `${unique('Tyler')}, The Creator`;
		await push({ name: comma }, [song('e', unique('Noid'), 'ar').graph]);
		const again = await push({ name: comma }, [song('f', unique('She'), 'ar').graph]);
		expect(await credits(again.refs.f)).toEqual([comma]);
		const catalog = await push({ name: `${a} & ${b}`, service_ids: { applemusic_id: '9100000777' } }, [song('g', unique('Collab'), 'ar').graph]);
		expect(await credits(catalog.refs.g)).toEqual([`${a} & ${b}`]);
	});
});

describe('albums whose numbers differ', () => {
	it('are created apart instead of matched', async () => {
		const artist = unique('Lil Boat Artist');
		const make = (album: string) => contribute(user, {
			artists: [{ ref: 'ar', name: artist }],
			albums: [{ ref: 'al', name: album, artist_ref: 'ar' }],
			relations: { artist_albums: [{ artist_ref: 'ar', album_ref: 'al' }] }
		});
		const two = await make('Lil Boat 2');
		const three = await make('Lil Boat 3');
		expect(three.body.refs.al).not.toBe(two.body.refs.al);
		expect(await query('select 1 from review_items_table where entity_id = $1', [two.body.refs.al])).toEqual([]);
	});
});

describe('conflicts settled without review', () => {
	it('applies a plainer title and an artist\'s own name, ignores joint credits, reviews the rest', async () => {
		const name = unique('Tory');
		const yt = unique('yt').replace(/-/gu, '').slice(0, 11).padEnd(11, '0');
		const first = await contribute(user, {
			artists: [{ ref: 'ar', name: `${name} & Trippie Redd`, service_ids: { applemusic_id: '9100000001' } }],
			tracks: [{ ref: 't', title: 'Fantasy (Official 4K Video)', duration_ms: 200_000, service_ids: { youtube_id: yt } }],
			relations: { tracks_artists: [{ track_ref: 't', artist_ref: 'ar' }] }
		});
		const { ar, t } = first.body.refs;
		await contribute(user, {
			artists: [{ ref: 'ar', name, service_ids: { applemusic_id: '9100000001' } }],
			tracks: [{ ref: 't', title: 'Fantasy', duration_ms: 200_000, service_ids: { youtube_id: yt } }],
			relations: { tracks_artists: [{ track_ref: 't', artist_ref: 'ar' }] }
		});
		expect((await query('select name from artists_table where id = $1', [ar]))[0].name).toBe(name);
		expect((await query('select title from tracks_table where id = $1', [t]))[0].title).toBe('Fantasy');

		await contribute(user, { artists: [{ ref: 'ar', name: `${name} & Drake`, service_ids: { applemusic_id: '9100000001' } }] });
		await contribute(user, { tracks: [{ ref: 't', title: 'Fantasy [prod. Someone]', duration_ms: 200_000, service_ids: { youtube_id: yt } }] });
		expect((await query('select name from artists_table where id = $1', [ar]))[0].name).toBe(name);
		expect((await query('select title from tracks_table where id = $1', [t]))[0].title).toBe('Fantasy');
		expect(await query('select 1 from review_items_table where entity_id = any($1)', [[ar, t]])).toEqual([]);

		await contribute(user, { tracks: [{ ref: 't', title: 'Doves to Vultures', duration_ms: 200_000, service_ids: { youtube_id: yt } }] });
		expect(await query(`select 1 from review_items_table where entity_id = $1 and field = 'title' and status = 'OPEN'`, [t])).toHaveLength(1);
	});
});

describe('admin track credits', () => {
	it('rewrites artists in order, moves the album, creates new ones, and is audited', async () => {
		const created = await contribute(user, {
			artists: [{ ref: 'a1', name: unique('Credit A') }, { ref: 'a2', name: unique('Credit B') }],
			albums: [{ ref: 'al', name: unique('Credit Album'), artist_ref: 'a1' }, { ref: 'comp', name: unique('Credit Comp'), artist_ref: 'a2' }],
			tracks: [{ ref: 't', title: unique('Credit Song'), duration_ms: 150_000, album_ref: 'al' }],
			relations: {
				tracks_artists: [{ track_ref: 't', artist_ref: 'a1' }, { track_ref: 't', artist_ref: 'a2' }],
				album_tracks: [{ album_ref: 'al', track_ref: 't', track_number: 1 }, { album_ref: 'comp', track_ref: 't', track_number: 9 }]
			}
		});
		const { a1, a2, al, comp, t } = created.body.refs;
		const put = (body: object, token = admin.access_token) => api('PUT', `/admin/tracks/${t}/credits`, { token, body });

		expect((await put({ artists: [{ id: a1 }] }, user.access_token)).status).toBe(403);
		expect((await put({})).status).toBe(400);

		const detail = await api('GET', `/admin/tracks/${t}`, { token: admin.access_token });
		expect(detail.body.credits.artists.map((a: { id: string }) => a.id).sort()).toEqual([a1, a2].sort());
		expect(detail.body.credits.albums[0]).toMatchObject({ id: al, primary: true, track_number: 1 });

		const new_artist = unique('Credit New');
		const new_album = unique('Credit New Album');
		const saved = await put({ artists: [{ id: a2 }, { name: new_artist }, { id: a1 }], album: { name: new_album }, track_number: 3, unlink_albums: [comp] });
		expect(saved.status).toBe(200);
		expect(saved.body.artists.map((a: { name: string }) => a.name)).toEqual([expect.any(String), new_artist, expect.any(String)]);
		expect(saved.body.artists[0].id).toBe(a2);
		expect(saved.body.artists[2].id).toBe(a1);
		expect(saved.body.albums).toEqual([expect.objectContaining({ name: new_album, primary: true, track_number: 3 })]);
		const [album] = await query('select id, artist_id from albums_table where name = $1', [new_album]);
		expect(album.artist_id).toBe(a2);
		expect(await query('select 1 from album_tracks_table where track_id = $1 and album_id = any($2)', [t, [al, comp]])).toEqual([]);
		expect(await query(`select 1 from audit_log_table where entity_id = $1 and action = 'admin_edit' and details ? 'credits'`, [t])).toHaveLength(1);

		const found = await api('GET', `/admin/search/artists?q=${encodeURIComponent(new_artist)}`, { token: admin.access_token });
		expect(found.body.items[0]).toMatchObject({ name: new_artist, tracks: 1 });
		const albums = await api('GET', `/admin/search/albums?q=${encodeURIComponent(new_album)}`, { token: admin.access_token });
		expect(albums.body.items[0]).toMatchObject({ id: album.id, tracks: 1 });

		expect((await put({ album: null })).body.albums).toEqual([]);
	});
});
