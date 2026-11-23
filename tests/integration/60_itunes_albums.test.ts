import { randomInt } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
const { contribute, create_user, query, unique } = await import('./helpers');
const { complete_album, fill_album } = await import('../../src/services/catalog/album_fill');
const { attach_itunes_album } = await import('../../src/services/itunes/album_link');
const { PendingEvents } = await import('../../src/core/events');
const { db } = await import('../../src/db');

afterAll(async () => { await app.stop(); });

const am_id = () => 7_000_000_000 + randomInt(1_000_000_000);

function fake_album_tracks(collection: ITunesCollection, tracks: ITunesTrack[]) {
	const calls: number[][] = [];
	return {
		calls,
		lookups: {
			artist_albums: async () => ({ artist: null, albums: [] }),
			album_tracks: async (ids: readonly number[]) => {
				calls.push([...ids]);
				return new Map(ids.map(id => [id, { collection: id === collection.collectionId ? collection : null, tracks: id === collection.collectionId ? tracks : [] }]));
			}
		}
	};
}

const album_track_titles = async (album_id: string) => (await query(`
	select t.id, t.title from album_tracks_table x join tracks_table t on t.id = x.track_id where x.album_id = $1 order by x.track_number`, [album_id]));

describe('filling iTunes albums', () => {
	it('adds the songs the catalog lacks, reusing the tracks it has, and looks each album up once a day', async () => {
		const user = await create_user('album-fill');
		const name = unique('Fill Artist');
		const [am_artist, collection_id, song_1] = [am_id(), am_id(), am_id()];
		const created = await contribute(user, {
			artists: [{ ref: 'ar', name, service_ids: { applemusic_id: String(am_artist) } }],
			albums: [{ ref: 'al', name: `${name} Album`, artist_ref: 'ar', service_ids: { applemusic_id: String(collection_id) } }],
			tracks: [{ ref: 't1', title: `${name} One`, album_ref: 'al', duration_ms: 200_000, service_ids: { applemusic_id: String(song_1) } }],
			relations: { tracks_artists: [{ track_ref: 't1', artist_ref: 'ar' }], album_tracks: [{ album_ref: 'al', track_ref: 't1', track_number: 1 }] }
		});
		expect(created.status).toBe(200);
		const album_id = created.body.refs.al as string;
		const song = (id: number, title: string, n: number): ITunesTrack => ({
			wrapperType: 'track', kind: 'song', trackId: id, collectionId: collection_id, artistId: am_artist, artistName: name, trackName: title,
			trackNumber: n, trackTimeMillis: 200_000, trackExplicitness: 'notExplicit'
		});
		const collection: ITunesCollection = { wrapperType: 'collection', collectionId: collection_id, artistId: am_artist, artistName: name, collectionName: `${name} Album`, trackCount: 3 };
		const { lookups, calls } = fake_album_tracks(collection, [song(song_1, `${name} One`, 1), song(am_id(), `${name} Two`, 2), song(am_id(), `${name} Three`, 3)]);

		expect(await fill_album(lookups, album_id)).toBe(2);
		const tracks = await album_track_titles(album_id);
		expect(tracks.map(t => t.title)).toEqual([`${name} One`, `${name} Two`, `${name} Three`]);
		expect(tracks[0].id).toBe(created.body.refs.t1);

		await complete_album(album_id, 5_000, lookups);
		await complete_album(album_id, 5_000, lookups);
		expect(calls).toHaveLength(2);
		expect(await album_track_titles(album_id)).toHaveLength(3);
	});

	it('leaves albums without an Apple Music id alone', async () => {
		const user = await create_user('album-fill-none');
		const created = await contribute(user, { albums: [{ ref: 'al', name: unique('Plain Album') }] });
		const { lookups, calls } = fake_album_tracks({ wrapperType: 'collection', collectionId: 1 }, []);
		expect(await fill_album(lookups, created.body.refs.al as string)).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe('attaching a track to its iTunes album', () => {
	it('matches featured-artist titles and any credited artist', async () => {
		const user = await create_user('album-attach');
		const lead = unique('Attach Lead');
		const feature = unique('Attach Feature');
		const [am_artist, collection_id, song_id] = [am_id(), am_id(), am_id()];
		await query('insert into itunes_artists_table (id, name) values ($1, $2)', [am_artist, feature]);
		await query('insert into itunes_collections_table (id, name, artist_id, track_count) values ($1, $2, $3, 1)', [collection_id, `${feature} Record - Single`, am_artist]);
		await query('insert into itunes_tracks_table (id, name, artist_id, collection_id, track_number, track_time_millis) values ($1, $2, $3, $4, 1, 200000)',
			[song_id, `The Zone (feat. ${lead})`, am_artist, collection_id]);
		const created = await contribute(user, {
			artists: [{ ref: 'lead', name: lead }, { ref: 'feat', name: feature }],
			tracks: [{ ref: 't', title: 'The Zone', duration_ms: 200_500 }],
			relations: { tracks_artists: [{ track_ref: 't', artist_ref: 'lead' }, { track_ref: 't', artist_ref: 'feat' }] }
		});
		const track_id = created.body.refs.t as string;
		const album_id = await db.transaction(async tx => attach_itunes_album(tx, track_id, song_id, new PendingEvents()));
		expect(album_id).not.toBeNull();
		const [album] = await query('select a.name, a.album_type, a.artist_id from albums_table a where a.id = $1', [album_id]);
		expect(album).toMatchObject({ name: `${feature} Record`, album_type: 'SINGLE', artist_id: created.body.refs.feat });
		expect((await query('select album_id from tracks_table where id = $1', [track_id]))[0].album_id).toBe(album_id);
	});

	it('still refuses a different duration', async () => {
		const user = await create_user('album-attach-off');
		const artist = unique('Attach Off');
		const [am_artist, collection_id, song_id] = [am_id(), am_id(), am_id()];
		await query('insert into itunes_artists_table (id, name) values ($1, $2)', [am_artist, artist]);
		await query('insert into itunes_collections_table (id, name, artist_id, track_count) values ($1, $2, $3, 1)', [collection_id, `${artist} Record`, am_artist]);
		await query('insert into itunes_tracks_table (id, name, artist_id, collection_id, track_time_millis) values ($1, $2, $3, $4, 200000)', [song_id, 'Song', am_artist, collection_id]);
		const created = await contribute(user, {
			artists: [{ ref: 'ar', name: artist }],
			tracks: [{ ref: 't', title: 'Song', duration_ms: 230_000 }],
			relations: { tracks_artists: [{ track_ref: 't', artist_ref: 'ar' }] }
		});
		expect(await db.transaction(async tx => attach_itunes_album(tx, created.body.refs.t as string, song_id, new PendingEvents()))).toBeNull();
	});
});
