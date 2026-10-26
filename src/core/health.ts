import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { config } from '../config';
import { db } from '../db';

const started_at = Date.now();
let draining = false;

/** Called on SIGTERM: health turns 503 so nothing new is routed here while in-flight requests finish. */
export function set_draining() {
	draining = true;
}

export function is_draining() {
	return draining;
}

const DB_TIMEOUT_MS = 2_000;

async function ping_database(): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
	const start = performance.now();
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			db.execute(sql`select 1`),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS); })
		]);
		return { ok: true, latency_ms: Math.round(performance.now() - start) };
	} catch (err) {
		return { ok: false, latency_ms: Math.round(performance.now() - start), error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Public, unauthenticated.
 * - `GET /health`: readiness. 200 only when the database answers and the instance isn't draining;
 *   the compose healthcheck (and so `docker rollout`) waits on this.
 * - `GET /health/live`: the process is up, nothing else is checked.
 */
export const health_router = Router();

health_router.get('/health/live', (_req, res) => {
	res.json({ ok: true });
});

health_router.get('/health', async (_req, res) => {
	const database = await ping_database();
	const ok = database.ok && !draining;
	res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({
		ok,
		status: draining ? 'draining' : database.ok ? 'ok' : 'degraded',
		version: config.APP_VERSION,
		uptime_s: Math.round((Date.now() - started_at) / 1000),
		checks: { database }
	});
});
