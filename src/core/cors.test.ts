import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { cors, is_allowed_origin } from './cors';

describe('is_allowed_origin', () => {
	it.each([
		['https://sumii.me', true],
		['https://app.sumii.me', true],
		['https://a.b.sumii.me', true],
		['http://sumii.me', false],
		['https://evilsumii.me', false],
		['https://sumii.me.evil.com', false],
		['https://sumii.me:8443', true],
		['https://sumii.me/', false],
		['not a url', false],
		['null', false]
	])('%s -> %s', (origin, expected) => {
		expect(is_allowed_origin(origin, 'sumii.me')).toBe(expected);
	});
});

function run(headers: Record<string, string>, method = 'GET') {
	const set = new Map<string, string>();
	const res = {
		vary: vi.fn(),
		setHeader: (k: string, v: string) => { set.set(k, v); },
		status: vi.fn(),
		json: vi.fn(),
		end: vi.fn()
	};
	res.status.mockReturnValue(res);
	const next = vi.fn();
	cors('sumii.me')({ headers, method } as unknown as Request, res as unknown as Response, next as NextFunction);
	return { res, set, next };
}

describe('cors middleware', () => {
	it('leaves requests without an Origin alone', () => {
		const { set, next, res } = run({});
		expect(res.vary).toHaveBeenCalledWith('Origin');
		expect(set.size).toBe(0);
		expect(next).toHaveBeenCalled();
	});

	it('adds allow-origin for an allowed origin', () => {
		const { set, next } = run({ origin: 'https://app.sumii.me' });
		expect(set.get('Access-Control-Allow-Origin')).toBe('https://app.sumii.me');
		expect(set.get('Access-Control-Expose-Headers')).toContain('ETag');
		expect(next).toHaveBeenCalled();
	});

	it('answers an allowed preflight with 204', () => {
		const { set, next, res } = run({ 'origin': 'https://sumii.me', 'access-control-request-method': 'PUT' }, 'OPTIONS');
		expect(res.status).toHaveBeenCalledWith(204);
		expect(set.get('Access-Control-Allow-Methods')).toContain('PATCH');
		expect(set.get('Access-Control-Allow-Headers')).toContain('Authorization');
		expect(set.get('Access-Control-Max-Age')).toBe('600');
		expect(next).not.toHaveBeenCalled();
	});

	it('passes a plain OPTIONS from an allowed origin on', () => {
		const { next } = run({ origin: 'https://sumii.me' }, 'OPTIONS');
		expect(next).toHaveBeenCalled();
	});

	it('refuses a preflight from a foreign origin', () => {
		const { set, next, res } = run({ 'origin': 'https://evil.com', 'access-control-request-method': 'GET' }, 'OPTIONS');
		expect(res.status).toHaveBeenCalledWith(403);
		expect(set.size).toBe(0);
		expect(next).not.toHaveBeenCalled();
	});

	it('gives a foreign origin no CORS headers on normal requests', () => {
		const { set, next } = run({ origin: 'https://evil.com' });
		expect(set.size).toBe(0);
		expect(next).toHaveBeenCalled();
	});
});
