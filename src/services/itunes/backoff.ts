import type { ResponseError } from '@common/types';

/** Same marker as `ABORT_MESSAGE` in @common/rozfetch (not imported to keep this module pure). */
const ABORT_MESSAGE = '[ABORTED_ROZFETCH]';

/** What one HTTP attempt came back with. */
export type Outcome
	= | { kind: 'ok' }
		| { kind: 'rate_limited'; status: number; retry_after_ms?: number }
		| { kind: 'transient'; status?: number; reason: string }
		| { kind: 'client_error'; status: number };

export interface BackoffConfig {
	rate_limit_base_ms: number;
	rate_limit_cap_ms: number;
	transient_base_ms: number;
	transient_cap_ms: number;
	/** Attempts (including the first) before a 5xx / network failure is dropped. */
	max_transient_attempts: number;
	/** Consecutive successes after which the rate-limit backoff starts over from the base delay. */
	reset_after_successes: number;
	/** Fraction of the delay added as random jitter (0.2 = up to +20%). */
	jitter: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
	rate_limit_base_ms: 30_000,
	rate_limit_cap_ms: 10 * 60_000,
	transient_base_ms: 2_000,
	transient_cap_ms: 60_000,
	max_transient_attempts: 4,
	reset_after_successes: 5,
	jitter: 0.2
};

/** Process-wide backoff state; `transient_attempts` is per request and reset by the caller. */
export interface BackoffState {
	rate_limit_streak: number;
	success_streak: number;
}

export type Decision
	= | { action: 'done' }
		| { action: 'retry'; delay_ms: number; reason: 'rate_limited' | 'transient' }
		| { action: 'drop'; reason: string };

export function initial_backoff_state(): BackoffState {
	return { rate_limit_streak: 0, success_streak: 0 };
}

const exp_delay = (base: number, cap: number, n: number) => Math.min(cap, base * 2 ** Math.max(0, n));

/**
 * The decision table. Mutates `state` (streaks); `transient_attempts` counts attempts of the
 * current request that already failed transiently, including this one.
 * - 403/429: back off exponentially with jitter (or honour `Retry-After`), retry the same request forever.
 * - 5xx / network / timeout: retry with backoff up to `max_transient_attempts`, then drop.
 * - Other 4xx: drop.
 */
export function decide(outcome: Outcome, state: BackoffState, transient_attempts: number, cfg: BackoffConfig = DEFAULT_BACKOFF, random: () => number = Math.random): Decision {
	const jitter = (ms: number) => Math.round(ms * (1 + cfg.jitter * random()));
	switch (outcome.kind) {
		case 'ok':
			state.success_streak++;
			if (state.success_streak >= cfg.reset_after_successes) state.rate_limit_streak = 0;
			return { action: 'done' };
		case 'rate_limited': {
			state.success_streak = 0;
			const computed = jitter(exp_delay(cfg.rate_limit_base_ms, cfg.rate_limit_cap_ms, state.rate_limit_streak));
			state.rate_limit_streak++;
			const delay_ms = outcome.retry_after_ms != null && outcome.retry_after_ms > 0 ? Math.min(outcome.retry_after_ms, cfg.rate_limit_cap_ms) : computed;
			return { action: 'retry', delay_ms, reason: 'rate_limited' };
		}
		case 'transient':
			state.success_streak = 0;
			if (transient_attempts >= cfg.max_transient_attempts) return { action: 'drop', reason: `gave up after ${transient_attempts} attempts: ${outcome.reason}` };
			return { action: 'retry', delay_ms: jitter(exp_delay(cfg.transient_base_ms, cfg.transient_cap_ms, transient_attempts - 1)), reason: 'transient' };
		case 'client_error':
			state.success_streak = 0;
			return { action: 'drop', reason: `HTTP ${outcome.status}` };
	}
}

/** Parses a `Retry-After` header (seconds or HTTP date) into ms from `now`. */
export function parse_retry_after(value: string | null | undefined, now = Date.now()): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/u.test(value.trim())) return Number(value.trim()) * 1000;
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** rozfetch puts the status only in the message (`response NOT ok | 403: ...`). */
export function response_error_status(err: ResponseError): number | undefined {
	const message = err.error?.message ?? '';
	const m = /response NOT ok \| (\d{3})/u.exec(message) ?? /status code (\d{3})/u.exec(message);
	return m ? Number(m[1]) : undefined;
}

/** Maps a lib-origin `ResponseError` onto an outcome. No status means network failure, timeout or a bad body. */
export function classify_error(err: ResponseError): Outcome {
	const status = response_error_status(err);
	const retry_after_ms = parse_retry_after((err as { retry_after?: string }).retry_after);
	if (status === 403 || status === 429) return { kind: 'rate_limited', status, retry_after_ms };
	if (status != null && status >= 500) return { kind: 'transient', status, reason: `HTTP ${status}` };
	if (status != null && status >= 400) return { kind: 'client_error', status };
	const message = err.error?.message ?? String(err.error);
	return { kind: 'transient', status, reason: message.includes(ABORT_MESSAGE) ? 'timeout' : message.split('\n')[0] };
}
