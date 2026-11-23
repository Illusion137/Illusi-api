import { randomInt } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
const { add_to_library, api, contribute, create_user, query, unique } = await import('./helpers');
const { check_artist, check_due_artists } = await import('../../src/services/releases/itunes_checks');
const { due_applemusic_artists } = await import('../../src/services/releases/query');
const { db } = await import('../../src/db');
const { config } = await import('../../src/config');

afterAll(async () => { await app.stop(); });

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function fake_itunes(albums: ITunesCollection[], songs: Record<number, ITunesTrack[]>) {
	const calls = { artist_albums: 0, album_tracks: [] as number[][] };
	return {
		calls,
		lookups: {
			artist_albums: async (_id: number) => {
				calls.artist_albums++;
				return { artist: null, albums };
			},
			album_tracks: async (ids: readonly number[]) => {
				calls.album_tracks.push([...ids]);
				return new Map(ids.map(id => [id, { collection: null, tracks: songs[id] ?? [] }]));
			}
		}
	};
}

/** A library artist with an Apple Music id. */
async function library_artist(name: string) {
	const user = await create_user('relcheck');
	const am_artist = 8_000_000_000 + randomInt(1_000_000_000);
	const created = await contribute(user, {
		artists: [{ ref: 'ar', name, service_ids: { applemusic_id: String(am_artist) } }],
		tracks: [{ ref: 'old', title: `${name} Old Song`, duration_ms: 180_000, service_ids: { applemusic_id: String(am_artist + 1) } }],
		relations: { tracks_artists: [{ track_ref: 'old', artist_ref: 'ar' }] }
	});
	expect(created.status).toBe(200);
	await add_to_library(user, [created.body.refs.old]);
	return { user, artist_id: created.body.refs.ar as string, am_artist };
}

describe('server release checks on Apple Music', () => {
	it('adds the artist\'s releases from the window with their songs, once', async () => {
		const name = unique('Relcheck Artist');
		const { user, artist_id, am_artist } = await library_artist(name);
		const feature = { id: am_artist + 50, name: unique('Feature') };
		const collection = (id: number, title: string, released: string, extra: Partial<ITunesCollection> = {}): ITunesCollection => ({
			wrapperType: 'collection', collectionId: id, artistId: am_artist, artistName: name, collectionName: title, trackCount: 2,
			releaseDate: released, collectionExplicitness: 'explicit', artworkUrl100: `https://img.test/${id}/100x100bb.jpg`, ...extra
		});
		const song = (id: number, collection_id: number, title: string, n: number, by = { id: am_artist, name }): ITunesTrack => ({
			wrapperType: 'track', kind: 'song', trackId: id, collectionId: collection_id, artistId: by.id, artistName: by.name, trackName: title,
			trackNumber: n, trackTimeMillis: 190_000 + n, trackExplicitness: 'notExplicit'
		});
		const fresh = am_artist + 10;
		const { lookups, calls } = fake_itunes([
			collection(fresh, `${name} Fresh - Single`, days(-2), { trackCount: 1 }),
			collection(am_artist + 11, `${name} Back Catalog`, days(-90)),
			collection(am_artist + 12, `${name} Preorder`, days(5)),
			collection(am_artist + 13, `${name} Someone Else's Comp`, days(-1), { artistId: am_artist + 99 })
		], { [fresh]: [song(am_artist + 20, fresh, `${name} Fresh`, 1), song(am_artist + 21, fresh, `${name} Fresh Remix`, 2, feature)] });

		expect(await check_artist(lookups, artist_id, String(am_artist))).toBe(1);
		expect(calls.album_tracks).toEqual([[fresh]]);

		const [album] = await query(`select a.id, a.name, a.album_type, a.release_date, a.artist_id from albums_table a join service_ids_table s on s.illusi_id = a.id where s.applemusic_id = $1`, [String(fresh)]);
		expect(album).toMatchObject({ name: `${name} Fresh`, album_type: 'SINGLE', artist_id });
		const tracks = await query(`
			select t.title, at.track_number, array_agg(ar.name order by ar.name) as artists from album_tracks_table at
			join tracks_table t on t.id = at.track_id join tracks_artists_table ta on ta.track_id = t.id join artists_table ar on ar.id = ta.artist_id
			where at.album_id = $1 group by t.title, at.track_number order by at.track_number`, [album.id]);
		expect(tracks).toEqual([
			{ title: `${name} Fresh`, track_number: 1, artists: [name] },
			{ title: `${name} Fresh Remix`, track_number: 2, artists: [feature.name] }
		]);
		const [check] = await query(`select checked_at, checked_by from artist_release_checks_table where artist_id = $1 and service = 'applemusic'`, [artist_id]);
		expect(check.checked_at).not.toBeNull();
		expect(check.checked_by).toBeNull();
		expect(await query(`select 1 from contributions_log_table where source = 'itunes' and entities::text like $1`, [`%${album.id}%`])).toHaveLength(1);

		// The library owner sees it as a new release; nothing outside the window or by someone else was added.
		const mine = await api('GET', '/new-releases/me', { token: user.access_token });
		expect(mine.body.albums.map((a: { id: string }) => a.id)).toEqual([album.id]);
		expect(await query(`select 1 from service_ids_table where applemusic_id = any($1)`, [[am_artist + 11, am_artist + 12, am_artist + 13].map(String)])).toEqual([]);

		// Checked again: already in the catalog, so no songs are looked up and nothing is added.
		expect(await check_artist(lookups, artist_id, String(am_artist))).toBe(0);
		expect(calls.album_tracks).toHaveLength(1);
	});

	it('checks due artists, skips fresh checks, and keeps clients from repeating them', async () => {
		const { user, artist_id } = await library_artist(unique('Due Artist'));
		const hour_ago = new Date(Date.now() - 3_600_000);
		const due = async () => (await due_applemusic_artists(db, hour_ago, 100_000)).map(r => r.artist_id);
		expect(await due()).toContain(artist_id);

		// Other suites' library artists share this database: take them all in one pass.
		const batch = config.NEW_RELEASES_SERVER_BATCH;
		config.NEW_RELEASES_SERVER_BATCH = 100_000;
		try {
			await check_due_artists(fake_itunes([], {}).lookups);
		} finally {
			config.NEW_RELEASES_SERVER_BATCH = batch;
		}
		expect(await due()).not.toContain(artist_id);
		expect(await query(`select 1 from artist_release_checks_table where artist_id = $1 and service = 'applemusic' and checked_at is not null`, [artist_id])).toHaveLength(1);

		// A client logged into Apple Music isn't handed a check the server just did.
		const asked = await api('GET', '/new-releases/me?services=applemusic', { token: user.access_token });
		expect(asked.status).toBe(200);
		const actions = (asked.body.actions ?? []) as { artist_id?: string }[];
		expect(actions.filter(a => a.artist_id === artist_id)).toEqual([]);
	});

	it('records the check when the artist has nothing new or a malformed id', async () => {
		const { artist_id } = await library_artist(unique('Quiet Artist'));
		const { lookups, calls } = fake_itunes([], {});
		expect(await check_artist(lookups, artist_id, 'not-a-number')).toBe(0);
		expect(calls.artist_albums).toBe(0);
		expect(await query(`select 1 from artist_release_checks_table where artist_id = $1 and service = 'applemusic'`, [artist_id])).toHaveLength(1);
	});
});
