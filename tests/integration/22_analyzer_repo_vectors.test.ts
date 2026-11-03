import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { track_vectors_table } from '../../src/db/schema';
import type { SampleInsert } from '../../src/services/analyzer/contract';
import {
	eligible_track_ids, eligible_vocals_track_ids, outdated_sample_track_ids, record_lookup, record_vocals, resolve_source, resolve_vocals_target, save_sample, track_priorities
} from '../../src/services/analyzer/repo';
import {
	CURRENT_VECTOR_VERSION, mean_vector, rebuild_stale_vectors, recent_play_track_ids, search_by_vector, similar_tracks, taste_search,
	user_library_track_ids, VECTOR_DIMENSIONS, write_vector
} from '../../src/services/vectors';
import { create_user, pool, unique, uuid } from './helpers';

const tracks: string[] = [];
const itunes_ids: number[] = [];
let next_it = 9_800_000_000 + Math.floor(Math.random() * 1_000_000) * 100;

/** Seeds a track; `lyrics` lists the sync types of its lyrics rows (one unsynced row by default). */
async function seed_track(opts: { media?: string[]; preview?: string; lyrics?: readonly string[] } = {}) {
	const id = uuid();
	const it_id = opts.preview ? next_it++ : null;
	await pool.query('insert into service_ids_table (illusi_id, applemusic_id) values ($1, $2)', [id, it_id === null ? null : String(it_id)]);
	await pool.query('insert into tracks_table (id, title) values ($1, $2)', [id, unique('Repo Track')]);
	for (const resource_id of opts.media ?? []) await pool.query('insert into media_table (track_id, resource_id, content_hash) values ($1, $2, $3)', [id, resource_id, unique('h')]);
	if (it_id !== null) {
		await pool.query('insert into itunes_tracks_table (id, name, preview_url) values ($1, $2, $3)', [it_id, 'p', opts.preview]);
		itunes_ids.push(it_id);
	}
	for (const sync_type of opts.lyrics ?? ['NONE']) {
		const raw = unique('lyrics');
		await pool.query(`insert into track_lyrics_table (track_id, service, sync_type, format, raw_content, content_hash) values ($1, 'GENIUS', $2, 'PLAIN', $3, $4)`,
			[id, sync_type, raw, createHash('sha256').update(raw).digest('hex')]);
	}
	tracks.push(id);
	return id;
}

const base_sample = (id: string, over: Partial<SampleInsert> = {}): SampleInsert => ({
	id, mood: 'House/Dance', tempo: 124, brightness: 2800, key: 'F#m', acousticness: 0.3, instrumentalness: 0.7, liveness: 0.15, danceability: 0.8, arousal: 0.7, valence: 0.8, speechiness: 0.05, ...over
});
const insert_sample = async (row: SampleInsert) => {
	await pool.query('insert into track_sample_data_table (id, mood, tempo, brightness, key, acousticness, instrumentalness, liveness, danceability, arousal, valence, speechiness) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
		[row.id, row.mood, row.tempo, row.brightness, row.key, row.acousticness, row.instrumentalness, row.liveness, row.danceability, row.arousal, row.valence, row.speechiness]);
};
const lookup_row = (track_id: string, source: string, status: string, source_ref: string | null, retry_after: string | null = null) =>
	pool.query('insert into track_sample_lookups_table (track_id, source, status, attempts, retry_after, source_ref) values ($1, $2, $3, 1, $4, $5)', [track_id, source, status, retry_after, source_ref]);

afterAll(async () => {
	await pool.query('delete from user_tracks_table where track_id = any($1)', [tracks]);
	await pool.query('delete from track_plays_table where track_id = any($1)', [tracks]);
	await pool.query('delete from track_vectors_table where track_id = any($1)', [tracks]);
	await pool.query('delete from track_vocals_table where track_id = any($1)', [tracks]);
	await pool.query('delete from track_lyrics_table where track_id = any($1)', [tracks]);
	await pool.query('delete from track_play_counts_table where track_id = any($1)', [tracks]);
	await pool.query('delete from service_tracks_table where illusi_id = any($1)', [tracks]);
	await pool.query('delete from track_sample_lookups_table where track_id = any($1)', [tracks]);
	await pool.query('delete from track_sample_data_table where id = any($1)', [tracks]);
	await pool.query('delete from media_table where track_id = any($1)', [tracks]);
	await pool.query('delete from tracks_table where id = any($1)', [tracks]);
	await pool.query('delete from service_ids_table where illusi_id = any($1)', [tracks]);
	if (itunes_ids.length > 0) await pool.query('delete from itunes_tracks_table where id = any($1)', [itunes_ids]);
});

describe('analyzer repo: eligible_track_ids', () => {
	it('returns nothing for an empty filter', async () => {
		expect(await eligible_track_ids([])).toEqual([]);
	});

	it('includes tracks with media or a preview and no sample, excludes the rest', async () => {
		const media = await seed_track({ media: [unique('m')] });
		const preview = await seed_track({ preview: 'https://audio.test/a.m4a' });
		const nothing = await seed_track();
		const sampled = await seed_track({ media: [unique('m')] });
		await insert_sample(base_sample(sampled));
		expect((await eligible_track_ids([media, preview, nothing, sampled])).sort()).toEqual([media, preview].sort());
	});

	it('blocks a source for BAD_FILE/NOT_FOUND until its ref changes, and for ERROR until retry_after', async () => {
		const ref = unique('m');
		const bad = await seed_track({ media: [ref] });
		await lookup_row(bad, 'media', 'BAD_FILE', ref);
		const bad_changed = await seed_track({ media: [unique('new')] });
		await lookup_row(bad_changed, 'media', 'BAD_FILE', 'old-ref');
		const error_future = await seed_track({ media: [ref + 'f'] });
		await lookup_row(error_future, 'media', 'ERROR', ref + 'f', new Date(Date.now() + 3_600_000).toISOString());
		const error_past = await seed_track({ media: [ref + 'p'] });
		await lookup_row(error_past, 'media', 'ERROR', ref + 'p', new Date(Date.now() - 3_600_000).toISOString());
		const preview_blocked = await seed_track({ preview: 'https://audio.test/blocked.m4a' });
		await lookup_row(preview_blocked, 'itunes_preview', 'NOT_FOUND', 'https://audio.test/blocked.m4a');
		const both = await seed_track({ media: [ref + 'b'], preview: 'https://audio.test/both.m4a' });
		await lookup_row(both, 'media', 'BAD_FILE', ref + 'b');
		const ids = [bad, bad_changed, error_future, error_past, preview_blocked, both];
		expect((await eligible_track_ids(ids)).sort()).toEqual([bad_changed, error_past, both].sort());
	});

	it('uses the newest media row only', async () => {
		const old_ref = unique('old');
		const new_ref = unique('new');
		const id = await seed_track({ media: [old_ref, new_ref] });
		await lookup_row(id, 'media', 'BAD_FILE', new_ref);
		expect(await eligible_track_ids([id])).toEqual([]);
	});

	it('scans the whole table without a filter', async () => {
		const id = await seed_track({ media: [unique('m')] });
		expect(await eligible_track_ids()).toContain(id);
	});
});

describe('analyzer repo: resolve_source and lookups', () => {
	it('returns null for sampled tracks and tracks without sources', async () => {
		const sampled = await seed_track({ media: [unique('m')] });
		await insert_sample(base_sample(sampled));
		expect(await resolve_source(sampled)).toBeNull();
		expect(await resolve_source(await seed_track())).toBeNull();
		expect(await resolve_source(uuid())).toBeNull();
	});

	it('prefers media by default and the named source when asked', async () => {
		const ref = unique('m');
		const id = await seed_track({ media: [ref], preview: 'https://audio.test/p.m4a' });
		expect(await resolve_source(id)).toEqual({ source: 'media', ref, prior: null });
		expect(await resolve_source(id, 'itunes_preview')).toMatchObject({ source: 'itunes_preview', ref: 'https://audio.test/p.m4a' });
	});

	it('skips a blocked source and carries the prior lookup', async () => {
		const ref = unique('m');
		const id = await seed_track({ media: [ref], preview: 'https://audio.test/q.m4a' });
		await lookup_row(id, 'media', 'BAD_FILE', ref);
		expect(await resolve_source(id)).toMatchObject({ source: 'itunes_preview', prior: null });
		await lookup_row(id, 'itunes_preview', 'NOT_FOUND', 'https://audio.test/q.m4a');
		expect(await resolve_source(id)).toBeNull();
	});

	it('returns the prior of an ERROR whose retry time has passed', async () => {
		const ref = unique('m');
		const id = await seed_track({ media: [ref] });
		await lookup_row(id, 'media', 'ERROR', ref, new Date(Date.now() - 1000).toISOString());
		expect(await resolve_source(id)).toMatchObject({ source: 'media', prior: { status: 'ERROR', attempts: 1, source_ref: ref } });
	});

	it('record_lookup upserts and continues the attempt count for the same ref', async () => {
		const ref = unique('m');
		const id = await seed_track({ media: [ref] });
		const first = (await resolve_source(id))!;
		await record_lookup(db, id, first, 'ERROR', new Date(Date.now() + 1000));
		const second = (await resolve_source(id))!;
		expect(second).toBeNull();
		const rows = (await pool.query('select status, attempts, source_ref from track_sample_lookups_table where track_id = $1', [id])).rows;
		expect(rows).toEqual([{ status: 'ERROR', attempts: 1, source_ref: ref }]);
		await record_lookup(db, id, { ...first, prior: { status: 'ERROR', retry_after: null, source_ref: ref, attempts: 1 } }, 'BAD_FILE', null);
		const after = (await pool.query('select status, attempts, retry_after from track_sample_lookups_table where track_id = $1', [id])).rows;
		expect(after).toEqual([{ status: 'BAD_FILE', attempts: 2, retry_after: null }]);
	});
});

describe('analyzer repo: save_sample', () => {
	it('stores the sample, its vector and the DONE lookup once; the first sample wins', async () => {
		const ref = unique('m');
		const id = await seed_track({ media: [ref] });
		const source = (await resolve_source(id))!;
		expect(await save_sample(base_sample(id), source)).toBe(true);
		expect((await pool.query('select mood from track_sample_data_table where id = $1', [id])).rows).toEqual([{ mood: 'House/Dance' }]);
		expect((await pool.query('select version from track_vectors_table where track_id = $1', [id])).rows).toEqual([{ version: CURRENT_VECTOR_VERSION }]);
		expect((await pool.query('select status from track_sample_lookups_table where track_id = $1', [id])).rows).toEqual([{ status: 'DONE' }]);
		expect(await save_sample(base_sample(id, { mood: 'Low Energy' }), source)).toBe(false);
		expect((await pool.query('select mood from track_sample_data_table where id = $1', [id])).rows).toEqual([{ mood: 'House/Dance' }]);
	});

	it('replaces a sample from an older analyzer, found again with upgrade', async () => {
		const ref = unique('m');
		const id = await seed_track({ media: [ref] });
		const source = (await resolve_source(id))!;
		expect(await save_sample(base_sample(id, { version: 2 }), source)).toBe(true);
		expect(await resolve_source(id, undefined, true)).toBeNull();
		await pool.query('update track_sample_data_table set version = 1 where id = $1', [id]);
		expect(await outdated_sample_track_ids()).toContain(id);
		// The DONE lookup for the same file doesn't block a refresh
		const again = (await resolve_source(id, undefined, true))!;
		expect(again).toMatchObject({ source: 'media', ref });
		expect(await save_sample(base_sample(id, { mood: 'Low Energy', version: 2, mfccs: Array<number>(13).fill(1) }), again)).toBe(true);
		expect((await pool.query('select mood, version, mfccs from track_sample_data_table where id = $1', [id])).rows).toEqual([{ mood: 'Low Energy', version: 2, mfccs: Array<number>(13).fill(1) }]);
		expect(await outdated_sample_track_ids()).not.toContain(id);
		expect(await resolve_source(uuid(), undefined, true)).toBeNull();
	});

	it('rolls back the sample when the lookup cannot be written', async () => {
		const id = await seed_track({ media: [unique('m')] });
		const bad_source = { source: 'media' as const, ref: 'x'.repeat(600), prior: null };
		await expect(save_sample(base_sample(id), bad_source)).rejects.toThrow();
		expect((await pool.query('select 1 from track_sample_data_table where id = $1', [id])).rowCount).toBe(0);
		expect((await pool.query('select 1 from track_vectors_table where track_id = $1', [id])).rowCount).toBe(0);
	});
});

describe('analyzer repo: vocals', () => {
	const result = {
		model: 'm', hop_ms: 256, window_ms: 2048, duration_ms: 30_000, voice: [0.1, 0.8], segments: [10, 20],
		rhythm_model: 'r', rhythm_bpm: 120, rhythm_confidence: 3.4, beats: [500, 1000], bpm_estimates: [120],
		words_model: 'w', words: ['hello', 'world'], word_times: [100, 300, 400, 800], word_probabilities: [0.9, 0.5],
		speech_model: 's', speech_hop_ms: 32, speech: [0.25, 0.75], beat_grid_model: 'g', grid_beats: [500, 1000], downbeats: [500]
	};

	it('lists tracks whose newest media file has no usable vocals result', async () => {
		const ref = unique('v');
		const fresh = await seed_track({ media: [ref] });
		const done = await seed_track({ media: [ref + 'd'] });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status, beats, words) values ($1, $2, 'DONE', '{}', '{}')`, [done, ref + 'd']);
		const no_beats = await seed_track({ media: [ref + 'n'] });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status, words) values ($1, $2, 'DONE', '{}')`, [no_beats, ref + 'n']);
		const no_words = await seed_track({ media: [ref + 'o'] });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status, beats) values ($1, $2, 'DONE', '{}')`, [no_words, ref + 'o']);
		const stale = await seed_track({ media: [ref + 's'] });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status) values ($1, 'older-file', 'DONE')`, [stale]);
		const error_due = await seed_track({ media: [ref + 'e'] });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status, retry_after) values ($1, $2, 'ERROR', now() - interval '1 hour')`, [error_due, ref + 'e']);
		const error_wait = await seed_track({ media: [ref + 'w'] });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status, retry_after) values ($1, $2, 'ERROR', now() + interval '1 hour')`, [error_wait, ref + 'w']);
		const bad = await seed_track({ media: [ref + 'b'] });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status) values ($1, $2, 'BAD_FILE')`, [bad, ref + 'b']);
		const listed = new Set(await eligible_vocals_track_ids());
		expect([fresh, stale, error_due, no_beats, no_words].every(id => listed.has(id))).toBe(true);
		expect([done, error_wait, bad].some(id => listed.has(id))).toBe(false);
	});

	it('resolves the vocals target for the newest media file', async () => {
		const no_media = await seed_track();
		expect(await resolve_vocals_target(no_media)).toBeNull();
		const ref = unique('t');
		const id = await seed_track({ media: ['older-' + ref, ref] });
		expect(await resolve_vocals_target(id)).toEqual({ resource_id: ref, prior: null });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status, attempts) values ($1, $2, 'DONE', 1)`, [id, ref]);
		// From before beat tracking: analyzed again
		expect(await resolve_vocals_target(id)).toMatchObject({ resource_id: ref, prior: { status: 'DONE', source_ref: ref } });
		await pool.query(`update track_vocals_table set beats = '{500}' where track_id = $1`, [id]);
		// From before the lyrics alignment features: analyzed again
		expect(await resolve_vocals_target(id)).toMatchObject({ resource_id: ref });
		await pool.query(`update track_vocals_table set words = '{}' where track_id = $1`, [id]);
		expect(await resolve_vocals_target(id)).toBeNull();
		await pool.query(`update track_vocals_table set resource_id = 'previous-file' where track_id = $1`, [id]);
		expect(await resolve_vocals_target(id)).toMatchObject({ resource_id: ref, prior: { status: 'DONE', source_ref: 'previous-file', attempts: 1 } });
	});

	it('only lists and resolves tracks whose lyrics are all unsynced', async () => {
		const ref = unique('l');
		const unsynced = await seed_track({ media: [ref + 'u'], lyrics: ['NONE', 'NONE'] });
		const line = await seed_track({ media: [ref + 'l'], lyrics: ['NONE', 'LINE'] });
		const word = await seed_track({ media: [ref + 'w'], lyrics: ['WORD'] });
		const none = await seed_track({ media: [ref + 'n'], lyrics: [] });
		const listed = new Set(await eligible_vocals_track_ids());
		expect(listed.has(unsynced)).toBe(true);
		expect([line, word, none].some(id => listed.has(id))).toBe(false);
		expect(await resolve_vocals_target(unsynced)).toEqual({ resource_id: ref + 'u', prior: null });
		for (const id of [line, word, none]) expect(await resolve_vocals_target(id)).toBeNull();
	});

	it('records results and later failures, clearing the old results', async () => {
		const ref = unique('r');
		const id = await seed_track({ media: [ref] });
		const target = (await resolve_vocals_target(id))!;
		await record_vocals(id, target, 'DONE', null, result);
		let row = (await pool.query('select * from track_vocals_table where track_id = $1', [id])).rows[0];
		expect(row).toMatchObject({ status: 'DONE', attempts: 1, model: 'm', hop_ms: 256, window_ms: 2048, duration_ms: 30_000, segments: [10, 20], resource_id: ref, beats: [500, 1000], rhythm_model: 'r' });
		expect(row).toMatchObject({ words: ['hello', 'world'], word_times: [100, 300, 400, 800], speech_hop_ms: 32, grid_beats: [500, 1000], downbeats: [500], beat_grid_model: 'g' });
		expect(row.voice[0]).toBeCloseTo(0.1);
		expect(row.speech[1]).toBeCloseTo(0.75);
		await record_vocals(id, { resource_id: ref, prior: { status: 'DONE', retry_after: null, source_ref: ref, attempts: 1 } }, 'ERROR', new Date(Date.now() + 1000), null);
		row = (await pool.query('select * from track_vocals_table where track_id = $1', [id])).rows[0];
		expect(row).toMatchObject({ status: 'ERROR', attempts: 2, model: null, voice: null, segments: null, beats: null, rhythm_bpm: null, words: null, speech: null, grid_beats: null });
	});
});

describe('analyzer repo: track_priorities', () => {
	it('gives Illusi plays and the most plays any service reports, 0 for neither', async () => {
		const both = await seed_track();
		const views = await seed_track();
		const quiet = await seed_track();
		await pool.query('insert into track_play_counts_table (track_id, plays) values ($1, 12)', [both]);
		await pool.query(`insert into service_tracks_table (service, external_id, illusi_id, title, plays) values
			('spotify', $1, $2, 't', 300), ('deezer', $3, $2, 't', 7000), ('tidal', $4, $5, 't', null), ('spotify', $6, $5, 't', 40)`,
			[unique('st'), both, unique('st'), unique('st'), views, unique('st')]);
		const got = await track_priorities([both, views, quiet, both]);
		expect(got.size).toBe(3);
		expect(got.get(both)).toEqual({ plays: 12, views: 7000 });
		expect(got.get(views)).toEqual({ plays: 0, views: 40 });
		expect(got.get(quiet)).toEqual({ plays: 0, views: 0 });
		expect((await track_priorities([])).size).toBe(0);
	});
});

describe('vectors: writing and rebuilding', () => {
	it('write_vector is a no-op for a missing sample and upserts for an existing one', async () => {
		const missing = await seed_track();
		await db.transaction(tx => write_vector(tx, missing));
		expect((await pool.query('select 1 from track_vectors_table where track_id = $1', [missing])).rowCount).toBe(0);
		const id = await seed_track();
		await insert_sample(base_sample(id));
		await db.transaction(tx => write_vector(tx, id));
		const first = (await pool.query('select embedding::text as e, modified_at from track_vectors_table where track_id = $1', [id])).rows[0];
		expect(JSON.parse(first.e)).toHaveLength(VECTOR_DIMENSIONS);
		await pool.query('update track_sample_data_table set tempo = 70 where id = $1', [id]);
		await db.transaction(tx => write_vector(tx, id));
		const second = (await pool.query('select embedding::text as e from track_vectors_table where track_id = $1', [id])).rows[0];
		expect(second.e).not.toBe(first.e);
	});

	it('rebuilds missing and outdated vectors in batches and leaves current ones alone', async () => {
		const missing = await seed_track();
		const outdated = await seed_track();
		const current = await seed_track();
		for (const id of [missing, outdated, current]) await insert_sample(base_sample(id));
		await db.transaction(async (tx) => {
			await write_vector(tx, outdated);
			await write_vector(tx, current);
		});
		await pool.query('update track_vectors_table set version = 0 where track_id = $1', [outdated]);
		const current_modified = (await pool.query('select modified_at from track_vectors_table where track_id = $1', [current])).rows[0].modified_at;
		const total = await rebuild_stale_vectors(1);
		expect(total).toBeGreaterThanOrEqual(2);
		const versions = await db.select({ id: track_vectors_table.track_id, version: track_vectors_table.version }).from(track_vectors_table).where(inArray(track_vectors_table.track_id, [missing, outdated, current]));
		expect(versions.map(v => v.version)).toEqual([1, 1, 1]);
		expect((await pool.query('select modified_at from track_vectors_table where track_id = $1', [current])).rows[0].modified_at).toEqual(current_modified);
		expect(await rebuild_stale_vectors()).toBe(0);
	});
});

describe('vectors: search', () => {
	const house = (id: string) => base_sample(id);
	const house_alt = (id: string) => base_sample(id, { tempo: 126, valence: 0.75, brightness: 2900 });
	const ambient = (id: string) => base_sample(id, { mood: 'Ambient/Drone', tempo: 60, brightness: 400, key: 'C', arousal: 0.05, valence: 0.2, danceability: 0.05, acousticness: 0.9 });
	let a = '';
	let b = '';
	let c = '';
	let all: string[] = [];
	let fan: Awaited<ReturnType<typeof create_user>>;
	let other: Awaited<ReturnType<typeof create_user>>;

	beforeAll(async () => {
		[a, b, c] = [await seed_track(), await seed_track(), await seed_track()];
		all = [a, b, c];
		for (const [id, make] of [[a, house], [b, house_alt], [c, ambient]] as const) {
			await insert_sample(make(id));
			await db.transaction(tx => write_vector(tx, id));
		}
		fan = await create_user('vec-fan');
		other = await create_user('vec-other');
		await pool.query('insert into user_tracks_table (user_id, track_id, deleted) values ($1, $2, false), ($1, $3, true)', [fan.id, a, b]);
		await pool.query('insert into track_plays_table (user_id, track_id, created_at) values ($1, $2, now() - interval \'3 minutes\'), ($1, $3, now() - interval \'2 minutes\'), ($1, $2, now() - interval \'1 minute\')', [fan.id, a, c]);
	});

	const scoped = (extra: Parameters<typeof search_by_vector>[2] = {}) => ({ ...extra, where: inArray(track_vectors_table.track_id, all) });
	const embedding_of = async (id: string) => JSON.parse((await pool.query('select embedding::text as e from track_vectors_table where track_id = $1', [id])).rows[0].e) as number[];

	it('orders by cosine distance and honours k', async () => {
		const e = await embedding_of(a);
		const res = await search_by_vector(e, 3, scoped());
		expect(res.map(r => r.track_id)).toEqual([a, b, c]);
		expect(res[0].distance).toBeCloseTo(0, 5);
		expect(res[1].distance).toBeLessThan(res[2].distance);
		expect(await search_by_vector(e, 1, scoped())).toHaveLength(1);
	});

	it('excludes given tracks, a user\'s deleted tracks and a user\'s library', async () => {
		const e = await embedding_of(a);
		expect((await search_by_vector(e, 3, scoped({ exclude_track_ids: [a] }))).map(r => r.track_id)).toEqual([b, c]);
		expect((await search_by_vector(e, 3, scoped({ user_id: fan.id }))).map(r => r.track_id)).toEqual([a, c]);
		expect((await search_by_vector(e, 3, scoped({ user_id: other.id }))).map(r => r.track_id)).toEqual([a, b, c]);
		expect((await search_by_vector(e, 3, scoped({ exclude_library_of: fan.id }))).map(r => r.track_id)).toEqual([b, c]);
	});

	it('finds similar tracks without the track itself and without the user\'s deleted ones', async () => {
		const plain = (await similar_tracks(a, 100000)).map(r => r.track_id).filter(id => all.includes(id));
		expect(plain).toEqual([b, c]);
		const for_fan = (await similar_tracks(a, 100000, fan.id)).map(r => r.track_id).filter(id => all.includes(id));
		expect(for_fan).toEqual([c]);
		expect(await similar_tracks(uuid(), 5)).toEqual([]);
		const no_vector = await seed_track();
		expect(await similar_tracks(no_vector, 5)).toEqual([]);
	});

	it('computes the mean vector and searches by taste', async () => {
		expect(await mean_vector([])).toBeNull();
		expect(await mean_vector([uuid()])).toBeNull();
		const ea = await embedding_of(a);
		const eb = await embedding_of(b);
		const mean = (await mean_vector([a, b]))!;
		expect(mean).toHaveLength(VECTOR_DIMENSIONS);
		mean.forEach((v, i) => expect(v).toBeCloseTo((ea[i] + eb[i]) / 2, 4));
		expect(await taste_search([], 5)).toEqual([]);
		const taste = (await taste_search([a, b], 100000)).map(r => r.track_id).filter(id => all.includes(id));
		expect(taste).toEqual([c]);
		const explicit = (await taste_search([a, b], 100000, [])).map(r => r.track_id).filter(id => all.includes(id));
		expect(explicit.slice(0, 2).sort()).toEqual([a, b].sort());
		const for_fan = (await taste_search([a], 100000, [a], { user_id: fan.id })).map(r => r.track_id).filter(id => all.includes(id));
		expect(for_fan).toEqual([c]);
	});

	it('lists a user\'s library and recent plays', async () => {
		expect(await user_library_track_ids(fan.id)).toEqual([a]);
		expect(await user_library_track_ids(other.id)).toEqual([]);
		expect(await recent_play_track_ids(fan.id)).toEqual([a, c]);
		expect(await recent_play_track_ids(fan.id, 1)).toEqual([a]);
		expect(await recent_play_track_ids(other.id)).toEqual([]);
	});
});
