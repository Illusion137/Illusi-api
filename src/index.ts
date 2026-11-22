import './instrument';
import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import { config } from './config';
import { create_app } from './app';
import { create_pool, db } from './db';
import { start_disk_monitor } from './core/disk';
import { start_event_bridge } from './core/events';
import { set_draining } from './core/health';
import { LEADER_LOCKS, run_as_leader } from './core/leader';
import type { LeaderHandle } from './core/leader';
import { logger } from './core/log';
import { use_shared_rate_limits } from './core/rate_limit';
import * as cleanup from './core/cleanup';
import * as exports_runner from './services/account/export';
import * as analyzer from './services/analyzer';
import * as itunes from './services/itunes';

const log = logger('server');

const services = [['itunes', itunes], ['analyzer', analyzer]] as const;

/** Waits for Postgres before listening, so a fresh container never takes traffic it can't serve. */
async function wait_for_database(timeout_ms = 60_000) {
	const deadline = Date.now() + timeout_ms;
	for (;;) {
		try {
			await db.execute(sql`select 1`);
			return;
		} catch (err) {
			if (Date.now() > deadline) throw err;
			log.warn('database not ready, retrying');
			await new Promise(resolve => setTimeout(resolve, 1_000));
		}
	}
}

async function main() {
	await wait_for_database();
	const app = create_app();
	const server = app.listen(config.PORT, () => log.info(`listening on :${config.PORT} (${config.APP_VERSION})`));
	server.keepAliveTimeout = 65_000;
	server.requestTimeout = config.REQUEST_TIMEOUT_MS;
	use_shared_rate_limits(create_pool({ max: 4 }));
	const stop_disk_monitor = start_disk_monitor();
	const stop_event_bridge = start_event_bridge();

	// Background services never block startup or request handling, and run in one instance at a time.
	let leader: LeaderHandle | null = null;
	if (config.BACKGROUND_SERVICES) {
		leader = run_as_leader('background', LEADER_LOCKS.background_services, async () => {
			for (const [name, service] of services) {
				service.start().catch((err: unknown) => log.error(`${name} failed to start`, err));
			}
		}, async () => {
			await Promise.allSettled(services.map(([, service]) => service.stop()));
		});
	}

	// Data exports run whatever BACKGROUND_SERVICES says (users wait on them), in one instance at a time.
	const exports_leader = run_as_leader('exports', LEADER_LOCKS.exports, exports_runner.start, exports_runner.stop);
	// Housekeeping for tables that only grow; like exports it runs whatever BACKGROUND_SERVICES says.
	const cleanup_leader = run_as_leader('cleanup', LEADER_LOCKS.cleanup, cleanup.start, cleanup.stop);

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log.info(`${signal}: draining`);
		set_draining();
		stop_disk_monitor();
		// Stop accepting connections (the proxy retries refused ones on the other replica), drop idle
		// keep-alives, and give in-flight requests until the grace period to finish.
		const closed = new Promise<void>(resolve => server.close(() => resolve()));
		server.closeIdleConnections();
		const grace = new Promise<void>(resolve => setTimeout(resolve, config.SHUTDOWN_GRACE_MS).unref());
		await Promise.race([closed, grace]);
		server.closeAllConnections();
		await leader?.stop();
		await exports_leader.stop();
		await cleanup_leader.stop();
		await stop_event_bridge();
		await db.$client.end().catch(() => undefined);
		log.info('stopped');
		await Sentry.close(2_000);
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
	log.error('failed to start', err);
	void Sentry.close(2_000).finally(() => process.exit(1));
});
