import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalize_image } from '../media/transcode';
import { artwork_path, is_valid_artwork_id, sniff_image } from './artwork';

describe('sniff_image', () => {
	it('detects jpeg, png and webp by magic bytes only', () => {
		expect(sniff_image(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]))).toBe('jpeg');
		expect(sniff_image(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D]))).toBe('png');
		expect(sniff_image(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('webp');
	});
	it('rejects everything else', () => {
		expect(sniff_image(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1'))).toBeNull();
		expect(sniff_image(Buffer.from('GIF89a', 'latin1'))).toBeNull();
		expect(sniff_image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'latin1'))).toBeNull();
		expect(sniff_image(Buffer.from([0xFF, 0xD8]))).toBeNull();
		expect(sniff_image(Buffer.alloc(0))).toBeNull();
	});
});

describe('artwork ids', () => {
	const id = '0b7c9a3e-5f1d-4c2a-9e8b-123456789abc';
	it('accepts <uuid>.jpg only and never escapes the artwork folder', () => {
		expect(is_valid_artwork_id(`${id}.jpg`)).toBe(true);
		for (const bad of [`${id}.png`, `${id}.JPG`, id, `../${id}.jpg`, `${id}.jpg/..`, `.exports/${id}.json.gz`]) {
			expect(is_valid_artwork_id(bad)).toBe(false);
			expect(artwork_path(bad)).toBeNull();
		}
		expect(artwork_path(`${id}.jpg`)).toMatch(new RegExp(`/artwork/${id}\\.jpg$`, 'u'));
	});
});

const has_ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!has_ffmpeg)('normalize_image', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'illusi-artwork-'));
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	function size(file: string): string {
		return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
	}

	it('scales large images down, keeps the aspect ratio, never upscales, and writes jpeg', async () => {
		const big = path.join(dir, 'big.png');
		execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=3000x1500', '-frames:v', '1', big]);
		const out = path.join(dir, 'big.jpg');
		await normalize_image(big, out, 1024);
		expect(size(out)).toBe('1024,512');
		expect(readFileSync(out).subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))).toBe(true);

		const small = path.join(dir, 'small.webp');
		execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=300x200', '-frames:v', '1', small]);
		const small_out = path.join(dir, 'small.jpg');
		await normalize_image(small, small_out, 1024);
		expect(size(small_out)).toBe('300,200');
	});
});
