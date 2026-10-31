import { describe, expect, it } from 'vitest';
import { matches_if_none_match, validator_tag } from './validators';

describe('validator_tag', () => {
	const versions = { catalog: 7, plays: null, user: 3 };
	it('is a weak ETag that is stable for the same inputs', () => {
		const tag = validator_tag('/api/v1/tracks/x', versions, 'u1');
		expect(tag).toMatch(/^W\/"[\w-]{22}"$/u);
		expect(validator_tag('/api/v1/tracks/x', versions, 'u1')).toBe(tag);
	});
	it('changes with the url, every version and the caller', () => {
		const tag = validator_tag('/api/v1/tracks/x', versions, 'u1');
		expect(validator_tag('/api/v1/tracks/y', versions, 'u1')).not.toBe(tag);
		expect(validator_tag('/api/v1/tracks/x', { ...versions, catalog: 8 }, 'u1')).not.toBe(tag);
		expect(validator_tag('/api/v1/tracks/x', { ...versions, plays: 1 }, 'u1')).not.toBe(tag);
		expect(validator_tag('/api/v1/tracks/x', { ...versions, user: 4 }, 'u1')).not.toBe(tag);
		// Two users with the same counters still never share a validator (the body has their own overlay).
		expect(validator_tag('/api/v1/tracks/x', versions, 'u2')).not.toBe(tag);
	});
});

describe('matches_if_none_match', () => {
	const tag = 'W/"abc"';
	it('compares weakly, over a list, and accepts *', () => {
		expect(matches_if_none_match('W/"abc"', tag)).toBe(true);
		expect(matches_if_none_match('"abc"', tag)).toBe(true);
		expect(matches_if_none_match('"x", W/"abc"', tag)).toBe(true);
		expect(matches_if_none_match('*', tag)).toBe(true);
		expect(matches_if_none_match('"abcd"', tag)).toBe(false);
		expect(matches_if_none_match(undefined, tag)).toBe(false);
	});
});
