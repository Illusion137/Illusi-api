import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config';
import { db } from '../../db';
import { on } from '../../core/events';
import { logger } from '../../core/log';
import { rebuild_stale_vectors } from '../vectors';
import { call_analyze, check_health, download_to, is_abort, JobError, sleep } from './client';
import { map_analysis } from './contract';
import type { JobFailure, SampleSource } from './decisions';
import { assert_tmp_dir_safe, decide_failure, health_backoff_ms, is_strictly_inside, may_delete, next_attempts, preview_extension, safe_media_path } from './decisions';
import { JobQueue } from './queue';
import type { ResolvedSource } from './repo';
import { eligible_track_ids, record_lookup, resolve_source, save_sample } from './repo';

const log = logger('analyzer');

interface Job {
	track_id: string;
	/** Source named by the live trigger, tried first. */
	prefer?: SampleSource;
	/** Analyzer 5xx responses seen by this job. */
	analyzer_5xx: number;
}

const queue = new JobQueue<Job>(job => job.track_id);
let tmp_dir = path.resolve(config.ANALYZER_TMP_DIR);
let media_dir = path.resolve(config.MEDIA_DIR);

let started = false;
let stopping = false;
let stop_controller = new AbortController();
let listeners_registered = false;
let workers: Promise<void>[] = [];
/** Resolves when the analyzer is healthy; replaced while the queue is paused. */
let gate = new Promise<void>(() => undefined);
let gate_pending = true;

function enqueue(job: Omit<Job, 'analyzer_5xx'>) {
	if (queue.push({ ...job, analyzer_5xx: 0 })) log.debug(`queued ${job.track_id}`, job.prefer);
}

function register_listeners() {
	if (listeners_registered) return;
	listeners_registered = true;
	on('itunes_track_linked', ({ track_id, preview_url }) => {
		if (preview_url) enqueue({ track_id, prefer: 'itunes_preview' });
	});
	on('media_inserted', ({ track_id }) => {
		enqueue({ track_id, prefer: 'media' });
	});
}

async function wait_for_health(): Promise<void> {
	for (let attempt = 0; !stopping; attempt++) {
		if (await check_health(config.ANALYZER_URL, stop_controller.signal)) {
			log.info('analyzer is ready');
			return;
		}
		if (attempt === 0) log.warn(`analyzer at ${config.ANALYZER_URL} not ready; waiting`);
		await sleep(health_backoff_ms(attempt), stop_controller.signal);
	}
}

/** Pauses every worker until `/health` reports ready again. */
function pause_until_healthy() {
	if (gate_pending) return;
	gate_pending = true;
	gate = wait_for_health().finally(() => { gate_pending = false; });
}

async function wait_gate() {
	while (gate_pending && !stopping) await gate;
}

/** Deletes a downloaded preview. Refuses anything that isn't a preview inside ANALYZER_TMP_DIR. */
async function delete_temp_file(source: SampleSource, file_path: string) {
	if (!may_delete(source, file_path, tmp_dir)) {
		log.error(`refusing to delete ${file_path} (source ${source})`);
		return;
	}
	await unlink(file_path).catch((err: unknown) => {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`failed to delete ${file_path}`, err);
	});
}

/** Empties ANALYZER_TMP_DIR. */
async function empty_tmp_dir() {
	const entries = await readdir(tmp_dir).catch(() => []);
	for (const entry of entries) {
		const full = path.join(tmp_dir, entry);
		if (!is_strictly_inside(tmp_dir, full)) continue;
		await rm(full, { recursive: true, force: true }).catch((err: unknown) => log.warn(`failed to remove ${full}`, err));
	}
	if (entries.length > 0) log.info(`removed ${entries.length} temp file(s)`);
}

async function local_path(job: Job, source: ResolvedSource): Promise<{ file: string; temp: boolean }> {
	if (source.source === 'media') {
		const file = safe_media_path(media_dir, source.ref);
		if (!file) throw new JobError({ kind: 'bad_file', detail: `unsafe resource id ${source.ref}` });
		try {
			await access(file, constants.R_OK);
		} catch {
			throw new JobError({ kind: 'bad_file', detail: `media file missing: ${file}` });
		}
		return { file, temp: false };
	}
	const file = path.join(tmp_dir, `${job.track_id}.${randomUUID()}.${preview_extension(source.ref)}`);
	return { file, temp: true };
}

function to_failure(err: unknown, signal: AbortSignal): JobFailure {
	if (err instanceof JobError) return err.failure;
	if (signal.aborted || is_abort(err)) return { kind: 'timeout' };
	return { kind: 'internal', detail: err instanceof Error ? err.message : String(err) };
}

/** Runs one job. Returns true if the job was put back for a retry after the analyzer recovers. */
async function run_job(job: Job): Promise<boolean> {
	const source = await resolve_source(job.track_id, job.prefer);
	if (!source) return false;

	const signal = AbortSignal.timeout(config.ANALYZER_JOB_TIMEOUT_MS);
	let temp_file: string | null = null;
	try {
		const { file, temp } = await local_path(job, source);
		if (temp) {
			temp_file = file;
			await download_to(source.ref, file, signal);
		}
		const body = await call_analyze(config.ANALYZER_URL, file, signal);
		const row = map_analysis(job.track_id, body);
		if (!row) throw new JobError({ kind: 'analyzer_unavailable', detail: 'response breaks the contract', http_status: 200 });
		await save_sample(row, source);
		log.info(`analyzed ${job.track_id} (${source.source})`);
		return false;
	} catch (err) {
		const failure = to_failure(err, signal);
		if (failure.kind === 'analyzer_unavailable' && failure.http_status !== undefined) job.analyzer_5xx++;
		const decision = decide_failure(failure, next_attempts(source.prior, source.ref), job.analyzer_5xx);
		if (decision.action === 'retry_after_health') {
			log.warn(`analyzer unavailable for ${job.track_id}; pausing queue`, failure.detail);
			pause_until_healthy();
			queue.push_front(job);
			return true;
		}
		log.warn(`job ${job.track_id} (${source.source}) → ${decision.status}`, failure.detail ?? failure.kind);
		await record_lookup(db, job.track_id, source, decision.status, decision.retry_after);
		return false;
	} finally {
		// Deletion depends only on the job's source type; media files are never touched.
		if (temp_file && source.source === 'itunes_preview') await delete_temp_file(source.source, temp_file);
	}
}

async function worker_loop() {
	while (!stopping) {
		await wait_gate();
		if (stopping) break;
		const job = await queue.next();
		if (!job) break;
		await wait_gate();
		let requeued = false;
		try {
			if (stopping) continue;
			requeued = await run_job(job);
		} catch (err) {
			// DB failures while resolving or recording: drop the job; the startup backlog picks it up later.
			log.error(`job ${job.track_id} failed`, err);
		} finally {
			if (!requeued) queue.release(job.track_id);
		}
	}
}

/** Resolves symlinks of a path's existing ancestor so the dir-safety check can't be bypassed via links. */
async function real(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		const parent = path.dirname(p);
		return parent === p ? p : path.join(await real(parent), path.basename(p));
	}
}

export async function start(): Promise<void> {
	if (started) return;
	started = true;
	try {
		await start_inner();
	} catch (err) {
		started = false;
		throw err;
	}
}

async function start_inner() {
	stopping = false;
	stop_controller = new AbortController();
	queue.reopen();
	gate_pending = true;

	tmp_dir = path.resolve(config.ANALYZER_TMP_DIR);
	media_dir = path.resolve(config.MEDIA_DIR);
	assert_tmp_dir_safe(tmp_dir, media_dir);
	await mkdir(tmp_dir, { recursive: true });
	assert_tmp_dir_safe(await real(tmp_dir), await real(media_dir));
	if (!(await stat(tmp_dir)).isDirectory()) throw new Error(`ANALYZER_TMP_DIR ${tmp_dir} is not a directory`);
	await empty_tmp_dir();

	register_listeners();

	try {
		await rebuild_stale_vectors();
	} catch (err) {
		log.error('vector rebuild failed', err);
	}

	gate = wait_for_health().finally(() => { gate_pending = false; });
	workers = Array.from({ length: Math.max(1, Math.floor(config.ANALYZER_CONCURRENCY)) }, () => worker_loop());
	await gate;
	if (stopping) return;

	const backlog = await eligible_track_ids();
	for (const track_id of backlog) enqueue({ track_id });
	log.info(`queued ${backlog.length} track(s) from the backlog`);
}

/** Graceful shutdown: stop pulling jobs, let running jobs finish or time out, then clear temp files. */
export async function stop(): Promise<void> {
	if (!started) return;
	stopping = true;
	stop_controller.abort();
	queue.close();
	await Promise.allSettled(workers);
	workers = [];
	await empty_tmp_dir();
	started = false;
	log.info('analyzer queue stopped');
}

/** Queues analysis for tracks with an analyzable source and no sample/lookup record. */
export async function enqueue_if_needed(track_ids: readonly string[]): Promise<void> {
	if (track_ids.length === 0) return;
	const unqueued = [...new Set(track_ids)].filter(id => !queue.has(id));
	for (let i = 0; i < unqueued.length; i += 1000) {
		for (const track_id of await eligible_track_ids(unqueued.slice(i, i + 1000))) enqueue({ track_id });
	}
}
