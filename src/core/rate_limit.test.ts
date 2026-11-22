import type { Request } from 'express';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log', () => ({ logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { HttpError } from './http';
import { memory_store_for_tests, RateLimiter, rate_limit_user, use_memory_rate_limits, use_shared_rate_limits } from './rate_limit';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
	vi.useRealTimers();
	use_memory_rate_limits();
});

let n = 0;
const key = () => `k${++n}`;

describe('RateLimiter (memory)', () => {
	it('allows up to the limit then refuses', async () => {
		const limiter = new RateLimiter(2, 1_000);
		const a = key();
		expect(await limiter.hit(a)).toBe(true);
		expect(await limiter.hit(a)).toBe(true);
		expect(await limiter.hit(a)).toBe(false);
		expect(await limiter.hit(key())).toBe(true);
	});

	it('frees slots once hits leave the window', async () => {
		const limiter = new RateLimiter(1, 1_000);
		const a = key();
		expect(await limiter.hit(a)).toBe(true);
		vi.advanceTimersByTime(999);
		expect(await limiter.hit(a)).toBe(false);
		vi.advanceTimersByTime(1);
		expect(await limiter.hit(a)).toBe(true);
	});

	it('does not count refused hits against the window', async () => {
		const limiter = new RateLimiter(1, 1_000);
		const a = key();
		await limiter.hit(a);
		vi.advanceTimersByTime(500);
		await limiter.hit(a);
		vi.advanceTimersByTime(500);
		expect(await limiter.hit(a)).toBe(true);
	});

	it('sweeps idle keys', async () => {
		const limiter = new RateLimiter(5, 1_000);
		const a = key();
		const hits = (memory_store_for_tests as unknown as { hits: Map<string, unknown> }).hits;
		await limiter.hit(a);
		memory_store_for_tests.sweep();
		expect(hits.has(a)).toBe(true);
		vi.advanceTimersByTime(1_000);
		memory_store_for_tests.sweep();
		expect(hits.has(a)).toBe(false);
	});
});

describe('RateLimiter (shared)', () => {
	it('counts in Postgres per fixed window', async () => {
		const query = vi.fn().mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValueOnce({ rows: [{ count: 2 }] });
		use_shared_rate_limits({ query } as unknown as Pool);
		const limiter = new RateLimiter(1, 60_000);
		expect(await limiter.hit('x')).toBe(true);
		expect(await limiter.hit('x')).toBe(false);
		expect(query.mock.calls[0][1][0]).toBe('x');
		expect((query.mock.calls[0][1][1] as Date).getTime() % 60_000).toBe(0);
	});

	it('falls back to memory when the store fails', async () => {
		use_shared_rate_limits({ query: vi.fn().mockRejectedValue(new Error('down')) } as unknown as Pool);
		const limiter = new RateLimiter(1, 1_000);
		const a = key();
		expect(await limiter.hit(a)).toBe(true);
		expect(await limiter.hit(a)).toBe(false);
	});
});

describe('rate_limit_user', () => {
	const run = async (mw: ReturnType<typeof rate_limit_user>, req: Partial<Request>) => {
		const next = vi.fn();
		await mw(req as Request, {} as never, next);
		return next;
	};

	it('limits per user and throws 429', async () => {
		const mw = rate_limit_user(key(), 1, 1_000);
		expect(await run(mw, { user: { id: 'u1' } as never })).toHaveBeenCalledOnce();
		await expect(run(mw, { user: { id: 'u1' } as never })).rejects.toThrow(HttpError);
		expect(await run(mw, { user: { id: 'u2' } as never })).toHaveBeenCalledOnce();
	});

	it('falls back to the ip without a user', async () => {
		const mw = rate_limit_user(key(), 1, 1_000);
		await run(mw, { ip: '1.2.3.4' });
		await expect(run(mw, { ip: '1.2.3.4' })).rejects.toMatchObject({ status: 429 });
		expect(await run(mw, { ip: '5.6.7.8' })).toHaveBeenCalledOnce();
	});
});
