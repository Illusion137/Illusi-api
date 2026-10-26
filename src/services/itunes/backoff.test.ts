import { describe, expect, it } from 'vitest';
import { classify_error, decide, DEFAULT_BACKOFF, initial_backoff_state, parse_retry_after, response_error_status } from './backoff';
import { retry_after_for } from './records';

const rozfetch_error = (status: number) => ({ error: new Error(`rozfetch failed | response NOT ok | ${status}: Forbidden;\n Response failed with status code ${status}(Forbidden) : ""\n : args{}`) });
const no_jitter = () => 0;

describe('classify_error', () => {
	it('reads the status out of rozfetch errors', () => {
		expect(response_error_status(rozfetch_error(403))).toBe(403);
		expect(classify_error(rozfetch_error(403))).toMatchObject({ kind: 'rate_limited', status: 403 });
		expect(classify_error(rozfetch_error(429))).toMatchObject({ kind: 'rate_limited', status: 429 });
		expect(classify_error(rozfetch_error(503))).toMatchObject({ kind: 'transient', status: 503 });
		expect(classify_error(rozfetch_error(404))).toEqual({ kind: 'client_error', status: 404 });
		expect(classify_error({ error: new Error('rozfetch failed | [ABORTED_ROZFETCH]The operation timed out') })).toMatchObject({ kind: 'transient', reason: 'timeout' });
		expect(classify_error({ error: new Error('rozfetch failed | fetch failed') })).toMatchObject({ kind: 'transient' });
	});
	it('parses Retry-After', () => {
		expect(parse_retry_after('120')).toBe(120_000);
		expect(parse_retry_after(new Date(10_000).toUTCString(), 0)).toBe(10_000);
		expect(parse_retry_after('garbage')).toBeUndefined();
	});
});

describe('decide', () => {
	it('backs off exponentially on 403/429, capped, and never drops', () => {
		const state = initial_backoff_state();
		const delays = Array.from({ length: 8 }, () => decide({ kind: 'rate_limited', status: 403 }, state, 0, DEFAULT_BACKOFF, no_jitter));
		expect(delays.every(d => d.action === 'retry')).toBe(true);
		expect(delays.map(d => (d.action === 'retry' ? d.delay_ms : 0))).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
	});
	it('honours Retry-After', () => {
		expect(decide({ kind: 'rate_limited', status: 429, retry_after_ms: 5_000 }, initial_backoff_state(), 0)).toEqual({ action: 'retry', delay_ms: 5_000, reason: 'rate_limited' });
	});
	it('adds jitter', () => {
		const d = decide({ kind: 'rate_limited', status: 403 }, initial_backoff_state(), 0, DEFAULT_BACKOFF, () => 1);
		expect(d).toMatchObject({ delay_ms: 36_000 });
	});
	it('retries 5xx/network up to N attempts, then drops', () => {
		const state = initial_backoff_state();
		const out = [1, 2, 3, 4].map(n => decide({ kind: 'transient', reason: 'x' }, state, n, DEFAULT_BACKOFF, no_jitter));
		expect(out.slice(0, 3).map(d => d.action)).toEqual(['retry', 'retry', 'retry']);
		expect(out.slice(0, 3).map(d => (d.action === 'retry' ? d.delay_ms : 0))).toEqual([2_000, 4_000, 8_000]);
		expect(out[3].action).toBe('drop');
	});
	it('drops other 4xx immediately', () => {
		expect(decide({ kind: 'client_error', status: 400 }, initial_backoff_state(), 0).action).toBe('drop');
	});
	it('resets the rate-limit backoff after a run of successes', () => {
		const state = initial_backoff_state();
		decide({ kind: 'rate_limited', status: 403 }, state, 0, DEFAULT_BACKOFF, no_jitter);
		decide({ kind: 'rate_limited', status: 403 }, state, 0, DEFAULT_BACKOFF, no_jitter);
		decide({ kind: 'ok' }, state, 0);
		expect(state.rate_limit_streak).toBe(2);
		for (let i = 0; i < DEFAULT_BACKOFF.reset_after_successes; i++) decide({ kind: 'ok' }, state, 0);
		expect(state.rate_limit_streak).toBe(0);
		expect(decide({ kind: 'rate_limited', status: 403 }, state, 0, DEFAULT_BACKOFF, no_jitter)).toMatchObject({ delay_ms: 30_000 });
	});
});

describe('retry_after_for', () => {
	const now = new Date(0);
	const cfg = { not_found_retry_days: 30, error_retry_minutes: 15, max_error_doublings: 6 };
	it('follows the §1.8 windows', () => {
		expect(retry_after_for('FOUND', 1, now, cfg)).toBeNull();
		expect(retry_after_for('NOT_FOUND', 1, now, cfg)?.getTime()).toBe(30 * 86_400_000);
		expect(retry_after_for('ERROR', 1, now, cfg)?.getTime()).toBe(15 * 60_000);
		expect(retry_after_for('ERROR', 3, now, cfg)?.getTime()).toBe(60 * 60_000);
		expect(retry_after_for('ERROR', 50, now, cfg)?.getTime()).toBe(15 * 60_000 * 64);
	});
});
