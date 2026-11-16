import path from 'node:path';

export type SampleSource = 'itunes_preview' | 'media';
export type SampleLookupStatus = 'DONE' | 'BAD_FILE' | 'NOT_FOUND' | 'ERROR';

/** How a job ended when it didn't produce a sample. */
export type JobFailure
	/** Download returned 404/410 (or another non-retryable 4xx). */
	= | { kind: 'download_not_found'; detail?: string }
	/** Download kept failing with network errors / 5xx after every attempt. */
		| { kind: 'download_failed'; detail?: string }
	/** Analyzer said 400/422, the media file is missing, or the resource id is unsafe. */
		| { kind: 'bad_file'; detail?: string }
	/** Analyzer unreachable, 5xx, or a response that breaks the contract. */
		| { kind: 'analyzer_unavailable'; detail?: string; http_status?: number }
	/** The per-job timeout (download + analysis) fired. */
		| { kind: 'timeout'; detail?: string }
	/** Anything unexpected (database error, local I/O). */
		| { kind: 'internal'; detail?: string };

export type FailureDecision
	= | { action: 'record'; status: SampleLookupStatus; retry_after: Date | null }
	/** Pause the queue, wait for `/health`, then retry the same job. */
		| { action: 'retry_after_health' };

export const ERROR_RETRY_BASE_MS = 5 * 60_000;
export const ERROR_RETRY_MAX_MS = 24 * 60 * 60_000;
/**
 * A job that keeps getting an analyzer 5xx while `/health` is fine is recorded as ERROR after this
 * many tries, so one file that crashes the model can't stall the queue forever.
 */
export const MAX_ANALYZER_5XX_PER_JOB = 3;
export const DOWNLOAD_MAX_ATTEMPTS = 3;

/** Backoff for `ERROR` lookups: 5 min, 10, 20, ... capped at 24 h. `attempts` counts this attempt (1-based). */
export function error_retry_delay_ms(attempts: number): number {
	const exp = Math.max(0, attempts - 1);
	return Math.min(ERROR_RETRY_MAX_MS, ERROR_RETRY_BASE_MS * 2 ** Math.min(exp, 20));
}

/**
 * Maps a failure to its lookup record. `attempts` is the attempt count after this one,
 * `analyzer_5xx` how many analyzer 5xx responses this job has seen.
 */
export function decide_failure(failure: JobFailure, attempts: number, analyzer_5xx: number, now = new Date()): FailureDecision {
	const error = (): FailureDecision => ({ action: 'record', status: 'ERROR', retry_after: new Date(now.getTime() + error_retry_delay_ms(attempts)) });
	switch (failure.kind) {
		case 'download_not_found': return { action: 'record', status: 'NOT_FOUND', retry_after: null };
		case 'bad_file': return { action: 'record', status: 'BAD_FILE', retry_after: null };
		case 'download_failed': return error();
		case 'timeout': return error();
		case 'internal': return error();
		case 'analyzer_unavailable':
			return failure.http_status !== undefined && analyzer_5xx >= MAX_ANALYZER_5XX_PER_JOB ? error() : { action: 'retry_after_health' };
	}
}

export type DownloadStatusClass = 'ok' | 'not_found' | 'retry';

/** 2xx ok; 408/425/429/5xx retry with backoff; any other status means the resource is gone. */
export function classify_download_status(status: number): DownloadStatusClass {
	if (status >= 200 && status < 300) return 'ok';
	if (status >= 500 || status === 408 || status === 425 || status === 429) return 'retry';
	return 'not_found';
}

export type AnalyzerStatusClass = 'ok' | 'bad_file' | 'unavailable';

export function classify_analyzer_status(status: number): AnalyzerStatusClass {
	if (status >= 200 && status < 300) return 'ok';
	if (status === 400 || status === 422) return 'bad_file';
	return 'unavailable';
}

/** Download retry backoff inside one job: 1 s, 2 s, 4 s ... capped at 15 s. */
export function download_retry_delay_ms(attempt: number): number {
	return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** `/health` polling backoff: 1 s doubling to 30 s. */
export function health_backoff_ms(attempt: number): number {
	return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/** True if `child` is strictly inside `dir` (both resolved, no symlink resolution). */
export function is_strictly_inside(dir: string, child: string): boolean {
	const rel = path.relative(path.resolve(dir), path.resolve(child));
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The temp dir must be its own directory, not the media dir or inside it. The reverse
 * (media inside temp) is refused too, since temp is emptied on startup. Throws on violation.
 */
export function assert_tmp_dir_safe(tmp_dir: string, media_dir: string): void {
	const tmp = path.resolve(tmp_dir);
	const media = path.resolve(media_dir);
	if (tmp === media || is_strictly_inside(media, tmp) || is_strictly_inside(tmp, media)) {
		throw new Error(`ANALYZER_TMP_DIR (${tmp}) must be its own directory, not MEDIA_DIR (${media}) or nested with it`);
	}
	if (tmp === path.parse(tmp).root) throw new Error('ANALYZER_TMP_DIR must not be a filesystem root');
}

/**
 * Whether a job's file may be deleted. Deletion depends only on the job's source type; the
 * path check is an extra guard that refuses anything outside the temp dir.
 */
export function may_delete(file_path: string, tmp_dir: string): boolean {
	return is_strictly_inside(tmp_dir, file_path);
}

/** A media `resource_id` must be a plain file name inside MEDIA_DIR (it's a UUID). */
export function safe_media_path(media_dir: string, resource_id: string): string | null {
	if (!resource_id || resource_id === '.' || resource_id === '..' || /[/\\\0]/.test(resource_id)) return null;
	const full = path.resolve(media_dir, resource_id);
	return is_strictly_inside(media_dir, full) ? full : null;
}

/** File extension for a downloaded preview, from the URL path; defaults to `m4a`. */
export function preview_extension(url: string): string {
	try {
		const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
		return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'm4a';
	} catch {
		return 'm4a';
	}
}

export interface LookupState { status: SampleLookupStatus; retry_after: Date | null; source_ref: string | null }

/**
 * Whether a source may be tried given its lookup record. BAD_FILE/NOT_FOUND block until the
 * source changes (different `source_ref`); ERROR blocks until `retry_after`.
 */
export function source_eligible(lookup: LookupState | null | undefined, current_ref: string, now = new Date()): boolean {
	if (!lookup) return true;
	switch (lookup.status) {
		case 'DONE':
		case 'BAD_FILE':
		case 'NOT_FOUND':
			return lookup.source_ref !== current_ref;
		case 'ERROR':
			return lookup.source_ref !== current_ref || lookup.retry_after === null || lookup.retry_after.getTime() <= now.getTime();
	}
}

/** Attempt count to store: continues the existing record for the same source ref, otherwise starts at 1. */
export function next_attempts(prior: { attempts: number; source_ref: string | null } | null | undefined, ref: string): number {
	return prior?.source_ref === ref ? prior.attempts + 1 : 1;
}

export interface SourceCandidate { source: SampleSource; ref: string }

/**
 * Picks the source to analyze: the trigger's preferred source first, then media (a full local
 * file, no download), then the iTunes preview; the first one its lookup record allows.
 */
export function choose_source<C extends SourceCandidate>(candidates: readonly C[], lookups: ReadonlyMap<SampleSource, LookupState>, prefer?: SampleSource, now = new Date()): C | null {
	const rank = (c: C) => (c.source === prefer ? 0 : c.source === 'media' ? 1 : 2);
	const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
	return ordered.find(c => source_eligible(lookups.get(c.source), c.ref, now)) ?? null;
}
