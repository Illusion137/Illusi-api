import { describe, expect, it } from 'vitest';
import type { ServiceIdColumn } from '../../core/service_ids';
import { RESEARCH_SERVICES } from '../../db/schema';
import { next_research_service, research_due, research_query } from './logic';
import type { ResearchRow } from './logic';

const policy = { cooldown_ms: 60 * 60_000, retry_ms: 30 * 86_400_000 };
const now = new Date('2026-10-25T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const row = (service: string, status: ResearchRow['status'], at: Date | null): ResearchRow => ({
	service, status, requested_at: status === 'PENDING' ? at : null, checked_at: status === 'PENDING' ? null : at
});

describe('research_due', () => {
	it('asks services that were never asked', () => {
		expect(research_due(undefined, now, policy)).toBe(true);
	});

	it('waits out the cooldown on a handed-out request', () => {
		expect(research_due(row('youtube', 'PENDING', ago(10 * 60_000)), now, policy)).toBe(false);
		expect(research_due(row('youtube', 'PENDING', ago(61 * 60_000)), now, policy)).toBe(true);
	});

	it('retries NOT_FOUND only after the retry period', () => {
		expect(research_due(row('youtube', 'NOT_FOUND', ago(86_400_000)), now, policy)).toBe(false);
		expect(research_due(row('youtube', 'NOT_FOUND', ago(31 * 86_400_000)), now, policy)).toBe(true);
	});

	it('never asks a FOUND service again', () => {
		expect(research_due(row('youtube', 'FOUND', ago(365 * 86_400_000)), now, policy)).toBe(false);
	});
});

describe('next_research_service', () => {
	it('prefers services whose id column is empty', () => {
		const filled = new Set<ServiceIdColumn>(['youtube_id']);
		expect(next_research_service(RESEARCH_SERVICES, filled, [], now, policy)).toBe('soundcloud');
	});

	it('skips services that are not due, falling back to filled ones last', () => {
		const filled = new Set<ServiceIdColumn>(['youtube_id']);
		const rows = [
			row('soundcloud', 'PENDING', ago(60_000)),
			row('bandlab', 'NOT_FOUND', ago(86_400_000)),
			row('audiomack', 'FOUND', ago(86_400_000))
		];
		expect(next_research_service(RESEARCH_SERVICES, filled, rows, now, policy)).toBe('youtube');
		expect(next_research_service(RESEARCH_SERVICES, filled, [...rows, row('youtube', 'PENDING', ago(60_000))], now, policy)).toBeNull();
	});
});

describe('research_query', () => {
	it('joins artists before the title', () => {
		expect(research_query('Song', ['A', 'B'])).toBe('A, B - Song');
		expect(research_query('Song', [])).toBe('Song');
	});
});
