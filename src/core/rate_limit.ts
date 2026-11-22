import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { HttpError } from './http';
import { logger } from './log';

const log = logger('rate_limit');

/** Counts hits per key; `hit` resolves false once `key` is over `limit` in the window. */
interface RateStore {
	hit(key: string, limit: number, window_ms: number): Promise<boolean>;
}

/** Sliding window in this process's memory. */
class MemoryStore implements RateStore {
	private hits = new Map<string, { window_ms: number; times: number[] }>();

	constructor() {
		setInterval(() => this.sweep(), 60_000).unref();
	}

	async hit(key: string, limit: number, window_ms: number): Promise<boolean> {
		return this.hit_now(key, limit, window_ms);
	}

	hit_now(key: string, limit: number, window_ms: number): boolean {
		const now = Date.now();
		const times = (this.hits.get(key)?.times ?? []).filter(t => now - t < window_ms);
		if (times.length >= limit) {
			this.hits.set(key, { window_ms, times });
			return false;
		}
		times.push(now);
		this.hits.set(key, { window_ms, times });
		return true;
	}

	sweep() {
		const now = Date.now();
		for (const [key, entry] of this.hits) {
			const kept = entry.times.filter(t => now - t < entry.window_ms);
			if (kept.length === 0) this.hits.delete(key);
			else entry.times = kept;
		}
	}

	get size() {
		return this.hits.size;
	}
}

/**
 * Fixed windows in `rate_limit_counters_table`, shared by every API process (replicas during a rollout included).
 * Runs on its own owner-connection pool, so it never competes with request queries or row-level security.
 */
class PostgresStore implements RateStore {
	constructor(private pool: Pool, private fallback: MemoryStore) {}

	async hit(key: string, limit: number, window_ms: number): Promise<boolean> {
		const window_start = new Date(Math.floor(Date.now() / window_ms) * window_ms);
		try {
			const { rows } = await this.pool.query<{ count: number }>(
				`insert into rate_limit_counters_table (key, window_start, count) values ($1, $2, 1)
				 on conflict (key, window_start) do update set count = rate_limit_counters_table.count + 1
				 returning count`,
				[key.slice(0, 256), window_start]
			);
			return rows[0].count <= limit;
		} catch (err) {
			// Never refuse traffic because the counter store is down.
			log.warn('shared rate limit store failed; counting in memory', err);
			return this.fallback.hit(key, limit, window_ms);
		}
	}
}

const memory = new MemoryStore();
let store: RateStore = memory;

/** Switches every limiter to the shared Postgres counters (the API server calls this at startup). */
export function use_shared_rate_limits(pool: Pool) {
	store = new PostgresStore(pool, memory);
}

/** Back to in-process counting (tests). */
export function use_memory_rate_limits() {
	store = memory;
}

export class RateLimiter {
	constructor(private limit: number, private window_ms: number) {}

	/** Records a hit; resolves false if `key` is over the limit. */
	async hit(key: string): Promise<boolean> {
		return store.hit(key, this.limit, this.window_ms);
	}
}

/** Per-user limit for authenticated routes; falls back to IP if there is no user. */
export function rate_limit_user(name: string, limit: number, window_ms: number) {
	const limiter = new RateLimiter(limit, window_ms);
	return async (req: Request, _res: Response, next: NextFunction) => {
		const key = req.user?.id ?? `ip:${req.ip}`;
		if (!(await limiter.hit(`${name}:${key}`))) throw new HttpError(429, 'rate limited');
		next();
	};
}

/** For tests: the in-memory store. */
export const memory_store_for_tests = memory;
