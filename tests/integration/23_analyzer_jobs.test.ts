import { randomInt } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => {
	process.env.ANALYZER_JOB_TIMEOUT_MS = '400';
	return { only: [] as string[], fail_resolve: 0, fail_rebuild: false };
});

vi.mock('../../src/services/analyzer/repo', async (original) => {
	const real = await original<typeof import('../../src/services/analyzer/repo')>();
	return {
		...real,
		eligible_track_ids: vi.fn(async (only?: readonly string[]) => real.eligible_track_ids(only ?? flags.only)),
		eligible_vocals_track_ids: vi.fn(async () => (await real.eligible_vocals_track_ids()).filter(id => flags.only.includes(id))),
		resolve_source: vi.fn(async (...args: Parameters<typeof real.resolve_source>) => {
			if (flags.fail_resolve > 0) {
				flags.fail_resolve--;
				throw new Error('database unavailable');
			}
			return real.resolve_source(...args);
		})
	};
});
vi.mock('../../src/services/vectors', async (original) => {
	const real = await original<typeof import('../../src/services/vectors')>();
	return {
		...real,
		rebuild_stale_vectors: vi.fn(async (...args: Parameters<typeof real.rebuild_stale_vectors>) => {
			if (flags.fail_rebuild) throw new Error('rebuild failed');
			return real.rebuild_stale_vectors(...args);
		})
	};
});

import { config } from '../../src/config';
import { emit } from '../../src/core/events';
import { enqueue_if_needed, start, stop } from '../../src/services/analyzer';
import { pool, unique, uuid } from './helpers';

const analysis = { mood: 'House/Dance', tempo: 124.5, brightness: 2810.2, key: 'F#m', arousal: 0.7, valence: 0.88, acousticness: 0.34, instrumentalness: 0.71, liveness: 0.16, danceability: 0.62, speechiness: 0.04 };
const vocals = { model: 'test-model', hop_ms: 256, window_ms: 2048, duration_ms: 30_000, voice: [0.1, 0.9], segments: [{ start_ms: 100, end_ms: 900 }] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call { url: string; path?: string }
const calls: Call[] = [];
let health: () => Response | Promise<Response>;
let analyze: (body: { path: string }, init: RequestInit) => Response | Promise<Response>;
let vocals_handler: (body: { path: string }, init: RequestInit) => Response | Promise<Response>;
let download: (url: string) => Response | Promise<Response>;

function hang_until_aborted(init: RequestInit): Promise<Response> {
	return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
}

const media_dir = path.resolve(config.MEDIA_DIR);
const tmp_dir = path.resolve(config.ANALYZER_TMP_DIR);
const seeded: string[] = [];
const BASE = 9_700_000_000 + randomInt(1_000_000) * 1000;
let next_it = BASE;

async function seed_track(opts: { media?: string | null; write_file?: boolean; preview?: string | null } = {}) {
	const id = uuid();
	const it_id = next_it++;
	await pool.query('insert into service_ids_table (illusi_id, applemusic_id) values ($1, $2)', [id, opts.preview ? String(it_id) : null]);
	await pool.query('insert into tracks_table (id, title) values ($1, $2)', [id, unique('Analyzer Track')]);
	if (opts.preview) await pool.query('insert into itunes_tracks_table (id, name, preview_url) values ($1, $2, $3)', [it_id, 'p', opts.preview]);
	let resource_id: string | null = null;
	if (opts.media !== null && opts.media !== undefined) {
		resource_id = opts.media;
		await pool.query('insert into media_table (track_id, resource_id, content_hash) values ($1, $2, $3)', [id, resource_id, unique('hash')]);
		if (opts.write_file !== false) await writeFile(path.join(media_dir, resource_id), 'fake audio');
	}
	seeded.push(id);
	return { id, resource_id, it_id };
}

const sample_of = async (id: string) => (await pool.query('select * from track_sample_data_table where id = $1', [id])).rows[0];
const lookups_of = async (id: string) => (await pool.query('select source, status, attempts, retry_after, source_ref from track_sample_lookups_table where track_id = $1 order by source', [id])).rows;
const vocals_of = async (id: string) => (await pool.query('select * from track_vocals_table where track_id = $1', [id])).rows[0];
const vector_of = async (id: string) => (await pool.query('select version from track_vectors_table where track_id = $1', [id])).rows[0];
const wait = <T>(fn: () => Promise<T>) => vi.waitFor(fn, { timeout: 8000, interval: 25 });

beforeAll(async () => {
	await mkdir(media_dir, { recursive: true });
	await mkdir(tmp_dir, { recursive: true });
});

beforeEach(() => {
	calls.length = 0;
	flags.only = [];
	flags.fail_resolve = 0;
	flags.fail_rebuild = false;
	health = () => new Response('ok');
	analyze = () => json(analysis);
	vocals_handler = () => json(vocals);
	download = () => new Response('preview bytes');
	vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
		const url = String(input);
		const body = typeof init.body === 'string' ? JSON.parse(init.body) as { path: string } : undefined;
		calls.push({ url, path: body?.path });
		if (url.endsWith('/health')) return health();
		if (url.endsWith('/analyze')) return analyze(body!, init);
		if (url.endsWith('/vocals')) return vocals_handler(body!, init);
		return download(url);
	});
});

afterAll(async () => {
	await stop();
	vi.unstubAllGlobals();
	if (seeded.length > 0) {
		await pool.query('delete from track_vectors_table where track_id = any($1)', [seeded]);
		await pool.query('delete from track_vocals_table where track_id = any($1)', [seeded]);
		await pool.query('delete from track_sample_lookups_table where track_id = any($1)', [seeded]);
		await pool.query('delete from track_sample_data_table where id = any($1)', [seeded]);
		await pool.query('delete from media_table where track_id = any($1)', [seeded]);
		await pool.query('delete from tracks_table where id = any($1)', [seeded]);
		await pool.query('delete from service_ids_table where illusi_id = any($1)', [seeded]);
	}
	await pool.query('delete from itunes_tracks_table where id >= $1 and id < $2', [BASE, next_it]);
});

describe('analyzer jobs from media', () => {
	it('analyzes a new media file, stores the sample, vector and vocals', async () => {
		const t = await seed_track({ media: uuid() });
		await start();
		emit('media_inserted', { track_id: t.id, resource_id: t.resource_id! });
		await wait(async () => expect(await vocals_of(t.id)).toMatchObject({ status: 'DONE', resource_id: t.resource_id }));
		expect(await sample_of(t.id)).toMatchObject({ mood: 'House/Dance', key: 'F#m', tempo: 124.5 });
		expect(await vector_of(t.id)).toMatchObject({ version: 1 });
		expect(await lookups_of(t.id)).toEqual([expect.objectContaining({ source: 'media', status: 'DONE', source_ref: t.resource_id })]);
		expect((await vocals_of(t.id)).segments).toEqual([100, 900]);
		expect(calls.filter(c => c.url.endsWith('/analyze'))[0].path).toBe(path.join(media_dir, t.resource_id!));
		await stop();
	});

	it('records BAD_FILE when the analyzer rejects the file, without retry_after', async () => {
		const t = await seed_track({ media: uuid() });
		analyze = () => new Response('cannot decode', { status: 422 });
		vocals_handler = () => new Response('cannot decode', { status: 400 });
		await start();
		emit('media_inserted', { track_id: t.id, resource_id: t.resource_id! });
		await wait(async () => expect(await vocals_of(t.id)).toMatchObject({ status: 'BAD_FILE' }));
		await wait(async () => expect(await lookups_of(t.id)).toEqual([expect.objectContaining({ source: 'media', status: 'BAD_FILE', retry_after: null })]));
		expect(await sample_of(t.id)).toBeUndefined();
		await stop();
	});

	it('records BAD_FILE when the media file is missing or its resource id is unsafe', async () => {
		const missing = await seed_track({ media: uuid(), write_file: false });
		const unsafe = await seed_track({ media: `../${uuid()}` });
		await start();
		emit('media_inserted', { track_id: missing.id, resource_id: missing.resource_id! });
		emit('media_inserted', { track_id: unsafe.id, resource_id: unsafe.resource_id! });
		await wait(async () => {
			expect(await lookups_of(missing.id)).toEqual([expect.objectContaining({ status: 'BAD_FILE' })]);
			expect(await lookups_of(unsafe.id)).toEqual([expect.objectContaining({ status: 'BAD_FILE' })]);
		});
		expect(calls.filter(c => c.url.endsWith('/analyze'))).toHaveLength(0);
		await stop();
	});

	it('gives up on a response that breaks the contract after three tries and records ERROR with a retry time', async () => {
		const t = await seed_track({ media: uuid() });
		analyze = () => json({ mood: 'House/Dance' });
		vocals_handler = () => json({ nonsense: true });
		await start();
		emit('media_inserted', { track_id: t.id, resource_id: t.resource_id! });
		await wait(async () => expect(await lookups_of(t.id)).toEqual([expect.objectContaining({ status: 'ERROR' })]));
		const [row] = await lookups_of(t.id);
		expect(row.retry_after).toBeInstanceOf(Date);
		expect(row.retry_after.getTime()).toBeGreaterThan(Date.now());
		expect(calls.filter(c => c.url.endsWith('/analyze'))).toHaveLength(3);
		await wait(async () => expect(await vocals_of(t.id)).toMatchObject({ status: 'ERROR' }));
		await stop();
	});

	it('records ERROR when the job times out', async () => {
		const t = await seed_track({ media: uuid() });
		analyze = (_, init) => hang_until_aborted(init);
		vocals_handler = (_, init) => hang_until_aborted(init);
		await start();
		emit('media_inserted', { track_id: t.id, resource_id: t.resource_id! });
		await wait(async () => expect(await lookups_of(t.id)).toEqual([expect.objectContaining({ status: 'ERROR' })]));
		await wait(async () => expect(await vocals_of(t.id)).toMatchObject({ status: 'ERROR' }));
		await stop();
	});

	it('pauses on an outage, waits for /health and retries the same job', async () => {
		const t = await seed_track({ media: uuid() });
		let down = false;
		health = () => (down ? new Response('', { status: 503 }) : new Response('ok'));
		analyze = () => {
			if (down) {
				down = false;
				return new Response('', { status: 503 });
			}
			return json(analysis);
		};
		await start();
		down = true;
		emit('media_inserted', { track_id: t.id, resource_id: t.resource_id! });
		await wait(async () => expect(await sample_of(t.id)).toBeDefined());
		expect(calls.filter(c => c.url.endsWith('/health')).length).toBeGreaterThan(1);
		await stop();
	});

	it('survives a network failure to the analyzer', async () => {
		const t = await seed_track({ media: uuid() });
		let failed = false;
		analyze = () => {
			if (!failed) {
				failed = true;
				throw new Error('ECONNREFUSED');
			}
			return json(analysis);
		};
		await start();
		emit('media_inserted', { track_id: t.id, resource_id: t.resource_id! });
		await wait(async () => expect(await sample_of(t.id)).toBeDefined());
		expect(failed).toBe(true);
		await stop();
	});

	it('drops a job when the database fails while resolving it and keeps working', async () => {
		const dropped = await seed_track({ media: uuid() });
		const next = await seed_track({ media: uuid() });
		flags.fail_resolve = 1;
		await start();
		emit('media_inserted', { track_id: dropped.id, resource_id: dropped.resource_id! });
		emit('media_inserted', { track_id: next.id, resource_id: next.resource_id! });
		await wait(async () => expect(await sample_of(next.id)).toBeDefined());
		await stop();
	});

	it('skips a track that already has a sample', async () => {
		const t = await seed_track({ media: uuid() });
		await pool.query('insert into track_sample_data_table (id, mood, tempo, brightness, key, acousticness, instrumentalness, liveness, danceability, arousal, valence, speechiness) values ($1, $2, 1, 1, $3, 0, 0, 0, 0, 0, 0, 0)', [t.id, 'Low Energy', 'C']);
		await start();
		emit('media_inserted', { track_id: t.id, resource_id: t.resource_id! });
		await wait(async () => expect(await vocals_of(t.id)).toMatchObject({ status: 'DONE' }));
		expect(calls.filter(c => c.url.endsWith('/analyze'))).toHaveLength(0);
		await stop();
	});
});

describe('analyzer jobs from iTunes previews', () => {
	it('downloads the preview, analyzes it and removes the temp file', async () => {
		const t = await seed_track({ preview: 'https://audio.test/clip.m4a' });
		let seen_path = '';
		analyze = async (body) => {
			seen_path = body.path;
			expect((await stat(body.path)).isFile()).toBe(true);
			return json(analysis);
		};
		await start();
		emit('itunes_track_linked', { track_id: t.id, itunes_track_id: t.it_id, preview_url: 'https://audio.test/clip.m4a' });
		await wait(async () => expect(await sample_of(t.id)).toBeDefined());
		expect(seen_path.startsWith(tmp_dir)).toBe(true);
		expect(seen_path.endsWith('.m4a')).toBe(true);
		expect(await lookups_of(t.id)).toEqual([expect.objectContaining({ source: 'itunes_preview', status: 'DONE', source_ref: 'https://audio.test/clip.m4a' })]);
		await wait(async () => expect(await readdir(tmp_dir)).not.toContain(path.basename(seen_path)));
		expect(calls.filter(c => c.url.endsWith('/vocals'))).toHaveLength(0);
		await stop();
	});

	it('ignores an itunes_track_linked event without a preview', async () => {
		const t = await seed_track({ preview: 'https://audio.test/none.m4a' });
		await start();
		emit('itunes_track_linked', { track_id: t.id, itunes_track_id: t.it_id, preview_url: null });
		await new Promise(r => setTimeout(r, 150));
		expect(calls.filter(c => c.url.endsWith('/analyze') || c.url.includes('audio.test'))).toHaveLength(0);
		await stop();
	});

	it('records NOT_FOUND when the preview is gone', async () => {
		const t = await seed_track({ preview: 'https://audio.test/gone.m4a' });
		download = () => new Response('', { status: 404 });
		await start();
		emit('itunes_track_linked', { track_id: t.id, itunes_track_id: t.it_id, preview_url: 'https://audio.test/gone.m4a' });
		await wait(async () => expect(await lookups_of(t.id)).toEqual([expect.objectContaining({ source: 'itunes_preview', status: 'NOT_FOUND', retry_after: null })]));
		await stop();
	});

	it('falls back to the preview when the media source is blocked', async () => {
		const t = await seed_track({ media: uuid(), preview: 'https://audio.test/fallback.m4a' });
		await pool.query(`insert into track_sample_lookups_table (track_id, source, status, attempts, source_ref) values ($1, 'media', 'BAD_FILE', 1, $2)`, [t.id, t.resource_id]);
		await start();
		await enqueue_if_needed([t.id]);
		await wait(async () => expect(await sample_of(t.id)).toBeDefined());
		expect((await lookups_of(t.id)).map(l => `${l.source}:${l.status}`)).toEqual(['itunes_preview:DONE', 'media:BAD_FILE']);
		await stop();
	});
});

describe('analyzer startup and shutdown', () => {
	it('queues the backlog of eligible tracks on start', async () => {
		const sample = await seed_track({ media: uuid() });
		const done = await seed_track({ media: uuid() });
		await pool.query(`insert into track_vocals_table (track_id, resource_id, status, attempts) values ($1, $2, 'DONE', 1)`, [done.id, done.resource_id]);
		await pool.query('insert into track_sample_data_table (id, mood, tempo, brightness, key, acousticness, instrumentalness, liveness, danceability, arousal, valence, speechiness) values ($1, $2, 1, 1, $3, 0, 0, 0, 0, 0, 0, 0)', [done.id, 'Low Energy', 'C']);
		flags.only = [sample.id, done.id];
		await start();
		await wait(async () => {
			expect(await sample_of(sample.id)).toBeDefined();
			expect(await vocals_of(sample.id)).toMatchObject({ status: 'DONE' });
		});
		expect(calls.filter(c => c.path?.endsWith(done.resource_id!))).toHaveLength(0);
		await stop();
	});

	it('empties the temp directory and tolerates a failing vector rebuild', async () => {
		const leftover = path.join(tmp_dir, `${uuid()}.m4a`);
		await writeFile(leftover, 'stale');
		await mkdir(path.join(tmp_dir, 'nested'), { recursive: true });
		await writeFile(path.join(tmp_dir, 'nested', 'x'), 'stale');
		flags.fail_rebuild = true;
		await start();
		expect(await readdir(tmp_dir)).toEqual([]);
		await stop();
	});

	it('is idempotent to start twice and to stop when not started', async () => {
		await stop();
		await start();
		await start();
		await stop();
		await stop();
	});

	it('refuses a temp directory that is not its own and can start again afterwards', async () => {
		const original = config.ANALYZER_TMP_DIR;
		config.ANALYZER_TMP_DIR = config.MEDIA_DIR;
		try {
			await expect(start()).rejects.toThrow(/must be its own directory/);
		} finally {
			config.ANALYZER_TMP_DIR = original;
		}
		await start();
		await stop();
	});

	it('refuses a temp directory that reaches the media directory through a symlink', async () => {
		const link = path.join(path.dirname(tmp_dir), `link-${uuid()}`);
		const { symlink, rm } = await import('node:fs/promises');
		await symlink(media_dir, link);
		const original = config.ANALYZER_TMP_DIR;
		config.ANALYZER_TMP_DIR = link;
		try {
			await expect(start()).rejects.toThrow(/must be its own directory/);
		} finally {
			config.ANALYZER_TMP_DIR = original;
			await rm(link, { force: true });
		}
	});

	it('stops promptly while still waiting for the analyzer to become healthy', async () => {
		health = () => new Response('', { status: 503 });
		const starting = start();
		await wait(async () => expect(calls.some(c => c.url.endsWith('/health'))).toBe(true));
		await stop();
		await starting;
	});

	it('enqueue_if_needed ignores empty input, duplicates and ineligible tracks', async () => {
		const t = await seed_track({ media: uuid() });
		const nothing = await seed_track({});
		await start();
		await enqueue_if_needed([]);
		await enqueue_if_needed([nothing.id, nothing.id]);
		await enqueue_if_needed([t.id, t.id]);
		await wait(async () => expect(await sample_of(t.id)).toBeDefined());
		expect(calls.filter(c => c.url.endsWith('/analyze'))).toHaveLength(1);
		expect(await lookups_of(nothing.id)).toEqual([]);
		await stop();
	});
});
