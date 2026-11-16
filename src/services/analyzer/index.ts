import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config';
import { db } from '../../db';
import { on } from '../../core/events';
import { logger } from '../../core/log';
import { remote_media_url } from '../media/remote';
import { rebuild_stale_vectors } from '../vectors';
import { call_analyze, check_health, download_to, is_abort, JobError, sleep } from './client';
import { map_alignment, map_analysis, map_vocals } from './contract';
import type { JobFailure, SampleLookupStatus, SampleSource } from './decisions';
import { assert_tmp_dir_safe, decide_failure, health_backoff_ms, is_strictly_inside, may_delete, next_attempts, preview_extension, safe_media_path } from './decisions';
import { JobQueue } from './queue';
import type { ResolvedSource, TrackPriority } from './repo';
import { eligible_alignment_track_ids, eligible_track_ids, eligible_vocals_track_ids, outdated_sample_track_ids, record_alignment, record_lookup, record_vocals, resolve_alignment_target, resolve_source, resolve_vocals_target, save_sample, track_priorities } from './repo';

const log = logger('analyzer');

interface Job {
	/**
	 * `sample`: `/analyze` on media or an iTunes preview, for every track. `vocals`: `/vocals`, on full media files of
	 * tracks whose lyrics are all unsynced. `alignment`: `/alignment`, minutes of CPU, only on those that users play.
	 */
	kind: 'sample' | 'vocals' | 'alignment';
	track_id: string;
	/** Source named by the live trigger, tried first. */
	prefer?: SampleSource;
	/** `sample`: analyze again because the stored sample is from an older analyzer. */
	upgrade?: boolean;
	/** `alignment`: a user is playing the track right now (their play may not be synced yet). */
	requested?: boolean;
	/** Analyzer 5xx responses seen by this job. */
	analyzer_5xx: number;
	priority: TrackPriority;
}

type NewJob = Omit<Job, 'analyzer_5xx' | 'priority'>;

/** Failures of the analysis itself (reported to Sentry with the file path); download problems are only logged. */
const ANALYZER_FAILURES = new Set<JobFailure['kind']>(['bad_file', 'analyzer_unavailable', 'timeout', 'internal']);

const job_key = (job: Pick<Job, 'kind' | 'track_id'>) => `${job.kind}:${job.track_id}`;
/**
 * Tracks a user is playing right now first, then the most played by Illusi users, then the most played on streaming
 * services; refreshing old samples comes last.
 */
function job_order(a: Job, b: Job): number {
	return Number(a.upgrade ?? false) - Number(b.upgrade ?? false) || Number(b.requested ?? false) - Number(a.requested ?? false)
		|| b.priority.plays - a.priority.plays || b.priority.views - a.priority.views;
}
const queue = new JobQueue<Job>(job_key, job_order);
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

/** Queues jobs by their tracks' priorities; a job whose track is already queued for the same kind is dropped. */
async function enqueue(jobs: readonly NewJob[]): Promise<number> {
	const fresh = jobs.filter(job => !queue.has(job_key(job)));
	if (fresh.length === 0) return 0;
	const priorities = await track_priorities(fresh.map(job => job.track_id));
	let queued = 0;
	for (const job of fresh) {
		if (!queue.push({ ...job, analyzer_5xx: 0, priority: priorities.get(job.track_id) ?? { plays: 0, views: 0 } })) continue;
		queued++;
		log.debug(`queued ${job.kind} ${job.track_id}`, job.prefer);
	}
	return queued;
}

function register_listeners() {
	if (listeners_registered) return;
	listeners_registered = true;
	on('itunes_track_linked', async ({ track_id, preview_url }) => {
		if (preview_url) await enqueue([{ kind: 'sample', track_id, prefer: 'itunes_preview' }]);
	});
	on('media_inserted', async ({ track_id }) => {
		await enqueue([{ kind: 'sample', track_id, prefer: 'media' }, { kind: 'vocals', track_id }, { kind: 'alignment', track_id }]);
	});
	// The vocals and alignment jobs themselves check that the lyrics are all unsynced (and alignment, that users play it)
	on('lyrics_stored', async ({ track_id }) => {
		await enqueue([{ kind: 'vocals', track_id }, { kind: 'alignment', track_id }]);
	});
	// A job already queued from the backlog or an event is moved ahead and no longer needs a synced play
	on('alignment_requested', async ({ track_id }) => {
		if (queue.update(job_key({ kind: 'alignment', track_id }), (job) => { job.requested = true; })) return;
		await enqueue([{ kind: 'alignment', track_id, requested: true }]);
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

/** Deletes a job's downloads (previews, media copies from the bucket). Refuses anything outside ANALYZER_TMP_DIR. */
async function delete_temp_files(files: readonly string[]) {
	for (const file_path of files) {
		/* v8 ignore start: defence in depth; temp files are always created inside tmp_dir */
		if (!may_delete(file_path, tmp_dir)) {
			log.error(`refusing to delete ${file_path}`);
			continue;
		}
		/* v8 ignore stop */
		await unlink(file_path).catch((err: unknown) => {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`failed to delete ${file_path}`, err);
		});
	}
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

const temp_path = (job: Job, ext: string) => path.join(tmp_dir, `${job.track_id}.${randomUUID()}.${ext}`);

/**
 * The media file to analyze: the local one, or once scripts/backup-media.sh moved it to the media bucket, a download
 * of it into ANALYZER_TMP_DIR (added to `temps`).
 */
async function media_file(job: Job, resource_id: string, signal: AbortSignal, temps: string[]): Promise<string> {
	const file = safe_media_path(media_dir, resource_id);
	if (!file) throw new JobError({ kind: 'bad_file', detail: `unsafe resource id ${resource_id}` });
	try {
		await access(file, constants.R_OK);
		return file;
	} catch {
		const remote = remote_media_url(resource_id);
		if (!remote) throw new JobError({ kind: 'bad_file', detail: `media file missing: ${file}` });
		const temp = temp_path(job, path.extname(resource_id).slice(1));
		temps.push(temp);
		await download_to(remote, temp, signal, config.MEDIA_MAX_BYTES);
		return temp;
	}
}

/** The file to analyze for a sample: the media file, or the downloaded iTunes preview (added to `temps`). */
async function local_path(job: Job, source: ResolvedSource, signal: AbortSignal, temps: string[]): Promise<string> {
	if (source.source === 'media') return media_file(job, source.ref, signal, temps);
	const file = temp_path(job, preview_extension(source.ref));
	temps.push(file);
	await download_to(source.ref, file, signal);
	return file;
}

function to_failure(err: unknown, signal: AbortSignal): JobFailure {
	if (err instanceof JobError) return err.failure;
	if (signal.aborted || is_abort(err)) return { kind: 'timeout' };
	return { kind: 'internal', detail: err instanceof Error ? err.message : String(err) };
}

/** Handles a failed job: puts it back behind the health gate (returns true), or records the outcome with `record`. */
async function handle_failure(job: Job, err: unknown, signal: AbortSignal, where: { source: SampleSource; path: string }, attempts: number,
	record: (status: SampleLookupStatus, retry_after: Date | null) => Promise<void>): Promise<boolean> {
	const failure = to_failure(err, signal);
	if (failure.kind === 'analyzer_unavailable' && failure.http_status !== undefined) job.analyzer_5xx++;
	const decision = decide_failure(failure, attempts, job.analyzer_5xx);
	const report = { track_id: job.track_id, job: job.kind, ...where, kind: failure.kind, detail: failure.detail };
	if (decision.action === 'retry_after_health') {
		// Once per outage: the jobs that pile up behind the paused queue aren't separate failures.
		if (gate_pending) log.warn(`analyzer unavailable for ${job.kind} ${job.track_id}; queue already paused`, failure.detail);
		else log.error('analyzer unavailable; pausing queue', report);
		pause_until_healthy();
		queue.push_front(job);
		return true;
	}
	const what = job.kind === 'vocals' ? 'vocal detection' : job.kind === 'alignment' ? 'alignment analysis' : 'analysis';
	if (ANALYZER_FAILURES.has(failure.kind)) log.error(`${what} failed (${failure.kind})`, { ...report, status: decision.status });
	else log.warn(`${job.kind} job ${job.track_id} (${where.source}) → ${decision.status}`, failure.detail ?? failure.kind);
	await record(decision.status, decision.retry_after);
	return false;
}

/** Runs one job. Returns true if the job was put back for a retry after the analyzer recovers. */
function run_job(job: Job): Promise<boolean> {
	if (job.kind === 'alignment') return run_alignment_job(job);
	return job.kind === 'vocals' ? run_vocals_job(job) : run_sample_job(job);
}

async function run_alignment_job(job: Job): Promise<boolean> {
	const target = await resolve_alignment_target(job.track_id, job.requested);
	if (!target) return false;

	const signal = AbortSignal.timeout(config.ANALYZER_ALIGNMENT_TIMEOUT_MS);
	const temps: string[] = [];
	let file_path: string | null = null;
	try {
		file_path = await media_file(job, target.resource_id, signal, temps);
		const result = map_alignment(await call_analyze(config.ANALYZER_URL, file_path, signal, '/alignment'));
		if (!result) throw new JobError({ kind: 'analyzer_unavailable', detail: 'response breaks the contract', http_status: 200 });
		await record_alignment(job.track_id, target, 'DONE', null, result);
		log.info(`aligned ${job.track_id}: ${result.loudness.length} frame(s), ${result.words.length} word(s), ${result.repeat_strengths.length} repeat(s)`);
		return false;
	} catch (err) {
		return handle_failure(job, err, signal, { source: 'media', path: file_path ?? target.resource_id }, next_attempts(target.prior, target.resource_id),
			(status, retry_after) => record_alignment(job.track_id, target, status, retry_after, null));
	} finally {
		await delete_temp_files(temps);
	}
}

async function run_vocals_job(job: Job): Promise<boolean> {
	const target = await resolve_vocals_target(job.track_id);
	if (!target) return false;

	const signal = AbortSignal.timeout(config.ANALYZER_JOB_TIMEOUT_MS);
	const temps: string[] = [];
	let file_path: string | null = null;
	try {
		file_path = await media_file(job, target.resource_id, signal, temps);
		const result = map_vocals(await call_analyze(config.ANALYZER_URL, file_path, signal, '/vocals'));
		if (!result) throw new JobError({ kind: 'analyzer_unavailable', detail: 'response breaks the contract', http_status: 200 });
		await record_vocals(job.track_id, target, 'DONE', null, result);
		log.info(`detected vocals in ${job.track_id}: ${result.segments.length / 2} segment(s), ${result.beats?.length ?? 0} beat(s), ${result.words?.length ?? 0} word(s)`);
		return false;
	} catch (err) {
		return handle_failure(job, err, signal, { source: 'media', path: file_path ?? target.resource_id }, next_attempts(target.prior, target.resource_id),
			(status, retry_after) => record_vocals(job.track_id, target, status, retry_after, null));
	} finally {
		await delete_temp_files(temps);
	}
}

async function run_sample_job(job: Job): Promise<boolean> {
	const source = await resolve_source(job.track_id, job.prefer, job.upgrade);
	if (!source) return false;

	const signal = AbortSignal.timeout(config.ANALYZER_JOB_TIMEOUT_MS);
	const temps: string[] = [];
	let file_path: string | null = null;
	try {
		const file = await local_path(job, source, signal, temps);
		file_path = file;
		const body = await call_analyze(config.ANALYZER_URL, file, signal);
		const row = map_analysis(job.track_id, body);
		if (!row) throw new JobError({ kind: 'analyzer_unavailable', detail: 'response breaks the contract', http_status: 200 });
		await save_sample(row, source);
		log.info(`analyzed ${job.track_id} (${source.source})`);
		return false;
	} catch (err) {
		return await handle_failure(job, err, signal, { source: source.source, path: file_path ?? source.ref }, next_attempts(source.prior, source.ref),
			(status, retry_after) => record_lookup(db, job.track_id, source, status, retry_after));
	} finally {
		// Only downloads inside ANALYZER_TMP_DIR; media files are never touched.
		await delete_temp_files(temps);
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
			if (!requeued) queue.release(job_key(job));
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
	const vocals_backlog = await eligible_vocals_track_ids();
	const alignment_backlog = await eligible_alignment_track_ids();
	const outdated = await outdated_sample_track_ids();
	await enqueue([
		...backlog.map((track_id): NewJob => ({ kind: 'sample', track_id })),
		...vocals_backlog.map((track_id): NewJob => ({ kind: 'vocals', track_id })),
		...alignment_backlog.map((track_id): NewJob => ({ kind: 'alignment', track_id })),
		...outdated.map((track_id): NewJob => ({ kind: 'sample', track_id, upgrade: true }))
	]);
	log.info(`queued ${backlog.length} sample, ${vocals_backlog.length} vocals, ${alignment_backlog.length} alignment and ${outdated.length} sample refresh job(s) from the backlog`);
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
	const unqueued = [...new Set(track_ids)].filter(id => !queue.has(job_key({ kind: 'sample', track_id: id })));
	for (let i = 0; i < unqueued.length; i += 1000) {
		await enqueue((await eligible_track_ids(unqueued.slice(i, i + 1000))).map((track_id): NewJob => ({ kind: 'sample', track_id })));
	}
}
