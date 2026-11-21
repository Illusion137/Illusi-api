import { afterEach, describe, expect, it } from 'vitest';
import { default_ranker, lyrics_similarity, pick_consensus, rank_lyrics, set_lyrics_ranker } from './rank';
import { client_services_to_ask, compute_retry_after, due_server_services, is_due, is_instrumental, next_attempts } from './schedule';
import type { LookupLike, LookupStatus, LyricsService } from './types';

const now = new Date('2026-01-01T00:00:00Z');
const opts = { recheck_after_days: 14, error_retry_minutes: 10, max_backoff_minutes: 60 };
const minutes = (d: Date | null) => (d ? (d.getTime() - now.getTime()) / 60_000 : null);

describe('compute_retry_after', () => {
	it('rechecks FOUND / NOT_FOUND after the recheck window', () => {
		expect(minutes(compute_retry_after('FOUND', 1, now, opts))).toBe(14 * 24 * 60);
		expect(minutes(compute_retry_after('NOT_FOUND', 3, now, opts))).toBe(14 * 24 * 60);
	});

	it('never rechecks INSTRUMENTAL', () => {
		expect(compute_retry_after('INSTRUMENTAL', 1, now, opts)).toBeNull();
	});

	it('backs off ERROR / SKIPPED exponentially, capped', () => {
		expect(minutes(compute_retry_after('ERROR', 1, now, opts))).toBe(10);
		expect(minutes(compute_retry_after('ERROR', 2, now, opts))).toBe(20);
		expect(minutes(compute_retry_after('SKIPPED', 3, now, opts))).toBe(40);
		expect(minutes(compute_retry_after('SKIPPED', 10, now, opts))).toBe(60);
	});

	it('never retries before a known cooldown ends', () => {
		const cooldown = new Date(now.getTime() + 120 * 60_000);
		expect(minutes(compute_retry_after('SKIPPED', 1, now, opts, cooldown))).toBe(120);
	});

	it('counts consecutive transient failures', () => {
		expect(next_attempts(undefined, 'ERROR')).toBe(1);
		expect(next_attempts({ status: 'ERROR', attempts: 2 }, 'SKIPPED')).toBe(3);
		expect(next_attempts({ status: 'ERROR', attempts: 2 }, 'NOT_FOUND')).toBe(1);
		expect(next_attempts({ status: 'NOT_FOUND', attempts: 1 }, 'ERROR')).toBe(1);
	});
});

const lookup = (status: LookupStatus, retry_in_minutes: number | null): LookupLike => ({
	status,
	attempts: 1,
	attempted_at: now,
	retry_after: retry_in_minutes == null ? null : new Date(now.getTime() + retry_in_minutes * 60_000)
});
const map = (entries: Partial<Record<LyricsService, LookupLike>>) => new Map(Object.entries(entries) as [LyricsService, LookupLike][]);
const all_not_found = {
	BINILYRICS: lookup('NOT_FOUND', 100), LRCRED: lookup('NOT_FOUND', 100), UNISON: lookup('NOT_FOUND', 100), QQMUSIC: lookup('NOT_FOUND', 100),
	KUGOU: lookup('NOT_FOUND', 100), LRCLIB: lookup('NOT_FOUND', 100)
};

describe('due services', () => {
	it('is due when never tried or the wait is over, never for INSTRUMENTAL', () => {
		expect(is_due(undefined, now)).toBe(true);
		expect(is_due(lookup('NOT_FOUND', -1), now)).toBe(true);
		expect(is_due(lookup('NOT_FOUND', 1), now)).toBe(false);
		expect(is_due(lookup('INSTRUMENTAL', null), now)).toBe(false);
	});

	it('lists due server services', () => {
		expect(due_server_services(map({ BINILYRICS: lookup('NOT_FOUND', 10), LRCLIB: lookup('ERROR', -5) }), now)).toEqual(['LRCRED', 'UNISON', 'QQMUSIC', 'KUGOU', 'LRCLIB']);
	});
});

describe('client_services_to_ask', () => {
	it('asks every untried client service when all server services have a current NOT_FOUND', () => {
		expect(client_services_to_ask(map(all_not_found), now, false)).toEqual(['GENIUS', 'YOUTUBE_MUSIC']);
	});

	it('asks nothing if any server service is ERROR / SKIPPED / missing / expired', () => {
		expect(client_services_to_ask(map({ ...all_not_found, QQMUSIC: lookup('SKIPPED', 10) }), now, false)).toEqual([]);
		expect(client_services_to_ask(map({ ...all_not_found, LRCLIB: lookup('ERROR', 10) }), now, false)).toEqual([]);
		const { KUGOU: _, ...without } = all_not_found;
		expect(client_services_to_ask(map(without), now, false)).toEqual([]);
		expect(client_services_to_ask(map({ ...all_not_found, BINILYRICS: lookup('NOT_FOUND', -1) }), now, false)).toEqual([]);
	});

	it('skips client services tried recently', () => {
		expect(client_services_to_ask(map({ ...all_not_found, GENIUS: lookup('NOT_FOUND', 100) }), now, false)).toEqual(['YOUTUBE_MUSIC']);
		expect(client_services_to_ask(map({ ...all_not_found, GENIUS: lookup('NOT_FOUND', -1), YOUTUBE_MUSIC: lookup('NOT_FOUND', 5) }), now, false)).toEqual(['GENIUS']);
	});

	it('asks nothing for instrumentals', () => {
		const m = map({ ...all_not_found, LRCLIB: lookup('INSTRUMENTAL', null) });
		expect(is_instrumental(m)).toBe(true);
		expect(is_instrumental(map(all_not_found), true)).toBe(true);
		expect(client_services_to_ask(map(all_not_found), now, true)).toEqual([]);
	});
});

describe('rank_lyrics', () => {
	afterEach(() => { set_lyrics_ranker(default_ranker); });
	const row = (id: number, sync_type: 'NONE' | 'LINE' | 'WORD' | 'SYLLABLE', day: number) => ({ id, service: 'LRCLIB' as const, sync_type, created_at: new Date(Date.UTC(2026, 0, day)) });

	it('orders by sync richness, then newest', () => {
		const ranked = rank_lyrics([row(1, 'NONE', 9), row(2, 'LINE', 1), row(3, 'WORD', 1), row(4, 'SYLLABLE', 1), row(5, 'LINE', 5)]);
		expect(ranked.map(r => r.id)).toEqual([4, 3, 5, 2, 1]);
	});

	it('is pluggable', () => {
		set_lyrics_ranker(c => [...c].sort((a, b) => a.id - b.id));
		expect(rank_lyrics([row(2, 'WORD', 1), row(1, 'NONE', 1)]).map(r => r.id)).toEqual([1, 2]);
	});
});

describe('lyrics consensus', () => {
	const lyrics = (text: string) => ({ sync_type: 'LINE' as const, lines: text.split('\n').map((t, i) => ({ text: t, start_ms: i * 1000, end_ms: i * 1000 + 900 })) });
	const SONG = 'I said ooh I\'m blinded by the lights\nNo I can\'t sleep until I feel your touch';
	const candidate = (id: number, text: string) => ({ id, parsed: lyrics(text) });

	it('scores shared text in the same order, ignoring case, punctuation and timing', () => {
		expect(lyrics_similarity(lyrics(SONG), lyrics(SONG.toUpperCase().replace(/'/gu, '’')))).toBeGreaterThan(0.6);
		expect(lyrics_similarity(lyrics(SONG), lyrics(SONG.replace('\n', ', ')))).toBe(1);
		expect(lyrics_similarity(lyrics(SONG), lyrics(SONG.split(' ').reverse().join(' ')))).toBeLessThan(0.2);
		expect(lyrics_similarity(lyrics('晴天的雨'), lyrics('晴天的风'))).toBeCloseTo(2 / 3);
		expect(lyrics_similarity(lyrics(''), lyrics(''))).toBe(1);
	});

	it('picks the version most others agree with, else keeps the rank order', () => {
		const misheard = SONG.replace('blinded by the lights', 'blinding by the light');
		const other_song = 'Never gonna give you up\nNever gonna let you down';
		expect(pick_consensus([candidate(1, other_song), candidate(2, misheard), candidate(3, SONG), candidate(4, SONG)])?.id).toBe(3);
		expect(pick_consensus([candidate(1, misheard), candidate(2, SONG), candidate(3, SONG.replace('touch', 'touch (touch)'))])?.id).toBe(2);
		expect(pick_consensus([candidate(1, other_song), candidate(2, SONG)])?.id).toBe(1);
		expect(pick_consensus([candidate(1, SONG), candidate(2, SONG), candidate(3, SONG)])?.id).toBe(1);
		expect(pick_consensus([])).toBeUndefined();
	});
});
