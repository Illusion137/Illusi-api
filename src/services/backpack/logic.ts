import type { ServiceIdColumn } from '../../core/service_ids';
import type { RESEARCH_SERVICES, RESEARCH_STATUSES } from '../../db/schema';

export type ResearchService = typeof RESEARCH_SERVICES[number];
export type ResearchStatus = typeof RESEARCH_STATUSES[number];

/** The service id column a research result fills. */
export const RESEARCH_COLUMNS: Record<ResearchService, ServiceIdColumn> = {
	youtube: 'youtube_id',
	soundcloud: 'soundcloud_permalink',
	bandlab: 'bandlab_id',
	audiomack: 'audiomack_id'
};

export interface ResearchRow {
	service: string;
	status: ResearchStatus;
	requested_at: Date | null;
	checked_at: Date | null;
}

export interface ResearchPolicy {
	cooldown_ms: number;
	retry_ms: number;
}

/**
 * Whether a service can be asked now: never asked, a handed-out request whose cooldown passed, or a NOT_FOUND
 * old enough to retry. A FOUND service is never asked again.
 */
export function research_due(row: ResearchRow | undefined, now: Date, policy: ResearchPolicy): boolean {
	if (!row) return true;
	if (row.status === 'FOUND') return false;
	if (row.status === 'NOT_FOUND') return row.checked_at === null || now.getTime() - row.checked_at.getTime() >= policy.retry_ms;
	return row.requested_at === null || now.getTime() - row.requested_at.getTime() >= policy.cooldown_ms;
}

/**
 * The next service to research a backpacked track on. Services whose column is still empty come first: a value
 * found there is written right away and makes the track playable. Services that already have a (dead) id come
 * last, since a different value there can only go to admin review.
 */
export function next_research_service(
	services: readonly ResearchService[],
	filled: ReadonlySet<ServiceIdColumn>,
	rows: readonly ResearchRow[],
	now: Date,
	policy: ResearchPolicy
): ResearchService | null {
	const by_service = new Map(rows.map(r => [r.service, r]));
	const ordered = [...services.filter(s => !filled.has(RESEARCH_COLUMNS[s])), ...services.filter(s => filled.has(RESEARCH_COLUMNS[s]))];
	return ordered.find(s => research_due(by_service.get(s), now, policy)) ?? null;
}

/** `Artist, Artist - Title`, what a client types into the service's search. */
export function research_query(title: string, artists: readonly string[]): string {
	return artists.length > 0 ? `${artists.join(', ')} - ${title}` : title;
}
