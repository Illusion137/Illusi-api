import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { JobFailure } from './decisions';
import { classify_analyzer_status, classify_download_status, DOWNLOAD_MAX_ATTEMPTS, download_retry_delay_ms } from './decisions';

/** Thrown by job steps; carries the failure classification. */
export class JobError extends Error {
	constructor(readonly failure: JobFailure) {
		super(`${failure.kind}${failure.detail ? `: ${failure.detail}` : ''}`);
	}
}

const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

export const is_abort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Abortable sleep; resolves early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

export async function check_health(base_url: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(new URL('/health', base_url), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
		await res.body?.cancel();
		return res.status === 200;
	} catch {
		return false;
	}
}

/** `POST /analyze` or `/vocals`. Returns the parsed JSON body; throws `JobError` on failure, rethrows aborts. */
export async function call_analyze(base_url: string, file_path: string, signal: AbortSignal, endpoint: '/analyze' | '/vocals' | '/alignment' = '/analyze'): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(new URL(endpoint, base_url), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: file_path }),
			signal
		});
	} catch (err) {
		if (is_abort(err)) throw err;
		throw new JobError({ kind: 'analyzer_unavailable', detail: err instanceof Error ? err.message : String(err) });
	}
	const text = await res.text();
	switch (classify_analyzer_status(res.status)) {
		case 'ok':
			try {
				return JSON.parse(text);
			} catch {
				throw new JobError({ kind: 'analyzer_unavailable', detail: 'invalid JSON', http_status: res.status });
			}
		case 'bad_file':
			throw new JobError({ kind: 'bad_file', detail: `analyzer ${res.status}: ${text.slice(0, 200)}` });
		case 'unavailable':
			throw new JobError({ kind: 'analyzer_unavailable', detail: `analyzer ${res.status}: ${text.slice(0, 200)}`, http_status: res.status });
	}
}

/**
 * Downloads `url` to `dest` with retries on network errors / 5xx. Throws `JobError`
 * (`download_not_found` / `download_failed`) or rethrows aborts. A partial file is left for the job's guarded cleanup.
 */
export async function download_to(url: string, dest: string, signal: AbortSignal): Promise<void> {
	let last = '';
	for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(url, { signal, redirect: 'follow' });
			const cls = classify_download_status(res.status);
			if (cls === 'not_found') {
				await res.body?.cancel();
				throw new JobError({ kind: 'download_not_found', detail: `HTTP ${res.status}` });
			}
			if (cls === 'retry' || !res.body) {
				await res.body?.cancel();
				last = `HTTP ${res.status}`;
			} else {
				const length = Number(res.headers.get('content-length'));
				if (length > MAX_PREVIEW_BYTES) {
					await res.body.cancel();
					throw new JobError({ kind: 'bad_file', detail: `preview too large (${length} bytes)` });
				}
				let bytes = 0;
				const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
				body.on('data', (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_PREVIEW_BYTES) body.destroy(new JobError({ kind: 'bad_file', detail: 'preview too large' }));
				});
				await pipeline(body, createWriteStream(dest), { signal });
				return;
			}
		} catch (err) {
			if (err instanceof JobError || is_abort(err) || signal.aborted) throw err;
			last = err instanceof Error ? err.message : String(err);
		}
		if (attempt < DOWNLOAD_MAX_ATTEMPTS) await sleep(download_retry_delay_ms(attempt), signal);
		if (signal.aborted) throw signal.reason;
	}
	throw new JobError({ kind: 'download_failed', detail: last });
}
