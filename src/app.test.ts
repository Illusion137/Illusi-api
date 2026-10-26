import { describe, expect, it } from 'vitest';
import { parse_trust_proxy } from './app';

describe('parse_trust_proxy', () => {
	it('parses hop counts, booleans and subnet lists', () => {
		expect(parse_trust_proxy('1')).toBe(1);
		expect(parse_trust_proxy('true')).toBe(true);
		expect(parse_trust_proxy('loopback, uniquelocal')).toBe('loopback, uniquelocal');
	});
});
