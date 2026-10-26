export type LookupStatus = 'FOUND' | 'NOT_FOUND' | 'ERROR';

export interface RetryConfig {
	not_found_retry_days: number;
	error_retry_minutes: number;
	/** ERROR delays double per attempt up to this many doublings. */
	max_error_doublings: number;
}

/**
 * When an entity may be queued again: FOUND never, NOT_FOUND after ~30 days, ERROR after
 * minutes with exponential backoff on the attempt count.
 */
export function retry_after_for(status: LookupStatus, attempts: number, now: Date, cfg: RetryConfig): Date | null {
	switch (status) {
		case 'FOUND': return null;
		case 'NOT_FOUND': return new Date(now.getTime() + cfg.not_found_retry_days * 86_400_000);
		case 'ERROR': {
			const doublings = Math.min(Math.max(0, attempts - 1), cfg.max_error_doublings);
			return new Date(now.getTime() + cfg.error_retry_minutes * 60_000 * 2 ** doublings);
		}
	}
}
