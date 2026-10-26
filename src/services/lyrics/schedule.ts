import { config } from '../../config';
import { CLIENT_SERVICES, SERVER_SERVICES } from './types';
import type { ClientService, LookupLike, LookupStatus, LyricsService, ServerService } from './types';

/** Lookup-record timing rules and the "should we send actions" decision. Pure. */

export interface RetryOptions {
	recheck_after_days: number;
	error_retry_minutes: number;
	max_backoff_minutes: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
	recheck_after_days: config.LYRICS_RECHECK_AFTER_DAYS,
	error_retry_minutes: config.LYRICS_ERROR_RETRY_MINUTES,
	max_backoff_minutes: 24 * 60
};

const is_transient = (status: LookupStatus | undefined) => status === 'ERROR' || status === 'SKIPPED';

/** Consecutive transient failures count up (for backoff); anything else resets to 1. */
export function next_attempts(previous: Pick<LookupLike, 'status' | 'attempts'> | undefined, status: LookupStatus): number {
	if (previous && is_transient(previous.status) && is_transient(status)) return previous.attempts + 1;
	return 1;
}

/**
 * When this service may be asked again. `null` = never (`INSTRUMENTAL`). `ERROR` / `SKIPPED` back off
 * exponentially from `error_retry_minutes`, and never before a known service cooldown ends.
 */
export function compute_retry_after(status: LookupStatus, attempts: number, now: Date, opts: RetryOptions = DEFAULT_RETRY_OPTIONS, cooldown_until?: Date | null): Date | null {
	switch (status) {
		case 'INSTRUMENTAL': return null;
		case 'FOUND':
		case 'NOT_FOUND': return new Date(now.getTime() + opts.recheck_after_days * 86_400_000);
		case 'ERROR':
		case 'SKIPPED': {
			const minutes = Math.min(opts.error_retry_minutes * 2 ** Math.max(0, attempts - 1), opts.max_backoff_minutes);
			const backoff = now.getTime() + minutes * 60_000;
			return new Date(Math.max(backoff, cooldown_until?.getTime() ?? 0));
		}
	}
}

/** True when the service hasn't been tried or its wait is over. `INSTRUMENTAL` is never due. */
export function is_due(lookup: LookupLike | undefined, now: Date): boolean {
	if (!lookup) return true;
	if (lookup.status === 'INSTRUMENTAL') return false;
	return lookup.retry_after == null || lookup.retry_after.getTime() <= now.getTime();
}

export function is_current_not_found(lookup: LookupLike | undefined, now: Date): boolean {
	return lookup?.status === 'NOT_FOUND' && !is_due(lookup, now);
}

export function due_server_services(lookups: ReadonlyMap<LyricsService, LookupLike>, now: Date): ServerService[] {
	return SERVER_SERVICES.filter(s => is_due(lookups.get(s), now));
}

/** LRCLib reported instrumental, or the linked Genius song is. */
export function is_instrumental(lookups: ReadonlyMap<LyricsService, LookupLike>, genius_song_instrumental = false): boolean {
	return genius_song_instrumental || lookups.get('LRCLIB')?.status === 'INSTRUMENTAL' || lookups.get('GENIUS')?.status === 'INSTRUMENTAL';
}

/**
 * Which client actions to send when nothing was found: none unless **every** server
 * service has a current `NOT_FOUND` (an `ERROR`/`SKIPPED` gets retried by the server first), none
 * for instrumentals, and only client services that haven't been tried recently.
 */
export function client_services_to_ask(lookups: ReadonlyMap<LyricsService, LookupLike>, now: Date, instrumental: boolean): ClientService[] {
	if (instrumental) return [];
	if (!SERVER_SERVICES.every(s => is_current_not_found(lookups.get(s), now))) return [];
	return CLIENT_SERVICES.filter(s => is_due(lookups.get(s), now));
}
