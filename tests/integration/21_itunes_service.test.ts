import { randomInt } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
	search_artists: vi.fn(),
	artist_albums: vi.fn(),
	album_tracks: vi.fn(),
	lookup_ids: vi.fn()
}));
const store_spy = vi.hoisted(() => ({ scan: null as null | ((...args: unknown[]) => unknown), no_backfill: false }));

vi.mock('../../src/services/itunes/client', () => {
	class ITunesDropError extends Error {}
	class ITunesStoppedError extends Error {}
	class ITunesClient {
		start = vi.fn();
		stop = vi.fn();
		search_artists = client.search_artists;
		artist_albums = client.artist_albums;
		album_tracks = client.album_tracks;
		lookup_ids = client.lookup_ids;
	}
	return { ITunesClient, ITunesDropError, ITunesStoppedError };
});
vi.mock('../../src/services/itunes/store', async (original) => {
	const real = await original<typeof import('../../src/services/itunes/store')>();
	return { ...real, scan_candidates: vi.fn(async (...args: Parameters<typeof real.scan_candidates>) => (store_spy.no_backfill && !args[1].ids ? [] : (store_spy.scan ?? real.scan_candidates)(...args))) };
});

import { PendingEvents } from '../../src/core/events';
import { ITunesDropError, ITunesStoppedError } from '../../src/services/itunes/client';
import { ITunesService } from '../../src/services/itunes/service';
import type { Candidate } from '../../src/services/itunes/store';
import { scan_candidates } from '../../src/services/itunes/store';
import { pool, unique, uuid } from './helpers';

const BASE = 9_500_000_000 + randomInt(1_000_000) * 1000;
let next_id = BASE;
const itunes_id = () => next_id++;
const seeded: string[] = [];

async function seed(kind: 'artist' | 'track' | 'album', name: string, opts: { applemusic_id?: string; artist_id?: string; imported?: boolean } = {}) {
	const id = uuid();
	await pool.query('insert into service_ids_table (illusi_id, applemusic_id) values ($1, $2)', [id, opts.applemusic_id ?? null]);
	if (kind === 'artist') await pool.query('insert into artists_table (id, name) values ($1, $2)', [id, name]);
	if (kind === 'album') await pool.query('insert into albums_table (id, artist_id, name) values ($1, $2, $3)', [id, opts.artist_id ?? null, name]);
	if (kind === 'track') {
		await pool.query('insert into tracks_table (id, title, imported) values ($1, $2, $3)', [id, name, opts.imported ?? false]);
		if (opts.artist_id) await pool.query('insert into tracks_artists_table (artist_id, track_id) values ($1, $2)', [opts.artist_id, id]);
	}
	seeded.push(id);
	return id;
}

const lookup_of = async (id: string) => (await pool.query('select status, attempts from itunes_lookups_table where illusi_id = $1', [id])).rows[0];
const applemusic_of = async (id: string) => (await pool.query('select applemusic_id from service_ids_table where illusi_id = $1', [id])).rows[0]?.applemusic_id as string | null;

const artist_result = (id: number, name: string) => ({ wrapperType: 'artist', artistId: id, artistName: name });
const track_result = (id: number, artist: { id: number; name: string }, name: string) => ({
	wrapperType: 'track', kind: 'song', trackId: id, artistId: artist.id, artistName: artist.name, trackName: name, trackCensoredName: name,
	trackTimeMillis: 100_000, previewUrl: `https://audio.test/${id}.m4a`
});

type Internals = {
	process: (batch: unknown[]) => Promise<void>;
	refill_backfill: () => Promise<void>;
	queue: { size: (lane?: string) => number; take: () => { illusi_ids: string[] }[]; has: (id: string) => boolean };
	backfill: { phase: number; after: string | undefined; done: boolean };
	self_filled: Set<string>;
	listen: () => void;
};
const internals = (s: ITunesService) => s as unknown as Internals;

const service = new ITunesService();
const batch_of = (candidates: Candidate[]) => candidates.map(c => ({ ...c, illusi_ids: [c.illusi_id] }));

beforeEach(() => {
	for (const fn of Object.values(client)) fn.mockReset();
	store_spy.scan = null;
	store_spy.no_backfill = false;
	vi.mocked(scan_candidates).mockClear();
	client.search_artists.mockResolvedValue([]);
	client.lookup_ids.mockResolvedValue([]);
	internals(service).queue.take();
	while (internals(service).queue.size() > 0) internals(service).queue.take();
});

afterAll(async () => {
	await service.stop();
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

describe('ITunesService.process: search path', () => {
	it('links a matched artist and records FOUND', async () => {
		const name = unique('Svc Artist');
		const id = await seed('artist', name);
		const it_id = itunes_id();
		client.search_artists.mockResolvedValue([artist_result(it_id, name)]);
		const [candidate] = await scan_candidates('artist', { ids: [id], limit: 1 });
		await internals(service).process(batch_of([candidate]));
		expect(await applemusic_of(id)).toBe(String(it_id));
		expect(await lookup_of(id)).toMatchObject({ status: 'FOUND', attempts: 1 });
		expect((await pool.query('select 1 from itunes_artists_table where id = $1', [it_id])).rowCount).toBe(1);
	});

	it('records NOT_FOUND when nothing matches', async () => {
		const id = await seed('artist', unique('Svc Nobody'));
		const [candidate] = await scan_candidates('artist', { ids: [id], limit: 1 });
		await internals(service).process(batch_of([candidate]));
		expect(await applemusic_of(id)).toBeNull();
		expect(await lookup_of(id)).toMatchObject({ status: 'NOT_FOUND' });
	});

	it('records ERROR for a dropped request and for an unexpected failure', async () => {
		const dropped = await seed('artist', unique('Svc Drop'));
		const crashed = await seed('artist', unique('Svc Crash'));
		client.search_artists.mockRejectedValueOnce(new ITunesDropError('HTTP 400')).mockRejectedValueOnce(new Error('boom'));
		const candidates = await scan_candidates('artist', { ids: [dropped, crashed], limit: 2 });
		await internals(service).process(batch_of(candidates));
		expect(await lookup_of(dropped)).toMatchObject({ status: 'ERROR' });
		expect(await lookup_of(crashed)).toMatchObject({ status: 'ERROR' });
	});

	it('propagates a stop without recording anything', async () => {
		const id = await seed('artist', unique('Svc Stop'));
		client.search_artists.mockRejectedValue(new ITunesStoppedError('stopped'));
		const [candidate] = await scan_candidates('artist', { ids: [id], limit: 1 });
		await expect(internals(service).process(batch_of([candidate]))).rejects.toBeInstanceOf(ITunesStoppedError);
		expect(await lookup_of(id)).toBeUndefined();
	});

	it('skips ids that are already linked or no longer exist, and entries without anything to do', async () => {
		const linked_to = itunes_id();
		await pool.query('insert into itunes_artists_table (id, name) values ($1, $2)', [linked_to, unique('Svc Prelinked')]);
		const linked = await seed('artist', unique('Svc Linked'), { applemusic_id: String(linked_to) });
		const idle = await seed('artist', unique('Svc Idle'));
		const request = null;
		await internals(service).process([
			{ illusi_ids: [linked, uuid()], entity_type: 'artist', applemusic_id: null, request: { type: 'artist', artist_name: 'x' } },
			{ illusi_ids: [idle], entity_type: 'artist', applemusic_id: null, request }
		]);
		expect(client.search_artists).not.toHaveBeenCalled();
		expect(client.lookup_ids).not.toHaveBeenCalled();
		expect(await lookup_of(linked)).toBeUndefined();
		expect(await lookup_of(idle)).toBeUndefined();
	});

	it('links a track and emits itunes_track_linked after commit', async () => {
		const artist = { id: itunes_id(), name: unique('Svc Trk Artist') };
		const local_artist = await seed('artist', artist.name);
		const track = await seed('track', 'Svc Song', { artist_id: local_artist });
		const track_it = itunes_id();
		client.search_artists.mockResolvedValue([artist_result(artist.id, artist.name)]);
		client.artist_albums.mockResolvedValue({ artist: artist_result(artist.id, artist.name), albums: [{ wrapperType: 'collection', collectionId: itunes_id(), collectionName: 'Svc Album', trackCount: 5, artistId: artist.id }] });
		client.album_tracks.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, { collection: null, tracks: [{ ...track_result(track_it, artist, 'Svc Song'), collectionId: id }] }])));
		const { on } = await import('../../src/core/events');
		const linked = vi.fn();
		on('itunes_track_linked', linked);
		const [candidate] = await scan_candidates('track', { ids: [track], limit: 1 });
		await internals(service).process(batch_of([candidate]));
		expect(await applemusic_of(track)).toBe(String(track_it));
		await vi.waitFor(() => expect(linked).toHaveBeenCalledWith(expect.objectContaining({ track_id: track, itunes_track_id: track_it })));
	});
});

describe('ITunesService.process: known ids', () => {
	it('links a known applemusic_id through one id lookup for the batch', async () => {
		const artist = { id: itunes_id(), name: unique('Known Artist') };
		const a = await seed('artist', artist.name, { applemusic_id: String(artist.id) });
		const track_it = itunes_id();
		const t = await seed('track', 'Known Song', { applemusic_id: String(track_it) });
		client.lookup_ids.mockResolvedValue([artist_result(artist.id, artist.name), track_result(track_it, artist, 'Known Song')]);
		const candidates = [...await scan_candidates('artist', { ids: [a], limit: 1 }), ...await scan_candidates('track', { ids: [t], limit: 1 })];
		await internals(service).process(batch_of(candidates));
		expect(client.lookup_ids).toHaveBeenCalledTimes(1);
		expect(client.lookup_ids.mock.calls[0][0].sort()).toEqual([String(artist.id), String(track_it)].sort());
		expect(await lookup_of(a)).toMatchObject({ status: 'FOUND' });
		expect(await lookup_of(t)).toMatchObject({ status: 'FOUND' });
		expect((await pool.query('select preview_url from itunes_tracks_table where id = $1', [track_it])).rows[0].preview_url).toContain('audio.test');
	});

	it('records NOT_FOUND when the lookup does not return the id', async () => {
		const id = await seed('artist', unique('Known Missing'), { applemusic_id: String(itunes_id()) });
		const [candidate] = await scan_candidates('artist', { ids: [id], limit: 1 });
		await internals(service).process(batch_of([candidate]));
		expect(await lookup_of(id)).toMatchObject({ status: 'NOT_FOUND' });
	});

	it('records ERROR for the whole group when the id lookup is dropped', async () => {
		const a = await seed('artist', unique('Known Err A'), { applemusic_id: String(itunes_id()) });
		const t = await seed('track', unique('Known Err T'), { applemusic_id: String(itunes_id()) });
		client.lookup_ids.mockRejectedValue(new ITunesDropError('gave up'));
		const candidates = [...await scan_candidates('artist', { ids: [a], limit: 1 }), ...await scan_candidates('track', { ids: [t], limit: 1 })];
		await internals(service).process(batch_of(candidates));
		expect(await lookup_of(a)).toMatchObject({ status: 'ERROR' });
		expect(await lookup_of(t)).toMatchObject({ status: 'ERROR' });
	});

	it('propagates a stop during the id lookup', async () => {
		const id = await seed('artist', unique('Known Stop'), { applemusic_id: String(itunes_id()) });
		client.lookup_ids.mockRejectedValue(new ITunesStoppedError('stopped'));
		const [candidate] = await scan_candidates('artist', { ids: [id], limit: 1 });
		await expect(internals(service).process(batch_of([candidate]))).rejects.toBeInstanceOf(ITunesStoppedError);
		expect(await lookup_of(id)).toBeUndefined();
	});

	it('records ERROR when committing a found result fails', async () => {
		const artist = { id: itunes_id(), name: unique('Known Bad') };
		const id = await seed('artist', artist.name, { applemusic_id: String(artist.id) });
		// A second artist row already owns the link_url the incoming artist wants, which breaks the insert.
		await pool.query('insert into itunes_artists_table (id, name, link_url) values ($1, $2, $3)', [itunes_id(), 'Squatter', `https://x.test/${artist.id}`]);
		client.lookup_ids.mockResolvedValue([{ ...artist_result(artist.id, artist.name), artistLinkUrl: `https://x.test/${artist.id}` }]);
		const [candidate] = await scan_candidates('artist', { ids: [id], limit: 1 });
		await internals(service).process(batch_of([candidate]));
		expect(await lookup_of(id)).toMatchObject({ status: 'ERROR' });
		expect(await applemusic_of(id)).toBe(String(artist.id));
	});
});

describe('ITunesService: queueing and events', () => {
	it('enqueue_scanned queues only unlinked, due entities and enqueue_if_needed skips queued ids', async () => {
		const a = await seed('artist', unique('Q Artist'));
		const linked_to = itunes_id();
		await pool.query('insert into itunes_artists_table (id, name) values ($1, $2)', [linked_to, unique('Q Linked')]);
		const linked = await seed('artist', unique('Q Linked Local'), { applemusic_id: String(linked_to) });
		await service.enqueue_scanned('artist', [a, linked], 'live');
		expect(internals(service).queue.has(a)).toBe(true);
		expect(internals(service).queue.has(linked)).toBe(false);
		const before = vi.mocked(scan_candidates).mock.calls.length;
		await service.enqueue_if_needed([a, a]);
		expect(vi.mocked(scan_candidates).mock.calls.length).toBe(before);
		await service.enqueue_if_needed([]);
		expect(vi.mocked(scan_candidates).mock.calls.length).toBe(before);
		const q_artist = await seed('artist', unique('Q Track Artist'));
		const t = await seed('track', unique('Q Track'), { artist_id: q_artist });
		await service.enqueue_if_needed([t, a]);
		expect(internals(service).queue.has(t)).toBe(true);
	});

	it('refills the backfill lane page by page across the three entity types', async () => {
		const s = new ITunesService();
		const item = (n: number, type: Candidate['entity_type']): Candidate => ({ illusi_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, entity_type: type, applemusic_id: null, request: type === 'track' ? { type: 'track', artist_name: `a${n}`, track_name: `t${n}` } : type === 'album' ? { type: 'album', artist_name: `a${n}`, album_name: `b${n}` } : { type: 'artist', artist_name: `a${n}` } });
		const full_page = Array.from({ length: 500 }, (_, i) => item(i + 1, 'track'));
		store_spy.scan = vi.fn()
			.mockResolvedValueOnce(full_page.slice(0, 20))
			.mockResolvedValueOnce([item(1000, 'album')])
			.mockResolvedValueOnce([item(2000, 'artist')]);
		internals(s).backfill = { phase: 0, after: undefined, done: false };
		await internals(s).refill_backfill();
		expect(internals(s).backfill.done).toBe(true);
		expect(internals(s).queue.size('backfill')).toBe(22);
		expect(vi.mocked(scan_candidates).mock.calls.map(c => c[0])).toEqual(['track', 'album', 'artist']);
	});

	it('pages with the last id of a full backfill page and stops at the low-water mark', async () => {
		const s = new ITunesService();
		const rows = Array.from({ length: 500 }, (_, i): Candidate => ({ illusi_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, entity_type: 'artist', applemusic_id: null, request: { type: 'artist', artist_name: `n${i}` } }));
		store_spy.scan = vi.fn().mockResolvedValue(rows);
		internals(s).backfill = { phase: 2, after: undefined, done: false };
		await internals(s).refill_backfill();
		expect(internals(s).backfill).toMatchObject({ phase: 2, done: false, after: rows[499].illusi_id });
		expect(internals(s).queue.size('backfill')).toBe(500);
		await internals(s).refill_backfill();
		expect(vi.mocked(scan_candidates)).toHaveBeenCalledTimes(1);
	});

	it('queues new non-imported entities from entity_created and ignores imported ones', async () => {
		const s = new ITunesService();
		internals(s).listen();
		internals(s).listen();
		const fresh = await seed('artist', unique('Ev Artist'));
		const imported = await seed('track', unique('Ev Imported'), { imported: true });
		const events = new PendingEvents();
		events.push('entity_created', { illusi_id: imported, entity_type: 'track', imported: true });
		events.push('entity_created', { illusi_id: fresh, entity_type: 'artist', imported: false });
		events.flush();
		await vi.waitFor(() => expect(internals(s).queue.has(fresh)).toBe(true));
		expect(internals(s).queue.has(imported)).toBe(false);
	});

	it('queues a fast-path lookup for applemusic_id_filled, except for its own, unknown and imported entities', async () => {
		const s = new ITunesService();
		internals(s).listen();
		const external = await seed('artist', unique('Fill Ext'));
		const own = await seed('artist', unique('Fill Own'));
		const imported = await seed('track', unique('Fill Imported'), { imported: true });
		internals(s).self_filled.add(own);
		const events = new PendingEvents();
		events.push('applemusic_id_filled', { illusi_id: own, applemusic_id: '123' });
		events.push('applemusic_id_filled', { illusi_id: imported, applemusic_id: '124' });
		events.push('applemusic_id_filled', { illusi_id: uuid(), applemusic_id: '125' });
		events.push('applemusic_id_filled', { illusi_id: external, applemusic_id: '126' });
		events.flush();
		await vi.waitFor(() => expect(internals(s).queue.has(external)).toBe(true));
		await new Promise(r => setTimeout(r, 50));
		expect(internals(s).queue.has(own)).toBe(false);
		expect(internals(s).queue.has(imported)).toBe(false);
		expect(internals(s).self_filled.has(own)).toBe(false);
	});
});

describe('ITunesService: drain loop', () => {
	it('processes queued work in the background and stops cleanly', async () => {
		const s = new ITunesService();
		const name = unique('Drain Artist');
		const id = await seed('artist', name);
		const it_id = itunes_id();
		client.search_artists.mockResolvedValue([artist_result(it_id, name)]);
		store_spy.no_backfill = true;
		s.start();
		s.start();
		await s.enqueue_scanned('artist', [id], 'live');
		await vi.waitFor(async () => expect(await applemusic_of(id)).toBe(String(it_id)));
		await vi.waitFor(async () => expect(await lookup_of(id)).toMatchObject({ status: 'FOUND' }));
		await s.stop();
		await s.stop();
	});

	it('survives a failing iteration and exits when stopped during the error pause', async () => {
		const s = new ITunesService();
		store_spy.scan = vi.fn().mockRejectedValue(new Error('scan failed'));
		s.start();
		await vi.waitFor(() => expect(store_spy.scan).toHaveBeenCalled());
		await s.stop();
	});

	it('abandons the loop quietly when the client reports a stop', async () => {
		const s = new ITunesService();
		store_spy.scan = vi.fn().mockRejectedValue(new ITunesStoppedError('stopped'));
		s.start();
		await vi.waitFor(() => expect(store_spy.scan).toHaveBeenCalled());
		await s.stop();
	});
});

describe('ITunesService: albums for linked tracks', () => {
	const song = (id: number, artist: { id: number; name: string }, name: string, collection: { id: number; name: string }, duration = 200_000) => ({
		...track_result(id, artist, name), trackTimeMillis: duration, collectionId: collection.id, collectionName: collection.name, trackCount: 1, trackNumber: 1,
		artworkUrl100: `https://img.test/${collection.id}/100x100bb.jpg`
	});
	async function seed_track(title: string, duration_ms: number | null) {
		const artist_name = unique('Album Link Artist');
		const artist_id = await seed('artist', artist_name);
		const track_id = await seed('track', title, { artist_id });
		await pool.query('update tracks_table set duration_ms = $2 where id = $1', [track_id, duration_ms]);
		return { artist_name, artist_id, track_id };
	}
	async function link(track_id: string, result: object) {
		const it_id = (result as { trackId: number }).trackId;
		await pool.query('update service_ids_table set applemusic_id = $2 where illusi_id = $1', [track_id, String(it_id)]);
		client.lookup_ids.mockResolvedValue([result]);
		const [candidate] = await scan_candidates('track', { ids: [track_id], limit: 1 });
		await internals(service).process(batch_of([candidate]));
		const [row] = (await pool.query('select album_id from tracks_table where id = $1', [track_id])).rows;
		if (row.album_id) seeded.push(row.album_id);
		return row.album_id as string | null;
	}

	it('puts a surely matching track on the song\'s album, created from the collection', async () => {
		const title = unique('Heart');
		const { artist_name, artist_id, track_id } = await seed_track(title, 201_000);
		const collection = { id: itunes_id(), name: `${title} - Single` };
		const album_id = await link(track_id, song(itunes_id(), { id: itunes_id(), name: artist_name }, title, collection));
		expect(album_id).not.toBeNull();
		const [album] = (await pool.query('select name, album_type, artist_id from albums_table where id = $1', [album_id])).rows;
		expect(album).toEqual({ name: title, album_type: 'SINGLE', artist_id });
		expect(await applemusic_of(album_id!)).toBe(String(collection.id));
		expect((await pool.query('select track_number from album_tracks_table where album_id = $1 and track_id = $2', [album_id, track_id])).rows).toEqual([{ track_number: 1 }]);
	});

	it('reuses the catalog album already linked to the collection', async () => {
		const title = unique('Shared');
		const { artist_name, artist_id, track_id } = await seed_track(title, 200_000);
		const collection = { id: itunes_id(), name: unique('Shared Album') };
		const existing = await seed('album', collection.name, { artist_id, applemusic_id: String(collection.id) });
		expect(await link(track_id, song(itunes_id(), { id: itunes_id(), name: artist_name }, title, collection))).toBe(existing);
	});

	it('leaves the track alone when the match isn\'t sure or it already has an album', async () => {
		const off = await seed_track(unique('Off'), 230_000);
		const off_title = (await pool.query('select title from tracks_table where id = $1', [off.track_id])).rows[0].title as string;
		expect(await link(off.track_id, song(itunes_id(), { id: itunes_id(), name: off.artist_name }, off_title, { id: itunes_id(), name: 'Far - Single' }))).toBeNull();

		const unknown = await seed_track(unique('Untimed'), null);
		const unknown_title = (await pool.query('select title from tracks_table where id = $1', [unknown.track_id])).rows[0].title as string;
		expect(await link(unknown.track_id, song(itunes_id(), { id: itunes_id(), name: unknown.artist_name }, unknown_title, { id: itunes_id(), name: 'Untimed - Single' }))).toBeNull();

		const has = await seed_track(unique('Has Album'), 200_000);
		const own = await seed('album', unique('Own Album'), { artist_id: has.artist_id });
		await pool.query('update tracks_table set album_id = $2 where id = $1', [has.track_id, own]);
		const has_title = (await pool.query('select title from tracks_table where id = $1', [has.track_id])).rows[0].title as string;
		expect(await link(has.track_id, song(itunes_id(), { id: itunes_id(), name: has.artist_name }, has_title, { id: itunes_id(), name: 'Other - Single' }))).toBe(own);
	});
});
