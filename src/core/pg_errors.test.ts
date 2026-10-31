import { describe, expect, it } from 'vitest';
import { pg_error_code, pg_error_constraint, pg_error_detail } from './pg_errors';

describe('pg_error_code', () => {
	it('reads the code from a raw pg error or a drizzle-wrapped one', () => {
		expect(pg_error_code({ code: '23505' })).toBe('23505');
		expect(pg_error_code(Object.assign(new Error('Failed query'), { cause: { code: '23505', detail: 'Key (x)=(1) already exists.' } }))).toBe('23505');
		expect(pg_error_detail({ cause: { detail: 'Key (x)=(1) already exists.' } })).toBe('Key (x)=(1) already exists.');
		expect(pg_error_code(new Error('plain'))).toBeUndefined();
		expect(pg_error_code(null)).toBeUndefined();
	});
});

describe('pg_error_constraint and pg_error_detail', () => {
	it('read direct, wrapped and missing values', () => {
		expect(pg_error_constraint({ constraint: 'a_key' })).toBe('a_key');
		expect(pg_error_constraint({ cause: { constraint: 'b_key' } })).toBe('b_key');
		expect(pg_error_constraint(new Error('x'))).toBeUndefined();
		expect(pg_error_constraint(undefined)).toBeUndefined();
		expect(pg_error_detail({ detail: 'd' })).toBe('d');
		expect(pg_error_detail({})).toBeUndefined();
	});
});
