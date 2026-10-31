import { randomInt } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db';
import { itunes_artists_table, itunes_collections_table, itunes_lookups_table, itunes_tracks_table, thumbnails_table } from '../../src/db/schema';
import { PendingEvents } from '../../src/core/events';
import { found_from_result, resolve_request, result_for_id } from '../../src/services/itunes/pipeline';
import {
	find_entity, link_entities, link_states, persist_artist, persist_collection, persist_track, record_lookup, scan_candidates, stored_artists,
	stored_collection_row, stored_collections, stored_track_row, stored_tracks
} from '../../src/services/itunes/store';
import type { ITunesClient } from '../../src/services/itunes/client';
import { pool, unique, uuid } from './helpers';

const BASE = 9_000_000_000 + randomInt(1_000_000) * 1000;
let next_id = BASE;
const itunes_id = () => next_id++;

const seeded: string[] = [];
const itunes_artist_ids: number[] = [];

async function seed(table: 'artist' | 'album' | 'track', fields: { name: string; artist_id?: string; album_id?: string; applemusic_id?: string; track_count?: number; duration_ms?: number; imported?: boolean }) {
	const id = uuid();
	await pool.query('insert into service_ids_table (illusi_id, applemusic_id) values ($1, $2)', [id, fields.applemusic_id ?? null]);
	if (table === 'artist') await pool.query('insert into artists_table (id, name) values ($1, $2)', [id, fields.name]);
	if (table === 'album') await pool.query('insert into albums_table (id, artist_id, name, track_count) values ($1, $2, $3, $4)', [id, fields.artist_id ?? null, fields.name, fields.track_count ?? null]);
	if (table === 'track') {
		await pool.query('insert into tracks_table (id, title, album_id, duration_ms, imported) values ($1, $2, $3, $4, $5)', [id, fields.name, fields.album_id ?? null, fields.duration_ms ?? null, fields.imported ?? false]);
		if (fields.artist_id) await pool.query('insert into tracks_artists_table (artist_id, track_id) values ($1, $2)', [fields.artist_id, id]);
	}
	seeded.push(id);
	return id;
}

const it_artist = (id: number, name: string) => ({ wrapperType: 'artist' as const, artistId: id, artistName: name, artistType: 'Artist', primaryGenreName: 'Pop' });
const it_collection = (id: number, artist: { id: number; name: string }, name: string, extra: Record<string, unknown> = {}) => ({
	wrapperType: 'collection' as const, collectionType: 'Album', collectionId: id, artistId: artist.id, artistName: artist.name, collectionName: name,
	collectionCensoredName: name, trackCount: 10, artworkUrl100: `https://img.test/${id}/100x100bb.jpg`, ...extra
});
const it_track = (id: number, artist: { id: number; name: string }, collection_id: number | null, name: string, extra: Record<string, unknown> = {}) => ({
	wrapperType: 'track' as const, kind: 'song', trackId: id, artistId: artist.id, artistName: artist.name, collectionId: collection_id ?? undefined, collectionName: undefined,
	trackName: name, trackCensoredName: name, trackTimeMillis: 200_000, previewUrl: `https://audio.test/${id}.m4a`, artworkUrl100: `https://img.test/t${id}/100x100bb.jpg`, ...extra
});

afterAll(async () => {
	if (seeded.length > 0) {
		await pool.query('delete from tracks_artists_table where track_id = any($1)', [seeded]);
		await pool.query('delete from tracks_table where id = any($1)', [seeded]);
		await pool.query('delete from albums_table where id = any($1)', [seeded]);
		await pool.query('delete from artists_table where id = any($1)', [seeded]);
		await pool.query('delete from thumbnails_table where id = any($1)', [seeded]);
		await pool.query('delete from itunes_lookups_table where illusi_id = any($1)', [seeded]);
		await pool.query('delete from service_id_conflicts_table where illusi_id = any($1)', [seeded]);
		await pool.query('delete from service_ids_table where illusi_id = any($1)', [seeded]);
	}
	await pool.query('delete from itunes_tracks_table where id >= $1 and id < $2', [BASE, next_id]);
	await pool.query('delete from itunes_collections_table where id >= $1 and id < $2', [BASE, next_id]);
	await pool.query('delete from itunes_artists_table where id >= $1 and id < $2', [BASE, next_id]);
});

describe('iTunes store: persistence', () => {
	it('persists artist, collection and track rows with foreign keys intact', async () => {
		const artist = { id: itunes_id(), name: unique('Persist Artist') };
		const album_id = itunes_id();
		const track_id = itunes_id();
		const row = await db.transaction(tx => persist_track(tx, {
			artist: it_artist(artist.id, artist.name),
			collection: it_collection(album_id, artist, 'Persist Album'),
			track: it_track(track_id, artist, album_id, 'Persist Song')
		}));
		expect(row).toMatchObject({ id: track_id, artist_id: artist.id, collection_id: album_id, name: 'Persist Song' });
		expect((await stored_track_row(track_id))).toMatchObject({ id: track_id, preview_url: `https://audio.test/${track_id}.m4a` });
		expect((await stored_collection_row(album_id))).toMatchObject({ id: album_id, artist_id: artist.id });
		expect(await stored_track_row(track_id + 100_000)).toBeNull();
		expect(await stored_collection_row(album_id + 100_000)).toBeNull();
	});

	it('derives minimal parent rows from a track when only the track is known', async () => {
		const artist = { id: itunes_id(), name: unique('Derived Artist') };
		const album_id = itunes_id();
		const track_id = itunes_id();
		const row = await db.transaction(tx => persist_track(tx, {
			track: it_track(track_id, artist, album_id, 'Derived Song', { collectionName: 'Derived Album' })
		}));
		expect(row).toMatchObject({ artist_id: artist.id, collection_id: album_id });
		const [parent] = await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, artist.id));
		expect(parent.name).toBe(artist.name);
		const [collection] = await db.select().from(itunes_collections_table).where(eq(itunes_collections_table.id, album_id));
		expect(collection).toMatchObject({ name: 'Derived Album', artist_id: artist.id });
	});

	it('leaves the foreign keys null when the parents cannot be derived', async () => {
		const track_id = itunes_id();
		const row = await db.transaction(tx => persist_track(tx, {
			track: { wrapperType: 'track', kind: 'song', trackId: track_id, artistId: itunes_id(), collectionId: itunes_id(), trackName: 'Orphan' }
		}));
		expect(row).toMatchObject({ artist_id: null, collection_id: null });
		expect(await stored_track_row(track_id)).toMatchObject({ artist_id: null, collection_id: null });
	});

	it('does not let a derived artist overwrite a stored full artist, but a full one updates it', async () => {
		const artist = { id: itunes_id(), name: unique('Stable Artist') };
		await db.transaction(tx => persist_artist(tx, it_artist(artist.id, artist.name)));
		await db.transaction(tx => persist_track(tx, { track: it_track(itunes_id(), { id: artist.id, name: 'Different Name' }, null, 'S') }));
		let [row] = await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, artist.id));
		expect(row.name).toBe(artist.name);
		expect(row.primary_genre_name).toBe('Pop');
		await db.transaction(tx => persist_artist(tx, { ...it_artist(artist.id, artist.name), primaryGenreName: 'Rock' }));
		[row] = await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, artist.id));
		expect(row.primary_genre_name).toBe('Rock');
	});

	it('persists a collection with its full artist and with a derived one', async () => {
		const artist = { id: itunes_id(), name: unique('Coll Artist') };
		const first = itunes_id();
		const row = await db.transaction(tx => persist_collection(tx, { artist: it_artist(artist.id, artist.name), collection: it_collection(first, artist, 'First') }));
		expect(row.artist_id).toBe(artist.id);
		const other = { id: itunes_id(), name: unique('Other Artist') };
		const second = itunes_id();
		await db.transaction(tx => persist_collection(tx, { collection: it_collection(second, other, 'Second') }));
		expect((await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, other.id)))).toHaveLength(1);
		const third = itunes_id();
		const bare = await db.transaction(tx => persist_collection(tx, { collection: { wrapperType: 'collection', collectionId: third, artistId: itunes_id(), collectionName: 'Bare' } }));
		expect(bare.artist_id).toBeNull();
	});

	it('rolls everything back when the transaction fails', async () => {
		const artist = { id: itunes_id(), name: unique('Rollback Artist') };
		await expect(db.transaction(async (tx) => {
			await persist_artist(tx, it_artist(artist.id, artist.name));
			throw new Error('abort');
		})).rejects.toThrow('abort');
		expect(await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, artist.id))).toHaveLength(0);
	});
});

describe('iTunes store: stored rows reuse', () => {
	it('finds stored artists, collections and tracks by artist', async () => {
		const artist = { id: itunes_id(), name: unique('Reuse Artist') };
		const album_id = itunes_id();
		const track_id = itunes_id();
		await db.transaction(tx => persist_track(tx, {
			artist: it_artist(artist.id, artist.name),
			collection: it_collection(album_id, artist, 'Reuse Album', { collectionExplicitness: 'explicit' }),
			track: it_track(track_id, artist, album_id, 'Reuse Song', { trackExplicitness: 'notExplicit' })
		}));
		expect((await stored_artists(artist.name.toUpperCase(), 0.9)).map(a => a.id)).toEqual([artist.id]);
		expect(await stored_artists('Totally Unrelated Name Zzz', 0.9)).toEqual([]);
		expect(await stored_collections([])).toEqual([]);
		expect(await stored_tracks([])).toEqual([]);
		expect(await stored_collections([artist.id])).toEqual([expect.objectContaining({
			wrapperType: 'collection', collectionId: album_id, collectionName: 'Reuse Album', collectionExplicitness: 'explicit', artistId: artist.id, trackCount: 10
		})]);
		expect(await stored_tracks([artist.id])).toEqual([expect.objectContaining({
			wrapperType: 'track', kind: 'song', trackId: track_id, trackName: 'Reuse Song', collectionId: album_id, collectionName: 'Reuse Album', trackExplicitness: 'notExplicit', trackTimeMillis: 200_000
		})]);
	});
});

describe('iTunes store: candidates and link state', () => {
	it('scans unlinked tracks of a known set, skipping imported ones', async () => {
		const artist = await seed('artist', { name: unique('Scan Artist') });
		const album = await seed('album', { name: unique('Scan Album'), artist_id: artist });
		const search = await seed('track', { name: unique('Searchable'), artist_id: artist, album_id: album, duration_ms: 123_000 });
		const known = await seed('track', { name: unique('Known'), artist_id: artist, applemusic_id: '55512345' });
		const anonymous = await seed('track', { name: unique('No Artist') });
		const imported = await seed('track', { name: unique('Imported'), artist_id: artist, imported: true });
		const rows = await scan_candidates('track', { ids: [search, known, anonymous, imported], limit: 10 });
		expect(rows.map(r => r.illusi_id).sort()).toEqual([search, known, anonymous].sort());
		const by_id = new Map(rows.map(r => [r.illusi_id, r]));
		expect(by_id.get(search)).toMatchObject({
			entity_type: 'track', applemusic_id: null,
			request: { type: 'track', album_name: expect.stringContaining('Scan Album'), duration_ms: 123_000, artist_name: expect.stringContaining('Scan Artist') }
		});
		expect(by_id.get(known)).toMatchObject({ applemusic_id: '55512345' });
		expect(by_id.get(anonymous)?.request).toBeNull();
	});

	it('scans albums and artists', async () => {
		const artist = await seed('artist', { name: unique('Scan2 Artist') });
		const album = await seed('album', { name: unique('Scan2 Album'), artist_id: artist, track_count: 7 });
		const orphan_album = await seed('album', { name: unique('Orphan Album') });
		const albums = await scan_candidates('album', { ids: [album, orphan_album], limit: 10 });
		expect(albums.find(a => a.illusi_id === album)).toMatchObject({ entity_type: 'album', request: { type: 'album', track_count: 7, artist_name: expect.stringContaining('Scan2 Artist') } });
		expect(albums.find(a => a.illusi_id === orphan_album)?.request).toBeNull();
		const artists = await scan_candidates('artist', { ids: [artist], limit: 10 });
		expect(artists).toEqual([expect.objectContaining({ illusi_id: artist, entity_type: 'artist', request: { type: 'artist', artist_name: expect.stringContaining('Scan2 Artist') } })]);
	});

	it('returns nothing for an empty id list and pages with after/limit', async () => {
		expect(await scan_candidates('track', { ids: [], limit: 10 })).toEqual([]);
		const ids = [await seed('artist', { name: unique('Page A') }), await seed('artist', { name: unique('Page B') }), await seed('artist', { name: unique('Page C') })].sort();
		const first = await scan_candidates('artist', { ids, limit: 2 });
		expect(first.map(r => r.illusi_id)).toEqual(ids.slice(0, 2));
		const rest = await scan_candidates('artist', { ids, after: first[1].illusi_id, limit: 2 });
		expect(rest.map(r => r.illusi_id)).toEqual([ids[2]]);
	});

	it('skips linked entities and entities whose lookup is not due, and requeues them once due', async () => {
		const artist = await seed('artist', { name: unique('Due Artist') });
		const linked_to = itunes_id();
		await db.transaction(tx => persist_artist(tx, it_artist(linked_to, unique('Linked'))));
		const linked = await seed('artist', { name: unique('Linked Local'), applemusic_id: String(linked_to) });
		const not_numeric = await seed('artist', { name: unique('Odd Id'), applemusic_id: 'abc' });
		expect((await scan_candidates('artist', { ids: [artist, linked, not_numeric], limit: 10 })).map(r => r.illusi_id).sort()).toEqual([artist, not_numeric].sort());

		await record_lookup(db, [artist], 'artist', 'NOT_FOUND');
		expect(await scan_candidates('artist', { ids: [artist], limit: 10 })).toEqual([]);
		await pool.query(`update itunes_lookups_table set retry_after = now() - interval '1 minute' where illusi_id = $1`, [artist]);
		expect(await scan_candidates('artist', { ids: [artist], limit: 10 })).toHaveLength(1);
		await record_lookup(db, [artist], 'artist', 'FOUND');
		await pool.query(`update itunes_lookups_table set retry_after = null where illusi_id = $1`, [artist]);
		expect(await scan_candidates('artist', { ids: [artist], limit: 10 })).toEqual([]);
	});

	it('locates entities by id', async () => {
		const artist = await seed('artist', { name: unique('Find Artist') });
		const album = await seed('album', { name: unique('Find Album') });
		const track = await seed('track', { name: unique('Find Track'), imported: true });
		expect(await find_entity(artist)).toEqual({ entity_type: 'artist', imported: false });
		expect(await find_entity(album)).toEqual({ entity_type: 'album', imported: false });
		expect(await find_entity(track)).toEqual({ entity_type: 'track', imported: true });
		expect(await find_entity(uuid())).toBeNull();
	});

	it('reports link state per id', async () => {
		expect((await link_states('track', [])).size).toBe(0);
		const stored = itunes_id();
		await db.transaction(tx => persist_artist(tx, it_artist(stored, unique('LS'))));
		const unlinked = await seed('artist', { name: unique('LS unlinked') });
		const with_id = await seed('artist', { name: unique('LS with id'), applemusic_id: '77700001' });
		const linked = await seed('artist', { name: unique('LS linked'), applemusic_id: String(stored) });
		const states = await link_states('artist', [unlinked, with_id, linked, uuid()]);
		expect(states.size).toBe(3);
		expect(states.get(unlinked)).toEqual({ applemusic_id: null, linked: false });
		expect(states.get(with_id)).toEqual({ applemusic_id: '77700001', linked: false });
		expect(states.get(linked)).toEqual({ applemusic_id: String(stored), linked: true });
	});
});

describe('iTunes store: linking and lookup records', () => {
	it('links entities, attaches artwork and queues the linked event for tracks with a preview', async () => {
		const artist = { id: itunes_id(), name: unique('Link Artist') };
		const track_it = itunes_id();
		const local = await seed('track', { name: unique('Link Track') });
		const events = new PendingEvents();
		const push = vi.spyOn(events, 'push');
		const linked = await db.transaction(async (tx) => {
			const row = await persist_track(tx, { artist: it_artist(artist.id, artist.name), track: it_track(track_it, artist, null, 'Link Song') });
			return link_entities(tx, [local], 'track', track_it, row, row.preview_url ?? null, events);
		});
		expect(linked).toEqual([local]);
		expect((await link_states('track', [local])).get(local)).toEqual({ applemusic_id: String(track_it), linked: true });
		const thumbs = await db.select().from(thumbnails_table).where(eq(thumbnails_table.id, local));
		expect(thumbs.map(t => t.url)).toContain(`https://img.test/t${track_it}/100x100bb.jpg`);
		expect(push).toHaveBeenCalledWith('itunes_track_linked', { track_id: local, itunes_track_id: track_it, preview_url: `https://audio.test/${track_it}.m4a` });
	});

	it('does not claim an entity whose applemusic_id differs, and skips the event without a preview or for albums', async () => {
		const artist = { id: itunes_id(), name: unique('Conflict Artist') };
		const mine = itunes_id();
		const taken = await seed('artist', { name: unique('Taken'), applemusic_id: String(mine) });
		const other = await seed('artist', { name: unique('Other'), applemusic_id: '88800001' });
		const events = new PendingEvents();
		const push = vi.spyOn(events, 'push');
		const linked = await db.transaction(async (tx) => {
			await persist_artist(tx, it_artist(mine, artist.name));
			return link_entities(tx, [taken, other], 'artist', mine, null, null, events);
		});
		expect(linked).toEqual([taken]);
		expect(push).not.toHaveBeenCalledWith('itunes_track_linked', expect.anything());
		const track_it = itunes_id();
		const album_local = await seed('album', { name: unique('Album Link') });
		await db.transaction(async (tx) => {
			const row = await persist_collection(tx, { collection: it_collection(track_it, artist, 'AL') });
			await link_entities(tx, [album_local], 'album', track_it, row, 'https://audio.test/x.m4a', events);
		});
		expect(push).not.toHaveBeenCalledWith('itunes_track_linked', expect.anything());
	});

	it('counts attempts and sets retry_after per status', async () => {
		const id = await seed('artist', { name: unique('Rec') });
		await record_lookup(db, [], 'artist', 'ERROR');
		await record_lookup(db, [id], 'artist', 'ERROR');
		await record_lookup(db, [id], 'artist', 'ERROR');
		let [row] = await db.select().from(itunes_lookups_table).where(eq(itunes_lookups_table.illusi_id, id));
		expect(row).toMatchObject({ status: 'ERROR', attempts: 2, entity_type: 'artist' });
		const first_delay = row.retry_after!.getTime() - row.attempted_at.getTime();
		expect(first_delay).toBe(15 * 2 * 60_000);
		await record_lookup(db, [id], 'artist', 'NOT_FOUND');
		[row] = await db.select().from(itunes_lookups_table).where(eq(itunes_lookups_table.illusi_id, id));
		expect(row).toMatchObject({ status: 'NOT_FOUND', attempts: 3 });
		expect(row.retry_after!.getTime() - row.attempted_at.getTime()).toBe(30 * 86_400_000);
		await record_lookup(db, [id], 'artist', 'FOUND');
		[row] = await db.select().from(itunes_lookups_table).where(eq(itunes_lookups_table.illusi_id, id));
		expect(row).toMatchObject({ status: 'FOUND', attempts: 4, retry_after: null });
	});

	it('ignores ids of entities that no longer exist', async () => {
		const gone = uuid();
		await expect(record_lookup(db, [gone], 'track', 'NOT_FOUND')).resolves.toBeUndefined();
		expect(await db.select().from(itunes_lookups_table).where(inArray(itunes_lookups_table.illusi_id, [gone]))).toHaveLength(0);
	});
});

function fake_client(overrides: Partial<Record<'search_artists' | 'artist_albums' | 'album_tracks' | 'lookup_ids', unknown>> = {}) {
	return {
		search_artists: vi.fn().mockResolvedValue([]),
		artist_albums: vi.fn().mockResolvedValue({ artist: null, albums: [] }),
		album_tracks: vi.fn().mockResolvedValue(new Map()),
		lookup_ids: vi.fn().mockResolvedValue([]),
		...overrides
	} as unknown as ITunesClient & Record<'search_artists' | 'artist_albums' | 'album_tracks' | 'lookup_ids', ReturnType<typeof vi.fn>>;
}

const THRESHOLD = 0.9;

describe('iTunes pipeline: artists', () => {
	it('searches, picks the best match and persists it', async () => {
		const artist = { id: itunes_id(), name: unique('Pipe Artist') };
		const client = fake_client({ search_artists: vi.fn().mockResolvedValue([it_artist(itunes_id(), 'Wrong One Entirely'), it_artist(artist.id, artist.name)]) });
		const found = await resolve_request(client, { type: 'artist', artist_name: `${artist.name} feat. Guest` }, THRESHOLD);
		expect(found?.itunes_id).toBe(artist.id);
		expect(client.search_artists).toHaveBeenCalledWith(artist.name);
		expect(await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, artist.id))).toHaveLength(0);
		const result = await db.transaction(tx => found!.persist(tx));
		expect(result).toEqual({ artwork: null, preview_url: null });
		expect(await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, artist.id))).toHaveLength(1);
	});

	it('reuses a stored exact-name artist without searching', async () => {
		const artist = { id: itunes_id(), name: unique('Stored Pipe Artist') };
		await db.transaction(tx => persist_artist(tx, it_artist(artist.id, artist.name)));
		const client = fake_client();
		const found = await resolve_request(client, { type: 'artist', artist_name: artist.name }, THRESHOLD);
		expect(found?.itunes_id).toBe(artist.id);
		expect(client.search_artists).not.toHaveBeenCalled();
		expect(await found!.persist(db as never)).toEqual({ artwork: null, preview_url: null });
	});

	it('returns null when nothing matches', async () => {
		const client = fake_client({ search_artists: vi.fn().mockResolvedValue([it_artist(itunes_id(), 'Nothing Alike')]) });
		expect(await resolve_request(client, { type: 'artist', artist_name: unique('Nobody') }, THRESHOLD)).toBeNull();
	});
});

describe('iTunes pipeline: albums', () => {
	it('walks artist search then albums and persists artist and album', async () => {
		const artist = { id: itunes_id(), name: unique('Alb Artist') };
		const wanted = itunes_id();
		const client = fake_client({
			search_artists: vi.fn().mockResolvedValue([it_artist(artist.id, artist.name)]),
			artist_albums: vi.fn().mockResolvedValue({ artist: it_artist(artist.id, artist.name), albums: [it_collection(itunes_id(), artist, 'Something Else'), it_collection(wanted, artist, 'Wanted Album')] })
		});
		const found = await resolve_request(client, { type: 'album', artist_name: artist.name, album_name: 'Wanted Album', track_count: 10 }, THRESHOLD);
		expect(found?.itunes_id).toBe(wanted);
		const { artwork } = await db.transaction(tx => found!.persist(tx));
		expect(artwork).toMatchObject({ id: wanted, artist_id: artist.id });
		expect((await stored_collection_row(wanted))?.name).toBe('Wanted Album');
	});

	it('reuses a stored album of a stored artist without hitting iTunes', async () => {
		const artist = { id: itunes_id(), name: unique('Stored Alb Artist') };
		const album_id = itunes_id();
		await db.transaction(tx => persist_collection(tx, { artist: it_artist(artist.id, artist.name), collection: it_collection(album_id, artist, 'Stored Album') }));
		const client = fake_client();
		const found = await resolve_request(client, { type: 'album', artist_name: artist.name, album_name: 'Stored Album' }, THRESHOLD);
		expect(found?.itunes_id).toBe(album_id);
		expect(client.search_artists).not.toHaveBeenCalled();
		const { artwork } = await found!.persist(db as never);
		expect(artwork).toMatchObject({ id: album_id });
	});

	it('falls back to searching when the stored artist has no matching album', async () => {
		const artist = { id: itunes_id(), name: unique('Partial Artist') };
		await db.transaction(tx => persist_artist(tx, it_artist(artist.id, artist.name)));
		const client = fake_client({ search_artists: vi.fn().mockResolvedValue([]) });
		expect(await resolve_request(client, { type: 'album', artist_name: artist.name, album_name: 'Missing' }, THRESHOLD)).toBeNull();
		expect(client.search_artists).toHaveBeenCalled();
	});

	it('returns null when no artist or no album matches', async () => {
		const artist = { id: itunes_id(), name: unique('Empty Alb Artist') };
		const no_artist = fake_client();
		expect(await resolve_request(no_artist, { type: 'album', artist_name: artist.name, album_name: 'X' }, THRESHOLD)).toBeNull();
		const no_album = fake_client({
			search_artists: vi.fn().mockResolvedValue([it_artist(artist.id, artist.name)]),
			artist_albums: vi.fn().mockResolvedValue({ artist: null, albums: [it_collection(itunes_id(), artist, 'Different')] })
		});
		expect(await resolve_request(no_album, { type: 'album', artist_name: artist.name, album_name: 'Wanted' }, THRESHOLD)).toBeNull();
	});

	it('persists with the search-result artist when the albums lookup has no full artist', async () => {
		const artist = { id: itunes_id(), name: unique('Fallback Artist') };
		const album_id = itunes_id();
		const client = fake_client({
			search_artists: vi.fn().mockResolvedValue([it_artist(artist.id, artist.name)]),
			artist_albums: vi.fn().mockResolvedValue({ artist: null, albums: [it_collection(album_id, artist, 'Fallback Album')] })
		});
		const found = await resolve_request(client, { type: 'album', artist_name: artist.name, album_name: 'Fallback Album' }, THRESHOLD);
		await db.transaction(tx => found!.persist(tx));
		expect(await db.select().from(itunes_artists_table).where(eq(itunes_artists_table.id, artist.id))).toHaveLength(1);
	});
});

describe('iTunes pipeline: tracks', () => {
	it('prefers the matching album, then persists track, album and artist', async () => {
		const artist = { id: itunes_id(), name: unique('Trk Artist') };
		const album_id = itunes_id();
		const other_album = itunes_id();
		const track_id = itunes_id();
		const client = fake_client({
			search_artists: vi.fn().mockResolvedValue([it_artist(artist.id, artist.name)]),
			artist_albums: vi.fn().mockResolvedValue({ artist: it_artist(artist.id, artist.name), albums: [it_collection(other_album, artist, 'Other'), it_collection(album_id, artist, 'Home Album')] }),
			album_tracks: vi.fn().mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, {
				collection: it_collection(id, artist, id === album_id ? 'Home Album' : 'Other'),
				tracks: id === album_id ? [it_track(track_id, artist, album_id, 'Target Song')] : []
			}])))
		});
		const found = await resolve_request(client, { type: 'track', artist_name: artist.name, album_name: 'Home Album', track_name: 'Target Song', duration_ms: 200_000 }, THRESHOLD);
		expect(found?.itunes_id).toBe(track_id);
		expect(client.album_tracks).toHaveBeenCalledTimes(1);
		expect(client.album_tracks).toHaveBeenCalledWith([album_id]);
		const { artwork, preview_url } = await db.transaction(tx => found!.persist(tx));
		expect(preview_url).toBe(`https://audio.test/${track_id}.m4a`);
		expect(artwork).toMatchObject({ id: track_id, collection_id: album_id });
		expect((await stored_collection_row(album_id))?.name).toBe('Home Album');
	});

	it('looks through the remaining albums when the named album has no match', async () => {
		const artist = { id: itunes_id(), name: unique('Rest Artist') };
		const album_id = itunes_id();
		const track_id = itunes_id();
		const client = fake_client({
			search_artists: vi.fn().mockResolvedValue([it_artist(artist.id, artist.name)]),
			artist_albums: vi.fn().mockResolvedValue({ artist: null, albums: [it_collection(album_id, artist, 'Some Compilation')] }),
			album_tracks: vi.fn().mockResolvedValue(new Map([[album_id, { collection: null, tracks: [it_track(track_id, artist, album_id, 'Lost Song', { collectionName: 'Some Compilation' })] }]]))
		});
		const found = await resolve_request(client, { type: 'track', artist_name: artist.name, album_name: 'Nonexistent Album', track_name: 'Lost Song' }, THRESHOLD);
		expect(found?.itunes_id).toBe(track_id);
		const { artwork } = await db.transaction(tx => found!.persist(tx));
		expect(artwork?.id).toBe(track_id);
		expect((await stored_collection_row(album_id))?.name).toBe('Some Compilation');
	});

	it('stops after the first conclusive batch', async () => {
		const artist = { id: itunes_id(), name: unique('Batch Artist') };
		const big_a = itunes_id();
		const big_b = itunes_id();
		const track_id = itunes_id();
		const client = fake_client({
			search_artists: vi.fn().mockResolvedValue([it_artist(artist.id, artist.name)]),
			artist_albums: vi.fn().mockResolvedValue({ artist: null, albums: [it_collection(big_a, artist, 'Big A', { trackCount: 150 }), it_collection(big_b, artist, 'Big B', { trackCount: 150 })] }),
			album_tracks: vi.fn().mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, { collection: null, tracks: id === big_a ? [it_track(track_id, artist, big_a, 'Found Early')] : [] }])))
		});
		const found = await resolve_request(client, { type: 'track', artist_name: artist.name, track_name: 'Found Early', duration_ms: 200_000 }, THRESHOLD);
		expect(found?.itunes_id).toBe(track_id);
		expect(client.album_tracks).toHaveBeenCalledTimes(1);
	});

	it('returns null without an artist or without any matching track', async () => {
		const artist = { id: itunes_id(), name: unique('Nope Artist') };
		expect(await resolve_request(fake_client(), { type: 'track', artist_name: artist.name, track_name: 'x' }, THRESHOLD)).toBeNull();
		const client = fake_client({
			search_artists: vi.fn().mockResolvedValue([it_artist(artist.id, artist.name)]),
			artist_albums: vi.fn().mockResolvedValue({ artist: null, albums: [it_collection(itunes_id(), artist, 'A')] }),
			album_tracks: vi.fn().mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, { collection: null, tracks: [it_track(itunes_id(), artist, id, 'Unrelated Title')] }])))
		});
		expect(await resolve_request(client, { type: 'track', artist_name: artist.name, track_name: 'Wanted' }, THRESHOLD)).toBeNull();
	});

	it('reuses a conclusive stored track without searching', async () => {
		const artist = { id: itunes_id(), name: unique('Stored Trk Artist') };
		const track_id = itunes_id();
		await db.transaction(tx => persist_track(tx, { artist: it_artist(artist.id, artist.name), track: it_track(track_id, artist, null, 'Stored Song') }));
		const client = fake_client();
		const found = await resolve_request(client, { type: 'track', artist_name: artist.name, track_name: 'Stored Song', duration_ms: 200_500 }, THRESHOLD);
		expect(found?.itunes_id).toBe(track_id);
		expect(client.search_artists).not.toHaveBeenCalled();
		expect(await found!.persist(db as never)).toMatchObject({ preview_url: `https://audio.test/${track_id}.m4a`, artwork: { id: track_id } });
	});

	it('searches when the stored track is not conclusive (duration differs)', async () => {
		const artist = { id: itunes_id(), name: unique('Dur Artist') };
		await db.transaction(tx => persist_track(tx, { artist: it_artist(artist.id, artist.name), track: it_track(itunes_id(), artist, null, 'Dur Song') }));
		const client = fake_client();
		expect(await resolve_request(client, { type: 'track', artist_name: artist.name, track_name: 'Dur Song', duration_ms: 90_000 }, THRESHOLD)).toBeNull();
		expect(client.search_artists).toHaveBeenCalled();
	});
});

describe('iTunes pipeline: known ids', () => {
	const artist = { id: 1, name: 'A' };
	const results = [it_artist(1, 'A'), it_collection(2, artist, 'C'), it_track(3, artist, 2, 'T')];

	it('picks the result of the right wrapper type and id', () => {
		expect(result_for_id(results, 'artist', '1')).toBe(results[0]);
		expect(result_for_id(results, 'album', '2')).toBe(results[1]);
		expect(result_for_id(results, 'track', '3')).toBe(results[2]);
		expect(result_for_id(results, 'track', '2')).toBeNull();
		expect(result_for_id(results, 'album', '3')).toBeNull();
		expect(result_for_id(results, 'artist', '9')).toBeNull();
		expect(result_for_id([], 'track', '3')).toBeNull();
	});

	it('persists a found track with derived parents', async () => {
		const a = { id: itunes_id(), name: unique('Known Artist') };
		const album_id = itunes_id();
		const track_id = itunes_id();
		const found = found_from_result('track', it_track(track_id, a, album_id, 'Known Song', { collectionName: 'Known Album' }));
		expect(found.itunes_id).toBe(track_id);
		const { artwork, preview_url } = await db.transaction(tx => found.persist(tx));
		expect(artwork?.id).toBe(track_id);
		expect(preview_url).toBe(`https://audio.test/${track_id}.m4a`);
		expect((await stored_collection_row(album_id))?.name).toBe('Known Album');
	});

	it('persists a found album and a found artist', async () => {
		const a = { id: itunes_id(), name: unique('Known Alb Artist') };
		const album_id = itunes_id();
		const album = found_from_result('album', it_collection(album_id, a, 'Known Album 2'));
		expect(album.itunes_id).toBe(album_id);
		expect((await db.transaction(tx => album.persist(tx))).preview_url).toBeNull();
		expect(await stored_collection_row(album_id)).not.toBeNull();
		const solo = { id: itunes_id(), name: unique('Solo') };
		const artist_found = found_from_result('artist', it_artist(solo.id, solo.name));
		expect(artist_found.itunes_id).toBe(solo.id);
		expect(await db.transaction(tx => artist_found.persist(tx))).toEqual({ artwork: null, preview_url: null });
		expect(await db.select().from(itunes_tracks_table).where(eq(itunes_tracks_table.id, solo.id))).toHaveLength(0);
	});
});
