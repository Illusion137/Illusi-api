import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from './http';
import { RateLimiter, rate_limit_user } from './rate_limit';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('RateLimiter', () => {
	it('allows up to the limit then refuses', () => {
		const limiter = new RateLimiter(2, 1_000);
		expect(limiter.hit('a')).toBe(true);
		expect(limiter.hit('a')).toBe(true);
		expect(limiter.hit('a')).toBe(false);
		expect(limiter.hit('b')).toBe(true);
	});

	it('frees slots once hits leave the window', () => {
		const limiter = new RateLimiter(1, 1_000);
		expect(limiter.hit('a')).toBe(true);
		vi.advanceTimersByTime(999);
		expect(limiter.hit('a')).toBe(false);
		vi.advanceTimersByTime(1);
		expect(limiter.hit('a')).toBe(true);
	});

	it('does not count refused hits against the window', () => {
		const limiter = new RateLimiter(1, 1_000);
		limiter.hit('a');
		vi.advanceTimersByTime(500);
		limiter.hit('a');
		vi.advanceTimersByTime(500);
		expect(limiter.hit('a')).toBe(true);
	});

	it('sweeps idle keys and keeps live ones', () => {
		const limiter = new RateLimiter(5, 45_000);
		limiter.hit('old');
		vi.advanceTimersByTime(30_000);
		limiter.hit('new');
		vi.advanceTimersByTime(29_999);
		const hits = (limiter as unknown as { hits: Map<string, number[]> }).hits;
		expect([...hits.keys()]).toEqual(['old', 'new']);
		vi.advanceTimersByTime(1);
		expect([...hits.keys()]).toEqual(['new']);
		vi.advanceTimersByTime(60_000);
		expect(hits.size).toBe(0);
	});
});

describe('rate_limit_user', () => {
	const run = (mw: ReturnType<typeof rate_limit_user>, req: Partial<Request>) => {
		const next = vi.fn();
		mw(req as Request, {} as never, next);
		return next;
	};

	it('limits per user and throws 429', () => {
		const mw = rate_limit_user('x', 1, 1_000);
		expect(run(mw, { user: { id: 'u1' } as never })).toHaveBeenCalledOnce();
		expect(() => run(mw, { user: { id: 'u1' } as never })).toThrow(HttpError);
		expect(run(mw, { user: { id: 'u2' } as never })).toHaveBeenCalledOnce();
	});

	it('falls back to the ip without a user', () => {
		const mw = rate_limit_user('x', 1, 1_000);
		run(mw, { ip: '1.2.3.4' });
		expect(() => run(mw, { ip: '1.2.3.4' })).toThrow(expect.objectContaining({ status: 429 }));
		expect(run(mw, { ip: '5.6.7.8' })).toHaveBeenCalledOnce();
	});
});
