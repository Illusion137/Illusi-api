import { describe, expect, it } from 'vitest';
import { consensus_duration, duration_report_schema } from '.';

describe('consensus_duration', () => {
	it('replaces the stored value only when enough agreeing reports outnumber its backers', () => {
		expect(consensus_duration(200_000, 260_000, [260_000], 3)).toBeNull();
		expect(consensus_duration(200_000, 260_000, [260_000, 259_000, 261_000], 3)).toBe(260_000);
		expect(consensus_duration(200_000, 260_000, [260_000, 259_000, 261_000, 200_000, 201_000, 199_000], 3)).toBeNull();
		expect(consensus_duration(200_000, 260_000, [260_000, 261_000, 200_000], 2)).toBe(260_500);
	});

	it('only counts reports within tolerance of the new value', () => {
		expect(consensus_duration(200_000, 260_000, [260_000, 270_000, 280_000], 3)).toBeNull();
	});
});

describe('duration_report_schema', () => {
	it('takes whole milliseconds from a known source', () => {
		expect(duration_report_schema.safeParse({ duration_ms: 200_000, source: 'download', service: 'youtube' }).success).toBe(true);
		expect(duration_report_schema.safeParse({ duration_ms: 999, source: 'download' }).success).toBe(false);
		expect(duration_report_schema.safeParse({ duration_ms: 200_000.5, source: 'service' }).success).toBe(false);
		expect(duration_report_schema.safeParse({ duration_ms: 200_000, source: 'other' }).success).toBe(false);
	});
});
