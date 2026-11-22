import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config';
import { HttpError } from '../../core/http';
import type { AudioKind } from './sniff';
import { MIME_BY_EXT } from './sniff';

export const M4A_KIND: AudioKind = { ext: 'm4a', mime: MIME_BY_EXT.m4a };

const STDERR_TAIL_BYTES = 2048;

class ProcessError extends Error {
	constructor(message: string, public timed_out: boolean) {
		super(message);
	}
}

/** Niceness for ffmpeg/ffprobe, so encodes yield the CPU to the API and the database. */
const NICENESS = '10';

/**
 * Runs a binary at lower CPU priority and resolves with its stdout; rejects with the tail of stderr on a non-zero
 * exit or timeout.
 */
function run(cmd: string, args: readonly string[], timeout_ms: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('nice', ['-n', NICENESS, cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timed_out = false;
		const timer = setTimeout(() => {
			timed_out = true;
			child.kill('SIGKILL');
		}, timeout_ms);
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES); });
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0 && !timed_out) resolve(stdout);
			else reject(new ProcessError(timed_out ? `${cmd} timed out` : `${cmd} exited with ${code}: ${stderr.trim()}`, timed_out));
		});
	});
}

let active = 0;
const waiting: (() => void)[] = [];

/** Bounds how many ffmpeg processes run at once; the rest queue in arrival order. */
async function with_slot<T>(task: () => Promise<T>): Promise<T> {
	if (active >= Math.max(1, Math.floor(config.MEDIA_TRANSCODE_CONCURRENCY))) await new Promise<void>(resolve => waiting.push(resolve));
	else active++;
	try {
		return await task();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else active--;
	}
}

/** Codec of the first audio stream, or null when ffprobe finds none. */
async function audio_codec(input: string): Promise<string | null> {
	const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', input], config.MEDIA_TRANSCODE_TIMEOUT_MS);
	return out.trim() || null;
}

/**
 * Converts an upload to AAC in an `.m4a` container next to it and returns the new path. AAC input is remuxed
 * without re-encoding (a second lossy pass only loses quality); everything else is encoded at MEDIA_AAC_BITRATE.
 * Cover art and other non-audio streams are dropped, and the index is moved to the front so ranged playback can
 * start before the whole file is fetched. Undecodable input is a 422; the caller owns the input file.
 */
export async function transcode_to_m4a(input: string, out_dir: string): Promise<string> {
	const output = path.join(out_dir, `${randomUUID()}.m4a.part`);
	try {
		await with_slot(async () => {
			const codec = await audio_codec(input);
			if (codec === null) throw new HttpError(422, 'no audio stream found');
			const encode = codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', config.MEDIA_AAC_BITRATE];
			await run('ffmpeg', [
				'-nostdin', '-hide_banner', '-loglevel', 'error',
				'-i', input,
				'-map', '0:a:0', ...encode,
				'-movflags', '+faststart', '-f', 'mp4', output
			], config.MEDIA_TRANSCODE_TIMEOUT_MS);
		});
		return output;
	} catch (err) {
		await rm(output, { force: true });
		if (err instanceof ProcessError) {
			if (err.timed_out) throw new HttpError(503, 'transcoding timed out');
			throw new HttpError(422, 'could not decode audio', { detail: err.message });
		}
		throw err;
	}
}

/**
 * Re-encodes an uploaded image as a baseline JPEG, or a WebP that keeps transparency, no larger than `max_px` on either
 * side (never upscaled), dropping every metadata block (EXIF GPS included). Undecodable input is a 422; the caller
 * owns both files.
 */
export async function normalize_image(input: string, output: string, max_px: number, format: 'jpeg' | 'webp' = 'jpeg'): Promise<void> {
	const px = String(Math.max(16, Math.floor(max_px)));
	const scale = `scale=w='min(${px},iw)':h='min(${px},ih)':force_original_aspect_ratio=decrease`;
	const encode = format === 'jpeg'
		? ['-vf', `${scale},format=yuvj420p`, '-q:v', '3', '-c:v', 'mjpeg', '-f', 'image2', '-update', '1']
		: ['-vf', `${scale},format=yuva420p`, '-quality', '80', '-c:v', 'libwebp', '-f', 'webp'];
	try {
		await with_slot(async () => {
			await run('ffmpeg', [
				'-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
				'-i', input,
				'-map', '0:v:0', '-frames:v', '1', '-map_metadata', '-1',
				...encode, output
			], config.MEDIA_TRANSCODE_TIMEOUT_MS);
		});
	} catch (err) {
		await rm(output, { force: true });
		if (err instanceof ProcessError) {
			if (err.timed_out) throw new HttpError(503, 'image processing timed out');
			throw new HttpError(422, 'could not decode image', { detail: err.message });
		}
		throw err;
	}
}
