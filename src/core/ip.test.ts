import { describe, expect, it } from 'vitest';
import { ip_prefix } from './ip';

describe('ip_prefix', () => {
	it('takes the /24 of IPv4, mapped or not', () => {
		expect(ip_prefix('203.0.113.77')).toBe('203.0.113.0/24');
		expect(ip_prefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
	});

	it('takes the /48 of IPv6, expanding ::', () => {
		expect(ip_prefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
		expect(ip_prefix('2001:0DB8::1')).toBe('2001:db8:0::/48');
		expect(ip_prefix('::1')).toBe('0:0:0::/48');
	});

	it('is null for anything else', () => {
		expect(ip_prefix(undefined)).toBeNull();
		expect(ip_prefix('not-an-ip')).toBeNull();
	});
});
