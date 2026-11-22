import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call_analyze, check_health, download_to, is_abort, JobError, sleep } from './client';
import type { JobFailure } from './decisions';

const fetch_mock = vi.fn();
const signal = () => new AbortController().signal;

async function failure_of(p: Promise<unknown>): Promise<JobFailure> {
	try {
		await p;
	} catch (err) {
		if (err instanceof JobError) return err.failure;
		throw err;
	}
	throw new Error('did not reject');
}

beforeEach(() => {
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('JobError / is_abort', () => {
	it('describes the failure in its message', () => {
		expect(new JobError({ kind: 'timeout' }).message).toBe('timeout');
		expect(new JobError({ kind: 'bad_file', detail: 'x' }).message).toBe('bad_file: x');
	});
	it('recognises abort and timeout errors only', () => {
		expect(is_abort(new DOMException('x', 'AbortError'))).toBe(true);
		expect(is_abort(new DOMException('x', 'TimeoutError'))).toBe(true);
		expect(is_abort(new Error('x'))).toBe(false);
		expect(is_abort('AbortError')).toBe(false);
	});
});

describe('sleep', () => {
	it('resolves after the delay', async () => {
		vi.useFakeTimers();
		let done = false;
		const p = sleep(1000).then(() => { done = true; });
		await vi.advanceTimersByTimeAsync(999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(done).toBe(true);
	});
	it('resolves immediately when already aborted', async () => {
		const c = new AbortController();
		c.abort();
		await expect(sleep(60_000, c.signal)).resolves.toBeUndefined();
	});
	it('resolves early when aborted meanwhile', async () => {
		const c = new AbortController();
		const p = sleep(60_000, c.signal);
		c.abort();
		await expect(p).resolves.toBeUndefined();
	});
});

describe('check_health', () => {
	it('is true for 200 and calls /health', async () => {
		fetch_mock.mockResolvedValue(new Response('ok', { status: 200 }));
		expect(await check_health('http://an:1234/base', signal())).toBe(true);
		expect(String(fetch_mock.mock.calls[0][0])).toBe('http://an:1234/health');
	});
	it('works without a signal', async () => {
		fetch_mock.mockResolvedValue(new Response('ok', { status: 200 }));
		expect(await check_health('http://an:1234')).toBe(true);
	});
	it('is false for other statuses and network errors', async () => {
		fetch_mock.mockResolvedValueOnce(new Response('', { status: 503 }));
		expect(await check_health('http://an:1234')).toBe(false);
		fetch_mock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		expect(await check_health('http://an:1234')).toBe(false);
	});
});

describe('call_analyze', () => {
	it('posts the path and returns the parsed body', async () => {
		fetch_mock.mockResolvedValue(new Response('{"mood":"x"}', { status: 200 }));
		await expect(call_analyze('http://an:1', '/m/a.mp3', signal())).resolves.toEqual({ mood: 'x' });
		const [url, init] = fetch_mock.mock.calls[0];
		expect(String(url)).toBe('http://an:1/analyze');
		expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ path: '/m/a.mp3' }) });
	});
	it('has no response-header deadline of its own, through the real fetch', async () => {
		fetch_mock.mockResolvedValue(new Response('{}', { status: 200 }));
		await call_analyze('http://an:1', 'f', signal());
		expect(fetch_mock.mock.calls[0][1]).toHaveProperty('dispatcher');
		vi.unstubAllGlobals();
		const server = createServer((req, res) => {
			let body = '';
			req.on('data', (c: Buffer) => { body += c; });
			req.on('end', () => setTimeout(() => res.end(JSON.stringify({ echo: JSON.parse(body).path })), 50));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const { port } = server.address() as AddressInfo;
			await expect(call_analyze(`http://127.0.0.1:${port}`, '/m/a.mp3', signal(), '/alignment')).resolves.toEqual({ echo: '/m/a.mp3' });
		} finally {
			await new Promise(resolve => server.close(resolve));
		}
	});
	it('can target /vocals', async () => {
		fetch_mock.mockResolvedValue(new Response('{}', { status: 200 }));
		await call_analyze('http://an:1', '/m/a.mp3', signal(), '/vocals');
		expect(String(fetch_mock.mock.calls[0][0])).toBe('http://an:1/vocals');
	});
	it('maps 400/422 to bad_file with a truncated body', async () => {
		fetch_mock.mockResolvedValue(new Response('y'.repeat(500), { status: 422 }));
		const f = await failure_of(call_analyze('http://an:1', 'f', signal()));
		expect(f.kind).toBe('bad_file');
		expect(f.detail).toBe(`analyzer 422: ${'y'.repeat(200)}`);
	});
	it('maps 5xx to analyzer_unavailable with the status', async () => {
		fetch_mock.mockResolvedValue(new Response('down', { status: 503 }));
		expect(await failure_of(call_analyze('http://an:1', 'f', signal()))).toMatchObject({ kind: 'analyzer_unavailable', http_status: 503 });
	});
	it('treats an unparseable 200 as analyzer_unavailable', async () => {
		fetch_mock.mockResolvedValue(new Response('<html>', { status: 200 }));
		expect(await failure_of(call_analyze('http://an:1', 'f', signal()))).toEqual({ kind: 'analyzer_unavailable', detail: 'invalid JSON', http_status: 200 });
	});
	it('maps network errors to analyzer_unavailable without a status', async () => {
		fetch_mock.mockRejectedValue(new Error('ECONNREFUSED'));
		expect(await failure_of(call_analyze('http://an:1', 'f', signal()))).toEqual({ kind: 'analyzer_unavailable', detail: 'ECONNREFUSED' });
		fetch_mock.mockRejectedValue('weird');
		expect(await failure_of(call_analyze('http://an:1', 'f', signal()))).toEqual({ kind: 'analyzer_unavailable', detail: 'weird' });
	});
	it('rethrows aborts untouched', async () => {
		const abort = new DOMException('aborted', 'AbortError');
		fetch_mock.mockRejectedValue(abort);
		await expect(call_analyze('http://an:1', 'f', signal())).rejects.toBe(abort);
	});
});

describe('download_to', () => {
	let dir: string;
	let dest: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), 'illusi-dl-'));
		dest = path.join(dir, 'out.m4a');
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	it('streams the body to the destination', async () => {
		fetch_mock.mockResolvedValue(new Response('audio-bytes', { status: 200 }));
		await download_to('http://x/p.m4a', dest, signal());
		expect(await readFile(dest, 'utf8')).toBe('audio-bytes');
	});
	it('maps 404 to download_not_found without retrying', async () => {
		fetch_mock.mockResolvedValue(new Response('', { status: 404 }));
		expect(await failure_of(download_to('http://x', dest, signal()))).toEqual({ kind: 'download_not_found', detail: 'HTTP 404' });
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
	it('rejects a declared size over the limit', async () => {
		fetch_mock.mockResolvedValue(new Response('x', { status: 200, headers: { 'content-length': String(60 * 1024 * 1024) } }));
		expect(await failure_of(download_to('http://x', dest, signal()))).toMatchObject({ kind: 'bad_file', detail: expect.stringContaining('too large') });
	});
	it('retries 5xx and network errors, then succeeds', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		fetch_mock.mockResolvedValueOnce(new Response('', { status: 502 })).mockRejectedValueOnce(new Error('reset')).mockResolvedValueOnce(new Response('ok', { status: 200 }));
		const p = download_to('http://x', dest, signal());
		await vi.advanceTimersByTimeAsync(10_000);
		await p;
		expect(fetch_mock).toHaveBeenCalledTimes(3);
		expect(await readFile(dest, 'utf8')).toBe('ok');
	});
	it('gives up with download_failed after the last attempt', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		fetch_mock.mockResolvedValue(new Response('', { status: 503 }));
		const p = failure_of(download_to('http://x', dest, signal()));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await p).toEqual({ kind: 'download_failed', detail: 'HTTP 503' });
		expect(fetch_mock).toHaveBeenCalledTimes(3);
	});
	it('reports a non-Error network failure in the detail', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		fetch_mock.mockRejectedValue('nope');
		const p = failure_of(download_to('http://x', dest, signal()));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await p).toEqual({ kind: 'download_failed', detail: 'nope' });
	});
	it('retries a response without a body', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		fetch_mock.mockResolvedValue(new Response(null, { status: 204 }));
		const p = failure_of(download_to('http://x', dest, signal()));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await p).toEqual({ kind: 'download_failed', detail: 'HTTP 204' });
	});
	it('rethrows an abort without retrying', async () => {
		const abort = new DOMException('aborted', 'AbortError');
		fetch_mock.mockRejectedValue(abort);
		await expect(download_to('http://x', dest, signal())).rejects.toBe(abort);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
	it('throws the abort reason when aborted during the retry wait', async () => {
		const c = new AbortController();
		fetch_mock.mockImplementation(async () => {
			c.abort(new Error('job timeout'));
			return new Response('', { status: 500 });
		});
		await expect(download_to('http://x', dest, c.signal)).rejects.toThrow('job timeout');
	});
});
