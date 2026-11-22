import { describe, expect, it } from 'vitest';
import { counted_reports, is_trusted } from './trust';

const now = new Date('2026-11-22T00:00:00Z');
const days_ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
const r = (user_id: string, over: Partial<{ account_created_at: Date; signup_ip_prefix: string | null; in_library: boolean }> = {}) =>
	({ user_id, account_created_at: days_ago(30), signup_ip_prefix: null, in_library: true, ...over });

describe('is_trusted', () => {
	it('needs an account old enough with the entity in its library', () => {
		expect(is_trusted(r('a'), now)).toBe(true);
		expect(is_trusted(r('a', { account_created_at: days_ago(2) }), now)).toBe(false);
		expect(is_trusted(r('a', { in_library: false }), now)).toBe(false);
	});
});

describe('counted_reports', () => {
	it('drops untrusted reporters and counts one report per signup network', () => {
		const reports = [
			r('a', { signup_ip_prefix: '1.2.3.0/24' }),
			r('b', { signup_ip_prefix: '1.2.3.0/24' }),
			r('c', { signup_ip_prefix: '5.6.7.0/24' }),
			r('d'),
			r('e'),
			r('f', { account_created_at: days_ago(1) })
		];
		expect(counted_reports(reports, now).map(x => x.user_id)).toEqual(['a', 'c', 'd', 'e']);
	});
});
