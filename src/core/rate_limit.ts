import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './http';

/** In-memory sliding-window limiter (single process). */
export class RateLimiter {
	private hits = new Map<string, number[]>();

	constructor(private limit: number, private window_ms: number) {
		setInterval(() => this.sweep(), Math.max(window_ms, 60_000)).unref();
	}

	/** Records a hit; returns false if `key` is over the limit. */
	hit(key: string): boolean {
		const now = Date.now();
		const list = (this.hits.get(key) ?? []).filter(t => now - t < this.window_ms);
		if (list.length >= this.limit) {
			this.hits.set(key, list);
			return false;
		}
		list.push(now);
		this.hits.set(key, list);
		return true;
	}

	private sweep() {
		const now = Date.now();
		for (const [key, list] of this.hits) {
			const kept = list.filter(t => now - t < this.window_ms);
			if (kept.length === 0) this.hits.delete(key);
			else this.hits.set(key, kept);
		}
	}
}

/** Per-user limit for authenticated routes; falls back to IP if there is no user. */
export function rate_limit_user(name: string, limit: number, window_ms: number) {
	const limiter = new RateLimiter(limit, window_ms);
	return (req: Request, _res: Response, next: NextFunction) => {
		const key = req.user?.id ?? `ip:${req.ip}`;
		if (!limiter.hit(`${name}:${key}`)) throw new HttpError(429, 'rate limited');
		next();
	};
}
