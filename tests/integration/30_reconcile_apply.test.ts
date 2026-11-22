import { randomInt } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import {
	apply_merge, apply_move, apply_review_plan, apply_split, apply_step, order_steps, raise_review, set_conflict_statuses
} from '../../src/worker/reconcile/apply';
import type { ApplyContext, ReviewPlan } from '../../src/worker/reconcile/apply';
import { load_conflicts, load_nodes, load_vectors } from '../../src/worker/reconcile/load';
import { apply_group, RECONCILE_LOCK_KEY, run_pass, simple_pairs } from '../../src/worker/reconcile/run';
import type { RunReport } from '../../src/worker/reconcile/run';
import { DEFAULT_THRESHOLDS, thresholds_from_config } from '../../src/worker/reconcile/thresholds';
import type { ConflictInfo, GroupPlan, MergeStep, MoveStep, NewEntity, SplitStep } from '../../src/worker/reconcile/types';
import { create_user, pool, query, unique, uuid } from './helpers';

afterAll(async () => { await db.$client.end(); });

const reconcile: ApplyContext = { actor: 'reconcile' };
const admin: ApplyContext = { actor: 'admin', actor_user_id: null, review_item_id: null };
const in_tx = <T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(fn);

const sc_id = () => randomInt(1_000_000_000, 2_000_000_000);
const yt_id = () => unique('y').replace(/-/gu, '_').padEnd(11, 'x').slice(0, 11);
const isrc = () => `QZ${unique('x').slice(-3).toUpperCase().replace(/[^A-Z0-9]/gu, 'A')}${String(randomInt(0, 9_999_999)).padStart(7, '0')}`;

async function service_ids(cols: Record<string, string | number | null> = {}): Promise<string> {
	const id = uuid();
	const names = ['illusi_id', ...Object.keys(cols)];
	await query(`insert into service_ids_table (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`, [id, ...Object.values(cols)]);
	return id;
}

async function track(cols: Record<string, string | number | null> = {}, over: { title?: string; duration_ms?: number } = {}): Promise<string> {
	const id = await service_ids(cols);
	await query(`insert into tracks_table (id, title, duration_ms) values ($1, $2, $3)`, [id, over.title ?? unique('Song'), over.duration_ms ?? 200_000]);
	return id;
}

async function album(cols: Record<string, string | number | null> = {}, name = unique('Album')): Promise<string> {
	const id = await service_ids(cols);
	await query(`insert into albums_table (id, name) values ($1, $2)`, [id, name]);
	return id;
}

async function artist(cols: Record<string, string | number | null> = {}, name = unique('Artist')): Promise<string> {
	const id = await service_ids(cols);
	await query(`insert into artists_table (id, name) values ($1, $2)`, [id, name]);
	return id;
}

const merge_step = (survivor: string, loser: string, over: Partial<MergeStep> = {}): MergeStep => ({ type: 'merge', kind: 'track', survivor, loser, auto: true, reasons: ['test'], confidence: 0.9, ...over });
const new_entity: NewEntity = { kind: 'track', title: 'Split Off', duration_ms: 123_000, explicit: false };
const split_step = (from: string, values: SplitStep['values'], over: Partial<SplitStep> = {}): SplitStep =>
	({ type: 'split', from, values, facet_source: 'soundcloud', new_entity, thumbnails: [], auto: true, reasons: ['test'], ...over });
const move_step = (from: string, to: string, values: MoveStep['values'], over: Partial<MoveStep> = {}): MoveStep =>
	({ type: 'move', from, to, values, facet_source: 'soundcloud', thumbnails: [], auto: true, reasons: ['test'], ...over });

async function conflict(illusi_id: string, column: string, other: string | null = null, status = 'open'): Promise<number> {
	const [row] = await query<{ id: number }>(`insert into service_id_conflicts_table (illusi_id, "column", incoming_value, other_illusi_id, source, status) values ($1, $2, 'x', $3, 'test', $4) returning id`, [illusi_id, column, other, status]);
	return row.id;
}

const conflict_status = async (id: number) => (await query<{ status: string }>(`select status from service_id_conflicts_table where id = $1`, [id]))[0].status;

describe('apply_merge', () => {
	it('repoints references, fills ids, rewrites redirects and conflicts, and records audit and review items', async () => {
		const [u1, u2] = await Promise.all([create_user('merge1'), create_user('merge2')]);
		const sp = unique('sp');
		const yt = yt_id();
		const a = await track({ spotify_id: sp }, { title: 'Keep', duration_ms: 200_000 });
		const b = await track({ youtube_id: yt, isrc: isrc() }, { title: 'Lose', duration_ms: 200_500 });
		const old = await service_ids();
		await query(`insert into illusi_id_redirects_table (old_id, new_id) values ($1, $2)`, [old, b]);
		await query(`insert into user_tracks_table (user_id, track_id) values ($1, $3), ($1, $4), ($2, $4)`, [u1.id, u2.id, a, b]);
		const c = await conflict(b, 'spotify_id', a);

		const res = await in_tx(tx => apply_merge(tx, merge_step(a, b, { reasons: ['transitive'] }), reconcile));
		expect(res.applied).toBe(true);

		expect(await query(`select id from tracks_table where id in ($1, $2)`, [a, b])).toEqual([{ id: a }]);
		expect(await query(`select user_id from user_tracks_table where track_id = $1 order by user_id`, [a])).toHaveLength(2);
		expect(await query(`select 1 from user_tracks_table where track_id = $1`, [b])).toHaveLength(0);
		const [ids] = await query(`select spotify_id, youtube_id from service_ids_table where illusi_id = $1`, [a]);
		expect(ids).toEqual({ spotify_id: sp, youtube_id: yt });
		expect(await query(`select 1 from service_ids_table where illusi_id = $1`, [b])).toHaveLength(0);
		const redirects = await query<{ old_id: string; new_id: string }>(`select old_id, new_id from illusi_id_redirects_table where old_id in ($1, $2)`, [old, b]);
		expect(redirects).toHaveLength(2);
		expect(redirects.every(r => r.new_id === a)).toBe(true);
		expect(await conflict_status(c)).toBe('merged');
		const [audit] = await query(`select action, actor, details, undo from audit_log_table where action = 'merge' and entity_id = $1`, [a]);
		expect(audit.actor).toBe('reconcile');
		expect(audit.details).toMatchObject({ survivor: a, loser: b, kind: 'track' });
		expect(audit.undo.tables.user_tracks_table).toBeDefined();
		// Only implied through other tracks, so a reviewer gets to look.
		const reviews = await query(`select kind from review_items_table where entity_id = $1`, [a]);
		expect(reviews).toEqual([{ kind: 'AUTO_MERGE' }]);
	});

	it('raises no review item for a merge on hard evidence', async () => {
		const a = await track({ isrc: isrc() }, { title: 'Hard', duration_ms: 200_000 });
		const b = await track({ isrc: isrc() }, { title: 'Hard', duration_ms: 200_000 });
		expect((await in_tx(tx => apply_merge(tx, merge_step(a, b, { reasons: ['shared_unique_id'] }), reconcile))).applied).toBe(true);
		expect(await query(`select 1 from review_items_table where entity_id = $1`, [a])).toHaveLength(0);
	});

	it('skips merges that are already done or whose rows are gone', async () => {
		const a = await track();
		const b = await track();
		expect((await in_tx(tx => apply_merge(tx, merge_step(a, b), reconcile))).applied).toBe(true);
		expect(await in_tx(tx => apply_merge(tx, merge_step(a, b), reconcile))).toMatchObject({ applied: false, skipped: 'already_merged' });
		expect(await in_tx(tx => apply_merge(tx, merge_step(a, uuid()), reconcile))).toMatchObject({ applied: false, skipped: 'missing_row' });
	});

	it('refuses to merge different kinds', async () => {
		const t = await track();
		const ar = await artist();
		const res = await in_tx(tx => apply_merge(tx, merge_step(t, ar), reconcile));
		expect(res).toMatchObject({ applied: false, skipped: 'kind_mismatch:track/artist' });
		expect(await query(`select 1 from artists_table where id = $1`, [ar])).toHaveLength(1);
	});

	it('leaves rows with different unique ids to an admin, who may drop them', async () => {
		const a = await track({ spotify_id: unique('spa') });
		const loser_sp = unique('spb');
		const b = await track({ spotify_id: loser_sp });
		expect(await in_tx(tx => apply_merge(tx, merge_step(a, b), reconcile))).toMatchObject({ applied: false, skipped: 'different_ids' });
		expect(await query(`select 1 from tracks_table where id = $1`, [b])).toHaveLength(1);

		expect((await in_tx(tx => apply_merge(tx, merge_step(a, b), admin))).applied).toBe(true);
		const [audit] = await query(`select details, actor from audit_log_table where action = 'merge' and entity_id = $1`, [a]);
		expect(audit.actor).toBe('admin');
		expect(audit.details.dropped).toEqual({ spotify_id: loser_sp });
		expect(await query(`select 1 from review_items_table where kind = 'AUTO_MERGE' and entity_id = $1`, [a])).toHaveLength(0);
	});

	it('merges rows without an entity', async () => {
		const a = await service_ids({ spotify_id: unique('sp') });
		const b = await service_ids({ youtube_id: yt_id() });
		expect((await in_tx(tx => apply_merge(tx, merge_step(a, b, { kind: 'unknown' }), reconcile))).applied).toBe(true);
		const [audit] = await query(`select entity_table from audit_log_table where action = 'merge' and entity_id = $1`, [a]);
		expect(audit.entity_table).toBe('service_ids_table');
	});

	it('merges albums and artists with their relations', async () => {
		const [al_a, al_b] = [await album(), await album()];
		const t = await track();
		await query(`update tracks_table set album_id = $1 where id = $2`, [al_b, t]);
		await query(`insert into album_tracks_table (album_id, track_id, track_number) values ($1, $2, 3)`, [al_b, t]);
		expect((await in_tx(tx => apply_merge(tx, merge_step(al_a, al_b, { kind: 'album' }), reconcile))).applied).toBe(true);
		expect(await query(`select album_id from tracks_table where id = $1`, [t])).toEqual([{ album_id: al_a }]);
		expect(await query(`select album_id, track_number from album_tracks_table where track_id = $1`, [t])).toEqual([{ album_id: al_a, track_number: 3 }]);

		const [ar_a, ar_b] = [await artist(), await artist()];
		await query(`insert into tracks_artists_table (artist_id, track_id) values ($1, $3), ($2, $3)`, [ar_a, ar_b, t]);
		await query(`insert into similar_artists_table (artist_id, similar_artist_id) values ($1, $2)`, [ar_b, ar_a]);
		expect((await in_tx(tx => apply_merge(tx, merge_step(ar_a, ar_b, { kind: 'artist' }), reconcile))).applied).toBe(true);
		expect(await query(`select artist_id from tracks_artists_table where track_id = $1`, [t])).toEqual([{ artist_id: ar_a }]);
		expect(await query(`select 1 from similar_artists_table where artist_id = $1 or similar_artist_id = $1`, [ar_a])).toHaveLength(0);
	});

	it('follows redirects of the planned ids', async () => {
		const a = await track();
		const b = await track();
		const c = await track();
		await in_tx(tx => apply_merge(tx, merge_step(a, b), reconcile));
		// `b` now redirects to `a`, so merging `c` into `b` merges it into `a`.
		expect((await in_tx(tx => apply_merge(tx, merge_step(b, c), reconcile))).applied).toBe(true);
		expect(await query(`select id from tracks_table where id in ($1, $2, $3)`, [a, b, c])).toEqual([{ id: a }]);
	});
});

describe('apply_split', () => {
	it('moves an id and its service data onto a new entity', async () => {
		const sc = sc_id();
		const sp = unique('sp');
		const t = await track({ spotify_id: sp, soundcloud_id: sc });
		const [artist, al] = [await service_ids(), await album()];
		await query(`insert into artists_table (id, name) values ($1, 'Performer')`, [artist]);
		await query(`insert into tracks_artists_table (artist_id, track_id) values ($1, $2)`, [artist, t]);
		await query(`insert into album_tracks_table (album_id, track_id, track_number) values ($1, $2, 4)`, [al, t]);
		await query(`update tracks_table set album_id = $1 where id = $2`, [al, t]);
		await query(`insert into track_lyrics_table (track_id, service, sync_type, format, raw_content, content_hash) values ($1, 'LRCLIB', 'NONE', 'PLAIN', 'words', $2), ($1, 'LRCLIB', 'LINE', 'LRC', '[00:01.00]words', $3)`, [t, unique('h'), unique('h')]);
		const c = await conflict(t, 'soundcloud_id');
		const res = await in_tx(tx => apply_split(tx, split_step(t, { soundcloud_id: String(sc) }), reconcile));
		expect(res.applied).toBe(true);
		const new_id = res.new_id!;
		expect(await query(`select spotify_id, soundcloud_id from service_ids_table where illusi_id = $1`, [t])).toEqual([{ spotify_id: sp, soundcloud_id: null }]);
		expect(await query(`select soundcloud_id from service_ids_table where illusi_id = $1`, [new_id])).toEqual([{ soundcloud_id: String(sc) }]);
		expect(await query(`select title, duration_ms, explicit, album_id from tracks_table where id = $1`, [new_id])).toEqual([{ title: 'Split Off', duration_ms: '123000', explicit: false, album_id: null }]);
		// Another recording of the same song: same performers and albums, the unsynced lyrics but not the synced ones.
		expect(await query(`select artist_id from tracks_artists_table where track_id = $1`, [new_id])).toEqual([{ artist_id: artist }]);
		expect(await query(`select album_id, track_number from album_tracks_table where track_id = $1`, [new_id])).toEqual([{ album_id: al, track_number: null }]);
		expect(await query(`select sync_type from track_lyrics_table where track_id = $1`, [new_id])).toEqual([{ sync_type: 'NONE' }]);
		expect(await query(`select count(*)::int as n from track_lyrics_table where track_id = $1`, [t])).toEqual([{ n: 2 }]);
		expect(await conflict_status(c)).toBe('split');
		expect(await query(`select action from audit_log_table where entity_id = $1`, [t])).toEqual([{ action: 'split' }]);
		expect(await query(`select kind from review_items_table where entity_id = $1`, [t])).toEqual([{ kind: 'AUTO_SPLIT' }]);
	});

	it('moves Genius lyrics, lookups and producers, and thumbnails along with a split', async () => {
		const genius = sc_id();
		const producer = sc_id();
		const t = await track({ genius_id: genius });
		await query(`insert into genius_artists_table (id, name) values ($1, 'Producer')`, [producer]);
		await query(`insert into track_lyrics_table (track_id, service, sync_type, format, raw_content, content_hash) values ($1, 'GENIUS', 'NONE', 'PLAIN', 'la', $2), ($1, 'KUGOU', 'NONE', 'PLAIN', 'la', $3)`, [t, unique('h'), unique('h')]);
		await query(`insert into track_lyrics_lookups_table (track_id, service, status) values ($1, 'GENIUS', 'FOUND')`, [t]);
		await query(`insert into tracks_producers_table (producer_id, track_id) values ($1, $2)`, [producer, t]);
		const url = `https://img.example.test/${unique('thumb')}.jpg`;
		await query(`insert into thumbnails_table (id, url) values ($1, $2)`, [t, url]);

		const res = await in_tx(tx => apply_split(tx, split_step(t, { genius_id: String(genius) }, { facet_source: 'genius', thumbnails: [url] }), reconcile));
		const n = res.new_id!;
		// Genius's own lyrics move; the other plain lyrics stay and are shared with the new recording.
		expect(await query(`select service from track_lyrics_table where track_id = $1 order by service`, [n])).toEqual([{ service: 'GENIUS' }, { service: 'KUGOU' }]);
		expect(await query(`select service from track_lyrics_table where track_id = $1`, [t])).toEqual([{ service: 'KUGOU' }]);
		expect(await query(`select 1 from track_lyrics_lookups_table where track_id = $1 and service = 'GENIUS'`, [n])).toHaveLength(1);
		expect(await query(`select 1 from track_lyrics_lookups_table where track_id = $1`, [t])).toHaveLength(0);
		expect(await query(`select producer_id from tracks_producers_table where track_id = $1`, [n])).toEqual([{ producer_id: String(producer) }]);
		expect(await query(`select 1 from tracks_producers_table where track_id = $1`, [t])).toHaveLength(0);
		expect(await query(`select id from thumbnails_table where url = $1`, [url])).toEqual([{ id: n }]);
		const [audit] = await query(`select undo from audit_log_table where action = 'split' and entity_id = $1`, [t]);
		expect(audit.undo.moved).toMatchObject({ lyrics: 1, lyrics_lookup: true, producers: 1, thumbnails: [url] });
	});

	it('moves the iTunes preview analysis and clears the lookup', async () => {
		const am = String(sc_id());
		const t = await track({ applemusic_id: am });
		const sample = `insert into track_sample_data_table (id, mood, tempo, brightness, key, acousticness, instrumentalness, liveness, danceability, arousal, valence, speechiness) values ($1, 'calm', 100, 1, 'C', 0, 0, 0, 0, 0, 0, 0)`;
		await query(sample, [t]);
		await query(`insert into track_sample_lookups_table (track_id, source, status) values ($1, 'itunes_preview', 'DONE')`, [t]);
		await query(`insert into track_vectors_table (track_id, embedding, version) values ($1, $2::vector, 1)`, [t, `[${Array.from({ length: 40 }, () => 0.1).join(',')}]`]);
		await query(`insert into itunes_lookups_table (illusi_id, entity_type, status) values ($1, 'track', 'FOUND')`, [t]);

		const res = await in_tx(tx => apply_split(tx, split_step(t, { applemusic_id: am }, { facet_source: 'itunes' }), reconcile));
		const n = res.new_id!;
		expect(await query(`select 1 from track_sample_data_table where id = $1`, [n])).toHaveLength(1);
		expect(await query(`select 1 from track_sample_data_table where id = $1`, [t])).toHaveLength(0);
		expect(await query(`select 1 from track_vectors_table where track_id = $1`, [n])).toHaveLength(1);
		expect(await query(`select 1 from track_sample_lookups_table where track_id = $1 and source = 'itunes_preview'`, [n])).toHaveLength(1);
		expect(await query(`select 1 from itunes_lookups_table where illusi_id = $1`, [t])).toHaveLength(0);
		const [audit] = await query(`select undo from audit_log_table where action = 'split' and entity_id = $1`, [t]);
		expect(audit.undo.moved).toMatchObject({ sample: true, itunes_lookup_cleared: true });
	});

	it('keeps the analysis of the track\'s own media when splitting an iTunes id', async () => {
		const am = String(sc_id());
		const t = await track({ applemusic_id: am });
		await query(`insert into track_sample_data_table (id, mood, tempo, brightness, key, acousticness, instrumentalness, liveness, danceability, arousal, valence, speechiness) values ($1, 'calm', 100, 1, 'C', 0, 0, 0, 0, 0, 0, 0)`, [t]);
		await query(`insert into track_sample_lookups_table (track_id, source, status) values ($1, 'itunes_preview', 'DONE'), ($1, 'media', 'DONE')`, [t]);
		const res = await in_tx(tx => apply_split(tx, split_step(t, { applemusic_id: am }, { facet_source: 'itunes' }), reconcile));
		expect(await query(`select 1 from track_sample_data_table where id = $1`, [t])).toHaveLength(1);
		expect(await query(`select 1 from track_sample_data_table where id = $1`, [res.new_id])).toHaveLength(0);
		expect(await query(`select 1 from track_sample_lookups_table where track_id = $1 and source = 'media'`, [t])).toHaveLength(1);
	});

	it('splits albums and artists with a named entity', async () => {
		const am = String(sc_id());
		const al = await album({ applemusic_id: am });
		const res = await in_tx(tx => apply_split(tx, split_step(al, { applemusic_id: am }, { facet_source: 'itunes', new_entity: { ...new_entity, kind: 'album', title: 'Other Album' } }), admin));
		expect(await query(`select name from albums_table where id = $1`, [res.new_id])).toEqual([{ name: 'Other Album' }]);
		expect(await query(`select 1 from review_items_table where entity_id = $1`, [al])).toHaveLength(0);

		const gid = sc_id();
		const ar = await artist({ genius_id: gid });
		const res2 = await in_tx(tx => apply_split(tx, split_step(ar, { genius_id: String(gid) }, { facet_source: 'genius', new_entity: { ...new_entity, kind: 'artist', title: 'Other Artist' } }), reconcile));
		expect(await query(`select name from artists_table where id = $1`, [res2.new_id])).toEqual([{ name: 'Other Artist' }]);
	});

	it('skips when the row is gone, the id changed, or there is no entity', async () => {
		expect(await in_tx(tx => apply_split(tx, split_step(uuid(), { soundcloud_id: '1' }), reconcile))).toMatchObject({ skipped: 'missing_row' });
		const t = await track({ soundcloud_id: sc_id() });
		expect(await in_tx(tx => apply_split(tx, split_step(t, { soundcloud_id: '1' }), reconcile))).toMatchObject({ applied: false, skipped: 'ids_changed' });
		const bare = await service_ids({ youtube_id: yt_id() });
		const [{ youtube_id }] = await query(`select youtube_id from service_ids_table where illusi_id = $1`, [bare]);
		expect(await in_tx(tx => apply_split(tx, split_step(bare, { youtube_id }), reconcile))).toMatchObject({ applied: false, skipped: 'no_entity' });
	});
});

describe('apply_move', () => {
	it('moves ids to the matching entity, de-duplicating lyrics, and settles conflicts', async () => {
		const gid = sc_id();
		const from = await track({ genius_id: gid });
		const to = await track();
		const hash = unique('h');
		await query(`insert into track_lyrics_table (track_id, service, sync_type, format, raw_content, content_hash) values ($1, 'GENIUS', 'NONE', 'PLAIN', 'a', $3), ($1, 'GENIUS', 'NONE', 'PLAIN', 'b', $4), ($2, 'GENIUS', 'NONE', 'PLAIN', 'a', $3)`, [from, to, hash, unique('h')]);
		await query(`insert into track_lyrics_lookups_table (track_id, service, status) values ($1, 'GENIUS', 'FOUND'), ($2, 'GENIUS', 'NOT_FOUND')`, [from, to]);
		const c = await conflict(from, 'genius_id');
		const res = await in_tx(tx => apply_move(tx, move_step(from, to, { genius_id: String(gid) }, { facet_source: 'genius' }), reconcile));
		expect(res.applied).toBe(true);
		expect(await query(`select genius_id from service_ids_table where illusi_id = $1`, [to])).toEqual([{ genius_id: String(gid) }]);
		expect(await query(`select genius_id from service_ids_table where illusi_id = $1`, [from])).toEqual([{ genius_id: null }]);
		expect(await query(`select 1 from track_lyrics_table where track_id = $1`, [to])).toHaveLength(2);
		expect(await query(`select 1 from track_lyrics_table where track_id = $1`, [from])).toHaveLength(0);
		expect(await query(`select status from track_lyrics_lookups_table where track_id = $1`, [to])).toEqual([{ status: 'NOT_FOUND' }]);
		expect(await conflict_status(c)).toBe('split');
		expect(await query(`select action from audit_log_table where entity_id = $1`, [from])).toEqual([{ action: 'id_move' }]);
		expect(await query(`select kind from review_items_table where entity_id = $1`, [from])).toEqual([{ kind: 'AUTO_SPLIT' }]);
	});

	it('does not move an iTunes preview analysis onto a track that has one', async () => {
		const am = String(sc_id());
		const from = await track({ applemusic_id: am });
		const to = await track();
		const sample = `insert into track_sample_data_table (id, mood, tempo, brightness, key, acousticness, instrumentalness, liveness, danceability, arousal, valence, speechiness) values ($1, 'calm', 100, 1, 'C', 0, 0, 0, 0, 0, 0, 0)`;
		await query(sample, [from]);
		await query(sample, [to]);
		await query(`insert into track_sample_lookups_table (track_id, source, status) values ($1, 'itunes_preview', 'DONE')`, [from]);
		const res = await in_tx(tx => apply_move(tx, move_step(from, to, { applemusic_id: am }, { facet_source: 'itunes' }), admin));
		expect(res.applied).toBe(true);
		expect(await query(`select 1 from track_sample_data_table where id = $1`, [from])).toHaveLength(1);
		expect(await query(`select 1 from track_sample_lookups_table where track_id = $1 and source = 'itunes_preview'`, [to])).toHaveLength(1);
	});

	it('moves album ids without touching track-only service data', async () => {
		const am = String(sc_id());
		const from = await album({ applemusic_id: am });
		const to = await album();
		expect((await in_tx(tx => apply_move(tx, move_step(from, to, { applemusic_id: am }, { facet_source: 'itunes' }), reconcile))).applied).toBe(true);
		expect(await query(`select applemusic_id from service_ids_table where illusi_id = $1`, [to])).toEqual([{ applemusic_id: am }]);
	});

	it('skips when merged, missing, already filled, or of different kinds', async () => {
		const sc = sc_id();
		const a = await track({ soundcloud_id: sc });
		const b = await track({ soundcloud_id: sc_id() });
		const ar = await artist();
		const values = { soundcloud_id: String(sc) };
		expect(await in_tx(tx => apply_move(tx, move_step(a, uuid(), values), reconcile))).toMatchObject({ skipped: 'missing_row' });
		expect(await in_tx(tx => apply_move(tx, move_step(a, b, values), reconcile))).toMatchObject({ skipped: 'ids_changed' });
		expect(await in_tx(tx => apply_move(tx, move_step(a, ar, values), reconcile))).toMatchObject({ skipped: 'kind_mismatch' });
		const bare = await service_ids();
		const bare2 = await service_ids();
		const bare_sc = sc_id();
		await query(`update service_ids_table set soundcloud_id = $2 where illusi_id = $1`, [bare, bare_sc]);
		expect(await in_tx(tx => apply_move(tx, move_step(bare, bare2, { soundcloud_id: String(bare_sc) }), reconcile))).toMatchObject({ skipped: 'kind_mismatch' });
		const c = await track();
		await in_tx(tx => apply_merge(tx, merge_step(a, c), reconcile));
		expect(await in_tx(tx => apply_move(tx, move_step(a, c, values), reconcile))).toMatchObject({ skipped: 'already_merged' });
	});
});

describe('apply plumbing', () => {
	it('dispatches steps and puts merges last', async () => {
		const sc = sc_id();
		const t = await track({ soundcloud_id: sc });
		const res = await in_tx(tx => apply_step(tx, split_step(t, { soundcloud_id: String(sc) }), reconcile));
		expect(res.applied).toBe(true);
		const [a, b] = [await track(), await track()];
		expect((await in_tx(tx => apply_step(tx, merge_step(a, b), reconcile))).applied).toBe(true);
		const [c, d] = [await track(), await track({ soundcloud_id: sc_id() })];
		expect(await in_tx(tx => apply_step(tx, move_step(d, c, {}), reconcile))).toMatchObject({ applied: false, skipped: 'ids_changed' });
		const m = merge_step('a', 'b');
		const s = split_step('a', {});
		const mv = move_step('a', 'b', {});
		expect(order_steps([m, s, mv]).map(x => x.type)).toEqual(['split', 'move', 'merge']);
	});

	it('sets conflict statuses only for open or deferred conflicts', async () => {
		const t = await track();
		const [open, deferred, merged] = [await conflict(t, 'isrc'), await conflict(t, 'isrc', null, 'deferred'), await conflict(t, 'isrc', null, 'merged')];
		await in_tx(tx => set_conflict_statuses(tx, [{ id: open, status: 'dismissed' }, { id: deferred, status: 'split' }, { id: merged, status: 'dismissed' }]));
		expect([await conflict_status(open), await conflict_status(deferred), await conflict_status(merged)]).toEqual(['dismissed', 'split', 'merged']);
		await in_tx(tx => set_conflict_statuses(tx, []));
	});

	it('raises one review item per plan signature and ignores automatic-only plans', async () => {
		const a = await track();
		const b = await track();
		const plan: GroupPlan = {
			key: a, kind: 'track', node_ids: [a, b], steps: [merge_step(a, b, { auto: false })], evidence: [{ a, b, signals: [], contradictions: [], confidence: 0.6, hard: null }],
			disagreements: [], conflicts: [{ id: await conflict(a, 'isrc', b, 'deferred'), status: 'deferred' }]
		};
		const id = await in_tx(tx => raise_review(tx, plan));
		expect(id).toEqual(expect.any(Number));
		const [item] = await query(`select kind, entity_table, entity_id, proposed_values from review_items_table where id = $1`, [id]);
		expect(item).toMatchObject({ kind: 'SERVICE_ID_CONFLICT', entity_table: 'tracks_table', entity_id: a });
		expect(item.proposed_values[0].plan).toMatchObject({ group_key: a, conflict_ids: plan.conflicts.map(c => c.id) });
		expect(await in_tx(tx => raise_review(tx, plan))).toBeNull();
		expect(await in_tx(tx => raise_review(tx, { ...plan, steps: [merge_step(a, b)] }))).toBeNull();

		const sc = sc_id();
		const t = await track({ soundcloud_id: sc });
		const t2 = await track();
		const mixed: GroupPlan = { ...plan, key: t, node_ids: [t, t2], steps: [split_step(t, { soundcloud_id: String(sc) }, { auto: false }), move_step(t, t2, { soundcloud_id: String(sc) }, { auto: false })], conflicts: [] };
		expect(await in_tx(tx => raise_review(tx, mixed))).toEqual(expect.any(Number));
		const unknown_plan: GroupPlan = { ...plan, kind: 'unknown', node_ids: [t], steps: [split_step(t, { isrc: 'x' }, { auto: false })], conflicts: [] };
		const [row] = [await in_tx(tx => raise_review(tx, unknown_plan))];
		expect(row).toEqual(expect.any(Number));
		expect(await query(`select entity_table from review_items_table where id = $1`, [row])).toEqual([{ entity_table: 'service_ids_table' }]);
	});

	it('applies an approved review plan and settles each conflict by what happened', async () => {
		const [a, b] = [await track(), await track()];
		const sc = sc_id();
		const t = await track({ soundcloud_id: sc });
		const c_merged = await conflict(b, 'spotify_id', a, 'deferred');
		const c_merged_solo = await conflict(b, 'isrc', null, 'deferred');
		const c_split = await conflict(t, 'soundcloud_id', null, 'deferred');
		const c_dismissed = await conflict(t, 'isrc', null, 'deferred');
		const plan: ReviewPlan = {
			group_key: a, kind: 'track', node_ids: [a, b, t],
			steps: [merge_step(a, b, { auto: false }), split_step(t, { soundcloud_id: String(sc) }, { auto: false })],
			conflict_ids: [c_merged, c_merged_solo, c_split, c_dismissed]
		};
		const results = await in_tx(tx => apply_review_plan(tx, plan, admin));
		expect(results.map(r => r.applied)).toEqual([true, true]);
		expect(await conflict_status(c_merged)).toBe('merged');
		expect(await conflict_status(c_merged_solo)).toBe('merged');
		expect(await conflict_status(c_split)).toBe('split');
		expect(await conflict_status(c_dismissed)).toBe('dismissed');

		const empty = await in_tx(tx => apply_review_plan(tx, { ...plan, steps: [], conflict_ids: [] }, admin));
		expect(empty).toEqual([]);
	});
});

describe('load_nodes', () => {
	it('returns nothing for no ids', async () => {
		expect(await load_nodes(db, [])).toEqual([]);
		expect(await load_nodes(db, [uuid()])).toEqual([]);
	});

	it('assembles entity and service facets, user data and vectors', async () => {
		const user = await create_user('load');
		const am = sc_id();
		const am_artist = sc_id();
		const am_album = sc_id();
		const sc = sc_id();
		const genius = sc_id();
		const genius_artist = sc_id();
		const permalink = `${unique('uploader')}/${unique('song')}`;
		await query(`insert into itunes_artists_table (id, name) values ($1, 'iTunes Artist'), ($2, 'iTunes Artist 2')`, [am_artist, am_artist + 1]);
		await query(`insert into itunes_collections_table (id, name, artist_id, release_date, explicitness) values ($1, 'iTunes Album', $2, '2019-05-05', 'explicit')`, [am_album, am_artist]);
		await query(`insert into itunes_tracks_table (id, name, artist_id, collection_id, track_time_millis, explicitness, track_number, release_date, artwork_url_30) values ($1, 'iTunes Song', $2, $3, 201000, 'notExplicit', 4, '2019-05-05', 'https://img.example.test/30.jpg')`, [am, am_artist, am_album]);
		const sc_user = sc_id();
		await query(`insert into soundcloud_users_table (id, permalink, username) values ($1, $2, 'Uploader')`, [sc_user, permalink.split('/')[0]]);
		await query(`insert into soundcloud_tracks_table (id, title, permalink, user_id, duration, isrc, release_date, artwork_url) values ($1, 'SC Song', $2, $3, 199000, 'us-abc-12-34567', '2018-01-01', 'https://img.example.test/sc.jpg')`, [sc, permalink.split('/')[1], sc_user]);
		await query(`insert into genius_songs_table (id, title, primary_artist_names, apple_music_id, spotify_uuid, youtube_url, soundcloud_url, release_date, song_art_image_url) values ($1, 'Genius Song', 'G Artist', $2, $3, $4, $5, '2017-02-02', 'https://img.example.test/g.jpg')`, [genius, String(am), '4uLU6hMCjMI75M1A2tKUQC', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', `https://soundcloud.com/${permalink}`]);
		await query(`insert into genius_artists_table (id, name, image_url) values ($1, 'G Artist', 'https://img.example.test/ga.jpg')`, [genius_artist]);

		const t = await track({ applemusic_id: String(am), soundcloud_id: sc, soundcloud_permalink: permalink, genius_id: genius });
		const al = await album({ applemusic_id: String(am_album) }, 'Local Album');
		const ar = await artist({ applemusic_id: String(am_artist), genius_id: genius_artist }, 'Local Artist');
		const bare = await service_ids({ youtube_id: yt_id() });
		await query(`update tracks_table set album_id = $2 where id = $1`, [t, al]);
		await query(`update albums_table set artist_id = $2, release_date = '2019-05-05' where id = $1`, [al, ar]);
		await query(`insert into tracks_artists_table (artist_id, track_id) values ($1, $2)`, [ar, t]);
		await query(`insert into album_tracks_table (album_id, track_id, track_number) values ($1, $2, 4)`, [al, t]);
		await query(`insert into user_tracks_table (user_id, track_id) values ($1, $2)`, [user.id, t]);
		await query(`insert into track_plays_table (user_id, track_id, client_id, created_at) values ($1, $2, $3, now())`, [user.id, t, uuid()]);
		await query(`insert into track_vectors_table (track_id, embedding, version) values ($1, $2::vector, 1)`, [t, `[${Array.from({ length: 40 }, (_, i) => i / 100).join(',')}]`]);

		const nodes = new Map((await load_nodes(db, [t, al, ar, bare, t])).map(n => [n.illusi_id, n]));
		expect(nodes.size).toBe(4);
		const tn = nodes.get(t)!;
		expect(tn).toMatchObject({ kind: 'track', has_entity: true, user_data: 2 });
		expect(tn.meta).toMatchObject({ artist: 'Local Artist', album: 'Local Album', track_number: 4, release_year: 2019 });
		expect(tn.ids.soundcloud_id).toBe(String(sc));
		const by_source = Object.fromEntries(tn.facets.map(f => [f.source, f]));
		expect(by_source.itunes).toMatchObject({ title: 'iTunes Song', artist: 'iTunes Artist', album: 'iTunes Album', duration_ms: 201_000, explicit: false, track_number: 4, release_year: 2019, thumbnails: ['https://img.example.test/30.jpg'] });
		expect(by_source.soundcloud).toMatchObject({ title: 'SC Song', artist: 'Uploader', isrc: 'USABC1234567', duration_ms: 199_000, columns: ['soundcloud_id', 'soundcloud_permalink'] });
		expect(by_source.genius).toMatchObject({ title: 'Genius Song', artist: 'G Artist', release_year: 2017 });
		expect(by_source.genius.reported).toMatchObject({ applemusic_id: String(am), youtube_id: 'dQw4w9WgXcQ', soundcloud_permalink: permalink });
		expect(nodes.get(al)).toMatchObject({ kind: 'album', meta: { title: 'Local Album', artist: 'Local Artist', release_year: 2019 } });
		expect(nodes.get(al)!.facets[0]).toMatchObject({ source: 'itunes', title: 'iTunes Album', explicit: true });
		expect(nodes.get(ar)!.facets.map(f => f.source).sort()).toEqual(['genius', 'itunes']);
		expect(nodes.get(bare)).toMatchObject({ kind: 'unknown', has_entity: false, facets: [] });

		const everything = await load_nodes(db, null);
		expect(everything.some(n => n.illusi_id === t)).toBe(true);
		const vectors = await load_vectors(db, [t, uuid()]);
		expect([...vectors.keys()]).toEqual([t]);
		expect(vectors.get(t)).toHaveLength(40);
		expect(await load_vectors(db, [])).toEqual(new Map());
	});

	it('does not claim a SoundCloud permalink the track row does not confirm', async () => {
		const sc = sc_id();
		const sc_user = sc_id();
		const up = unique('up');
		await query(`insert into soundcloud_users_table (id, permalink, username) values ($1, $2, 'U')`, [sc_user, up]);
		await query(`insert into soundcloud_tracks_table (id, title, permalink, user_id) values ($1, 'Song', 'song', $2)`, [sc, sc_user]);
		const t = await track({ soundcloud_id: sc });
		const [node] = await load_nodes(db, [t]);
		expect(node.facets[0]).toMatchObject({ columns: ['soundcloud_id'], reported: { soundcloud_permalink: `${up}/song` } });
	});

	it('loads conflicts oldest first, filtered by status', async () => {
		const t = await track();
		const [o, d, m] = [await conflict(t, 'isrc'), await conflict(t, 'isrc', null, 'deferred'), await conflict(t, 'isrc', null, 'merged')];
		const open = (await load_conflicts(db, ['open'])).map(c => c.id);
		expect(open).toContain(o);
		expect(open).not.toContain(d);
		const both = (await load_conflicts(db, ['open', 'deferred'])).map(c => c.id);
		expect(both).toEqual(expect.arrayContaining([o, d]));
		expect(both).not.toContain(m);
		expect(both).toEqual([...both].sort((x, y) => x - y));
	});
});

const empty_report = (): RunReport => ({
	mode: 'full', dry_run: false, locked: false, groups: 0, groups_with_work: 0, skipped_groups: 0, failed_groups: 0, merges: 0, splits: 0, moves: 0,
	steps_skipped_at_apply: 0, reviews_raised: 0, conflicts: {}
});

const thresholds = DEFAULT_THRESHOLDS;
const conflict_info = (illusi_id: string, other: string | null, status: ConflictInfo['status'] = 'open', id = 1): ConflictInfo =>
	({ id, illusi_id, column: 'isrc', existing_value: null, incoming_value: 'x', other_illusi_id: other, source: 'test', status });

describe('reconcile run', () => {
	it('reads thresholds from the config', () => {
		expect(thresholds_from_config()).toMatchObject({ weights: DEFAULT_THRESHOLDS.weights, name_match: DEFAULT_THRESHOLDS.name_match });
	});

	it('finds simple conflict pairs only', () => {
		expect(simple_pairs([], [])).toEqual([]);
		const [a, b, c] = ['a', 'b', 'c'];
		const ab = conflict_info(a, b);
		expect(simple_pairs([ab], [ab])).toEqual([[a, b]]);
		expect(simple_pairs([ab, conflict_info(b, a)], [ab, conflict_info(b, a)])).toEqual([[a, b]]);
		expect(simple_pairs([ab], [ab, conflict_info(b, c)])).toEqual([]);
		expect(simple_pairs([conflict_info(a, null), conflict_info(a, a)], [conflict_info(a, null), conflict_info(a, a)])).toEqual([]);
	});

	it('applies a group in one transaction and counts what happened', async () => {
		const [a, b] = [await track(), await track()];
		const c = await conflict(b, 'isrc', a);
		const plan: GroupPlan = { key: a, kind: 'track', node_ids: [a, b], steps: [merge_step(a, b), merge_step(a, uuid(), { auto: false })], evidence: [], disagreements: [], conflicts: [{ id: c, status: 'merged' }] };
		const report = empty_report();
		await apply_group(plan, report, { review: true });
		expect(report).toMatchObject({ merges: 1, reviews_raised: 1, conflicts: { merged: 1 } });

		const [x, y] = [await track(), await track()];
		const cx = await conflict(y, 'isrc');
		const skipped = empty_report();
		await apply_group({ ...plan, key: x, node_ids: [x, y], steps: [merge_step(x, y), merge_step(x, uuid())], conflicts: [{ id: cx, status: 'dismissed' }] }, skipped, { review: false });
		expect(skipped).toMatchObject({ merges: 1, steps_skipped_at_apply: 1, conflicts: {}, reviews_raised: 0 });
		expect(await conflict_status(cx)).toBe('open');
	});

	it('skips the pass when another worker holds the lock', async () => {
		const client = await pool.connect();
		try {
			await client.query('select pg_advisory_lock($1)', [RECONCILE_LOCK_KEY]);
			const report = await run_pass({ mode: 'incremental', dry_run: true, thresholds });
			expect(report.locked).toBe(false);
			expect(report.groups).toBe(0);
		} finally {
			await client.query('select pg_advisory_unlock($1)', [RECONCILE_LOCK_KEY]);
			client.release();
		}
	});

	async function pass(mode: 'full' | 'incremental', dry_run: boolean): Promise<RunReport> {
		for (let i = 0; i < 40; i++) {
			const report = await run_pass({ mode, dry_run, thresholds });
			if (report.locked) return report;
			await new Promise(r => setTimeout(r, 500));
		}
		throw new Error('reconcile lock never freed');
	}

	it('merges a clear-cut conflicting pair in an incremental pass and dismisses an unrelated one', async () => {
		const code = isrc();
		const title = unique('Incremental Song');
		const a = await track({ isrc: code, spotify_id: unique('sp') }, { title });
		const b = await track({ isrc: code }, { title, duration_ms: 200_800 });
		const c = await conflict(b, 'spotify_id', a);

		const x = await track({}, { title: unique('Totally Different One'), duration_ms: 100_000 });
		const y = await track({}, { title: unique('Utterly Unlike Two'), duration_ms: 300_000 });
		const cx = await conflict(x, 'isrc', y);

		const dry = await pass('incremental', true);
		expect(dry.dry_run).toBe(true);
		expect(dry.plans?.some(p => p.node_ids.includes(a))).toBe(true);
		expect(await conflict_status(c)).toBe('open');

		const report = await pass('incremental', false);
		expect(report.merges).toBeGreaterThanOrEqual(1);
		expect(await conflict_status(c)).toBe('merged');
		expect(await query(`select id from tracks_table where id in ($1, $2)`, [a, b])).toHaveLength(1);
		expect(['open', 'dismissed']).toContain(await conflict_status(cx));
	});

	it('plans, applies and reviews in full passes', async () => {
		const code = isrc();
		const title = unique('Full Pass Song');
		const a = await track({ isrc: code, spotify_id: unique('sp') }, { title });
		const b = await track({ isrc: code }, { title, duration_ms: 200_300 });
		const sc = sc_id();
		const sc_user = sc_id();
		await query(`insert into soundcloud_users_table (id, permalink, username) values ($1, $2, 'Someone')`, [sc_user, unique('someone')]);
		await query(`insert into soundcloud_tracks_table (id, title, permalink, user_id, duration) values ($1, 'A Completely Different Title', 'x', $2, 60000)`, [sc, sc_user]);
		const split_from = await track({ soundcloud_id: sc }, { title: unique('Original Track Name'), duration_ms: 240_000 });
		const c = await conflict(split_from, 'soundcloud_id');

		const dry = await pass('full', true);
		expect(dry.groups).toBeGreaterThan(0);
		expect(dry.plans?.some(p => p.node_ids.includes(a))).toBe(true);
		expect(await query(`select 1 from tracks_table where id = $1`, [b])).toHaveLength(1);

		const real = await pass('full', false);
		expect(real.merges).toBeGreaterThanOrEqual(1);
		expect(real.failed_groups).toBe(0);
		expect(await query(`select 1 from tracks_table where id in ($1, $2)`, [a, b])).toHaveLength(1);
		expect(['open', 'split', 'dismissed', 'deferred']).toContain(await conflict_status(c));
	});
});

describe('reconcile edge cases', () => {
	it('counts an applied move and keeps the survivor\'s album track while filling its missing number', async () => {
		const gid = sc_id();
		const from = await track({ genius_id: gid });
		const to = await track();
		const plan: GroupPlan = { key: to, kind: 'track', node_ids: [to, from], steps: [move_step(from, to, { genius_id: String(gid) }, { facet_source: 'genius' })], evidence: [], disagreements: [], conflicts: [] };
		const report = empty_report();
		await apply_group(plan, report, { review: false });
		expect(report.moves).toBe(1);

		const [keep, lose] = [await track(), await track()];
		const al = await album();
		await query('insert into album_tracks_table (album_id, track_id, track_number) values ($1, $2, null), ($1, $3, 4)', [al, keep, lose]);
		expect((await in_tx(tx => apply_merge(tx, merge_step(keep, lose), reconcile))).applied).toBe(true);
		expect(await query('select track_number from album_tracks_table where album_id = $1 and track_id = $2', [al, keep])).toEqual([{ track_number: 4 }]);
	});

	it('skips groups above the size limit and rolls back a group that fails to apply', async () => {
		const code = isrc();
		const title = unique('Edge Pass Song');
		await track({ isrc: code }, { title });
		await track({ isrc: code }, { title, duration_ms: 200_300 });

		const skipped = await run_pass({ mode: 'full', dry_run: true, thresholds: { ...thresholds, max_group_size: 1 } });
		expect(skipped.skipped_groups).toBeGreaterThan(0);

		const marker = unique('refuse_merge').replace(/-/gu, '_');
		await query(`create or replace function refuse_merge_audit() returns trigger language plpgsql as $$ begin
			if new.action = 'merge' then raise exception '${marker}'; end if; return new; end $$`);
		await query('create trigger refuse_merge_audit_test before insert on audit_log_table for each row execute function refuse_merge_audit()');
		try {
			let report = await run_pass({ mode: 'full', dry_run: false, thresholds });
			for (let i = 0; i < 40 && report.locked; i++) {
				await new Promise(r => setTimeout(r, 500));
				report = await run_pass({ mode: 'full', dry_run: false, thresholds });
			}
			expect(report.failed_groups).toBeGreaterThan(0);
		} finally {
			await query('drop trigger refuse_merge_audit_test on audit_log_table');
			await query('drop function refuse_merge_audit()');
		}
	});
});
