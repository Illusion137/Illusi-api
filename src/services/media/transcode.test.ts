import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../core/http';
import { sniff_audio } from './sniff';
import { config } from '../../config';
import { normalize_image, transcode_to_m4a } from './transcode';

const has_ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function probe(file: string): { codec: string; bit_rate: number } {
	const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bit_rate', '-of', 'json', file], { encoding: 'utf8' });
	const stream = (JSON.parse(out) as { streams: { codec_name: string; bit_rate: string }[] }).streams[0];
	return { codec: stream.codec_name, bit_rate: Number(stream.bit_rate) };
}

describe.skipIf(!has_ffmpeg)('transcode_to_m4a', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'illusi-transcode-'));
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	/** Two seconds of a stereo tone, encoded by ffmpeg with the given codec arguments. */
	function tone(name: string, codec: string[]): string {
		const file = path.join(dir, name);
		execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', ...codec, file]);
		return file;
	}

	it('encodes lossless input to AAC at the configured bitrate', async () => {
		const out = await transcode_to_m4a(tone('in.flac', ['-c:a', 'flac']), dir);
		expect(sniff_audio(readFileSync(out))?.ext).toBe('m4a');
		const { codec, bit_rate } = probe(out);
		expect(codec).toBe('aac');
		expect(bit_rate).toBeGreaterThan(128_000);
	});

	it('remuxes AAC without re-encoding', async () => {
		const input = tone('in.aac', ['-c:a', 'aac', '-b:a', '96k', '-f', 'adts']);
		const out = await transcode_to_m4a(input, dir);
		expect(sniff_audio(readFileSync(out))?.ext).toBe('m4a');
		const { codec, bit_rate } = probe(out);
		expect(codec).toBe('aac');
		expect(bit_rate).toBeLessThan(128_000);
	});

	it('drops cover art and keeps the index at the front', async () => {
		const input = path.join(dir, 'with_art.mp3');
		execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y',
			'-f', 'lavfi', '-i', 'sine=duration=2', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1',
			'-map', '0:a', '-map', '1:v', '-frames:v', '1', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', input]);
		const out = await transcode_to_m4a(input, dir);
		const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim().split('\n');
		expect(streams).toEqual(['audio']);
		const bytes = readFileSync(out);
		expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
	});

	it('rejects undecodable input with a 422 and leaves nothing behind', async () => {
		const junk = path.join(dir, 'junk.mp3');
		writeFileSync(junk, Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x64]), Buffer.alloc(4096, 7)]));
		const sub = mkdtempSync(path.join(dir, 'out-'));
		const err: unknown = await transcode_to_m4a(junk, sub).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HttpError);
		expect((err as HttpError).status).toBe(422);
		expect(execFileSync('ls', ['-A', sub], { encoding: 'utf8' })).toBe('');
	});

	describe('limits and errors', () => {
		const original = { timeout: config.MEDIA_TRANSCODE_TIMEOUT_MS, concurrency: config.MEDIA_TRANSCODE_CONCURRENCY };
		afterEach(() => {
			config.MEDIA_TRANSCODE_TIMEOUT_MS = original.timeout;
			config.MEDIA_TRANSCODE_CONCURRENCY = original.concurrency;
		});

		it('queues work beyond the concurrency limit and finishes all of it', async () => {
			config.MEDIA_TRANSCODE_CONCURRENCY = 1;
			const input = tone('queue.flac', ['-c:a', 'flac']);
			const outs = await Promise.all([1, 2, 3].map(async () => transcode_to_m4a(input, dir)));
			expect(new Set(outs).size).toBe(3);
			for (const out of outs) expect(sniff_audio(readFileSync(out))?.ext).toBe('m4a');
		});

		it('answers 503 when the encoder times out and removes the partial output', async () => {
			config.MEDIA_TRANSCODE_TIMEOUT_MS = 1;
			const sub = mkdtempSync(path.join(dir, 'timeout-'));
			const err: unknown = await transcode_to_m4a(tone('slow.flac', ['-c:a', 'flac']), sub).catch((e: unknown) => e);
			expect(err).toMatchObject({ status: 503 });
			expect(execFileSync('ls', ['-A', sub], { encoding: 'utf8' })).toBe('');
		});

		it('answers 422 when the file has no audio stream', async () => {
			const input = path.join(dir, 'video_only.mp4');
			execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-c:v', 'mpeg4', input]);
			const err: unknown = await transcode_to_m4a(input, dir).catch((e: unknown) => e);
			expect(err).toMatchObject({ status: 422, message: 'no audio stream found' });
		});
	});
});

describe.skipIf(!has_ffmpeg)('normalize_image', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'illusi-image-'));
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	function dimensions(file: string): string {
		return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' }).trim();
	}

	it('shrinks large images to a JPEG within the limit and never upscales', async () => {
		const big = path.join(dir, 'big.png');
		const small = path.join(dir, 'small.png');
		execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=400x200:d=1', '-frames:v', '1', big]);
		execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x32:d=1', '-frames:v', '1', small]);
		const out_big = path.join(dir, 'big.jpg');
		const out_small = path.join(dir, 'small.jpg');
		await normalize_image(big, out_big, 100);
		await normalize_image(small, out_small, 100);
		expect(dimensions(out_big)).toBe('100x50');
		expect(dimensions(out_small)).toBe('64x32');
		expect(readFileSync(out_big).subarray(0, 2).toString('hex')).toBe('ffd8');
	});

	it('answers 422 for undecodable input and 503 on timeout, leaving no output', async () => {
		const junk = path.join(dir, 'junk.png');
		writeFileSync(junk, Buffer.alloc(512, 9));
		const out = path.join(dir, 'junk.jpg');
		expect(await normalize_image(junk, out, 100).catch((e: unknown) => e)).toMatchObject({ status: 422 });
		expect(existsSync(out)).toBe(false);

		const original = config.MEDIA_TRANSCODE_TIMEOUT_MS;
		config.MEDIA_TRANSCODE_TIMEOUT_MS = 1;
		try {
			const png = path.join(dir, 'ok.png');
			execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x32:d=1', '-frames:v', '1', png]);
			expect(await normalize_image(png, out, 100).catch((e: unknown) => e)).toMatchObject({ status: 503 });
		} finally {
			config.MEDIA_TRANSCODE_TIMEOUT_MS = original;
		}
	});
});
