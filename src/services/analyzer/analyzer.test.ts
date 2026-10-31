import { describe, expect, it } from 'vitest';
import { map_analysis, map_vocals, normalize_key, unflatten_segments } from './contract';
import type { LookupState } from './decisions';
import {
	assert_tmp_dir_safe, choose_source, classify_analyzer_status, classify_download_status, decide_failure, error_retry_delay_ms,
	MAX_ANALYZER_5XX_PER_JOB, may_delete, next_attempts, preview_extension, safe_media_path, source_eligible
} from './decisions';
import { JobQueue } from './queue';

const TRACK = '0b7d2f7e-8f0e-4a39-9d62-3f6f7a2b1c11';
const valid = {
	mood: 'House/Dance', tempo: 124.5, brightness: 2810.2, key: 'F#m',
	arousal: 0.7, valence: 0.88, acousticness: 0.34, instrumentalness: 0.71, liveness: 0.16, danceability: 0.62, speechiness: 0.04
};

describe('analyzer response mapping', () => {
	it('maps a valid response to a sample row', () => {
		expect(map_analysis(TRACK, valid)).toEqual({ id: TRACK, ...valid });
	});

	it('normalizes Mood-Detector key spelling to varchar(5)', () => {
		expect(map_analysis(TRACK, { ...valid, key: 'C# minor' })?.key).toBe('C#m');
		expect(map_analysis(TRACK, { ...valid, key: 'Bb major' })?.key).toBe('A#');
		expect(normalize_key('G#m')).toBe('G#m');
		expect(normalize_key('???')).toBeNull();
	});

	it('truncates long moods to the column length', () => {
		expect(map_analysis(TRACK, { ...valid, mood: 'x'.repeat(80) })?.mood).toHaveLength(50);
	});

	it('rejects responses that break the contract', () => {
		expect(map_analysis(TRACK, { ...valid, valence: 1.5 })).toBeNull();
		expect(map_analysis(TRACK, { ...valid, arousal: undefined })).toBeNull();
		expect(map_analysis(TRACK, { ...valid, tempo: '120' })).toBeNull();
		expect(map_analysis(TRACK, { ...valid, key: 'H' })).toBeNull();
		expect(map_analysis(TRACK, { ...valid, mood: '' })).toBeNull();
		expect(map_analysis(TRACK, null)).toBeNull();
	});

	it('ignores extra fields', () => {
		expect(map_analysis(TRACK, { ...valid, energy: 0.2, explanation: 'x' })).toEqual({ id: TRACK, ...valid });
	});
});

describe('vocals response mapping', () => {
	const vocals = {
		model: 'discogs-effnet-bsdynamic-1+voice_instrumental-discogs-effnet-1', hop_ms: 256, window_ms: 2048, duration_ms: 30_000,
		voice: [0.01, 0.62, 0.93, 0.4], segments: [{ start_ms: 9856, end_ms: 17024 }, { start_ms: 20_000, end_ms: 21_500 }]
	};

	it('flattens segments for storage and back', () => {
		const mapped = map_vocals(vocals);
		expect(mapped).toEqual({ ...vocals, segments: [9856, 17024, 20_000, 21_500] });
		expect(unflatten_segments(mapped!.segments)).toEqual(vocals.segments);
		expect(unflatten_segments([1, 2, 3])).toEqual([{ start_ms: 1, end_ms: 2 }]);
	});

	it('rejects responses that break the contract', () => {
		expect(map_vocals({ ...vocals, voice: [1.2] })).toBeNull();
		expect(map_vocals({ ...vocals, hop_ms: 0 })).toBeNull();
		expect(map_vocals({ ...vocals, segments: [{ start_ms: 5, end_ms: 4 }] })).toBeNull();
		expect(map_vocals({ ...vocals, model: undefined })).toBeNull();
		expect(map_vocals(null)).toBeNull();
	});
});

describe('failure decisions', () => {
	const now = new Date('2026-01-01T00:00:00Z');

	it('gives up on bad files and missing downloads until the source changes', () => {
		expect(decide_failure({ kind: 'bad_file' }, 1, 0, now)).toEqual({ action: 'record', status: 'BAD_FILE', retry_after: null });
		expect(decide_failure({ kind: 'download_not_found' }, 1, 0, now)).toEqual({ action: 'record', status: 'NOT_FOUND', retry_after: null });
	});

	it('records ERROR with backoff for exhausted downloads, timeouts and internal errors', () => {
		for (const kind of ['download_failed', 'timeout', 'internal'] as const) {
			const d = decide_failure({ kind }, 2, 0, now);
			expect(d).toEqual({ action: 'record', status: 'ERROR', retry_after: new Date(now.getTime() + error_retry_delay_ms(2)) });
		}
		expect(error_retry_delay_ms(1)).toBe(5 * 60_000);
		expect(error_retry_delay_ms(2)).toBe(10 * 60_000);
		expect(error_retry_delay_ms(100)).toBe(24 * 60 * 60_000);
	});

	it('pauses and retries when the analyzer is unavailable', () => {
		expect(decide_failure({ kind: 'analyzer_unavailable' }, 1, 0)).toEqual({ action: 'retry_after_health' });
		expect(decide_failure({ kind: 'analyzer_unavailable', http_status: 500 }, 1, 1)).toEqual({ action: 'retry_after_health' });
		// unreachable never counts towards the cap
		expect(decide_failure({ kind: 'analyzer_unavailable' }, 1, 99)).toEqual({ action: 'retry_after_health' });
	});

	it('records ERROR after repeated analyzer 5xx for one job', () => {
		const d = decide_failure({ kind: 'analyzer_unavailable', http_status: 500 }, 1, MAX_ANALYZER_5XX_PER_JOB, now);
		expect(d).toMatchObject({ action: 'record', status: 'ERROR' });
	});

	it('classifies HTTP statuses', () => {
		expect(classify_download_status(200)).toBe('ok');
		expect(classify_download_status(404)).toBe('not_found');
		expect(classify_download_status(410)).toBe('not_found');
		expect(classify_download_status(403)).toBe('not_found');
		expect(classify_download_status(429)).toBe('retry');
		expect(classify_download_status(503)).toBe('retry');
		expect(classify_analyzer_status(200)).toBe('ok');
		expect(classify_analyzer_status(400)).toBe('bad_file');
		expect(classify_analyzer_status(422)).toBe('bad_file');
		expect(classify_analyzer_status(500)).toBe('unavailable');
		expect(classify_analyzer_status(503)).toBe('unavailable');
	});
});

describe('lookup eligibility', () => {
	const now = new Date('2026-01-01T00:00:00Z');
	const later = new Date('2026-01-02T00:00:00Z');
	const earlier = new Date('2025-12-31T00:00:00Z');

	it('blocks BAD_FILE / NOT_FOUND until the source ref changes', () => {
		expect(source_eligible(null, 'u1', now)).toBe(true);
		expect(source_eligible({ status: 'BAD_FILE', retry_after: null, source_ref: 'u1' }, 'u1', now)).toBe(false);
		expect(source_eligible({ status: 'BAD_FILE', retry_after: null, source_ref: 'u1' }, 'u2', now)).toBe(true);
		expect(source_eligible({ status: 'NOT_FOUND', retry_after: null, source_ref: 'u1' }, 'u1', now)).toBe(false);
		expect(source_eligible({ status: 'NOT_FOUND', retry_after: null, source_ref: null }, 'u1', now)).toBe(true);
	});

	it('blocks ERROR until retry_after', () => {
		expect(source_eligible({ status: 'ERROR', retry_after: later, source_ref: 'u1' }, 'u1', now)).toBe(false);
		expect(source_eligible({ status: 'ERROR', retry_after: earlier, source_ref: 'u1' }, 'u1', now)).toBe(true);
		expect(source_eligible({ status: 'ERROR', retry_after: later, source_ref: 'u1' }, 'u2', now)).toBe(true);
	});

	it('chooses the preferred, then media, then preview source', () => {
		const media = { source: 'media' as const, ref: 'r1' };
		const preview = { source: 'itunes_preview' as const, ref: 'https://x/p.m4a' };
		const none = new Map<'media' | 'itunes_preview', LookupState>();
		expect(choose_source([preview, media], none)).toBe(media);
		expect(choose_source([preview, media], none, 'itunes_preview')).toBe(preview);
		const blocked = new Map([['media' as const, { status: 'BAD_FILE' as const, retry_after: null, source_ref: 'r1' }]]);
		expect(choose_source([preview, media], blocked, 'media')).toBe(preview);
		expect(choose_source([media], blocked)).toBeNull();
	});

	it('continues attempts for the same source ref only', () => {
		expect(next_attempts(null, 'a')).toBe(1);
		expect(next_attempts({ attempts: 2, source_ref: 'a' }, 'a')).toBe(3);
		expect(next_attempts({ attempts: 2, source_ref: 'a' }, 'b')).toBe(1);
	});
});

describe('path safety', () => {
	it('refuses a temp dir equal to, inside, or containing the media dir', () => {
		expect(() => assert_tmp_dir_safe('/data/media', '/data/media')).toThrow();
		expect(() => assert_tmp_dir_safe('/data/media/tmp', '/data/media')).toThrow();
		expect(() => assert_tmp_dir_safe('/data/media/../media/tmp', '/data/media')).toThrow();
		expect(() => assert_tmp_dir_safe('/data', '/data/media')).toThrow();
		expect(() => assert_tmp_dir_safe('/', '/data/media')).toThrow();
		expect(() => assert_tmp_dir_safe('/data/analyzer_tmp', '/data/media')).not.toThrow();
		expect(() => assert_tmp_dir_safe('/data/media_tmp', '/data/media')).not.toThrow();
	});

	it('deletes only itunes previews strictly inside the temp dir', () => {
		const tmp = '/data/analyzer_tmp';
		expect(may_delete('itunes_preview', '/data/analyzer_tmp/t.u.m4a', tmp)).toBe(true);
		expect(may_delete('media', '/data/analyzer_tmp/t.u.m4a', tmp)).toBe(false);
		expect(may_delete('itunes_preview', '/data/media/abc', tmp)).toBe(false);
		expect(may_delete('itunes_preview', '/data/analyzer_tmp/../media/abc', tmp)).toBe(false);
		expect(may_delete('itunes_preview', '/data/analyzer_tmp', tmp)).toBe(false);
		expect(may_delete('itunes_preview', '/data/analyzer_tmp_other/x', tmp)).toBe(false);
	});

	it('only accepts plain media resource ids', () => {
		expect(safe_media_path('/data/media', TRACK)).toBe(`/data/media/${TRACK}`);
		expect(safe_media_path('/data/media', '../etc/passwd')).toBeNull();
		expect(safe_media_path('/data/media', 'a/b')).toBeNull();
		expect(safe_media_path('/data/media', '..')).toBeNull();
		expect(safe_media_path('/data/media', '')).toBeNull();
	});

	it('derives preview extensions safely', () => {
		expect(preview_extension('https://audio-ssl.itunes.apple.com/a/b/mzaf_1.plus.aac.p.m4a')).toBe('m4a');
		expect(preview_extension('https://x/y')).toBe('m4a');
		expect(preview_extension('not a url')).toBe('m4a');
		expect(preview_extension('https://x/y.mp3?z=1')).toBe('mp3');
	});
});

describe('job queue', () => {
	it('dedupes by key while queued or running', async () => {
		const q = new JobQueue<{ id: string }>(j => j.id);
		expect(q.push({ id: 'a' })).toBe(true);
		expect(q.push({ id: 'a' })).toBe(false);
		expect(q.push({ id: 'b' })).toBe(true);
		const a = await q.next();
		expect(a?.id).toBe('a');
		expect(q.push({ id: 'a' })).toBe(false); // running
		q.release('a');
		expect(q.push({ id: 'a' })).toBe(true);
		expect((await q.next())?.id).toBe('b');
	});

	it('retries at the front and wakes waiters', async () => {
		const q = new JobQueue<{ id: string }>(j => j.id);
		q.push({ id: 'a' });
		q.push({ id: 'b' });
		const a = await q.next();
		q.push_front(a!);
		expect((await q.next())?.id).toBe('a');
		expect((await q.next())?.id).toBe('b');
		const waiting = q.next();
		q.push({ id: 'c' });
		expect((await waiting)?.id).toBe('c');
		const pending2 = q.next();
		q.close();
		expect(await pending2).toBeNull();
		expect(q.push({ id: 'd' })).toBe(false);
	});
});
