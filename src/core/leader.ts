import { Client } from 'pg';
import { logger } from './log';

const log = logger('leader');

/** Advisory lock keys. One per singleton role; the value is arbitrary but must never change. */
export const LEADER_LOCKS = { background_services: 7_340_001 } as const;

export interface LeaderHandle { stop(): Promise<void> }

/**
 * Runs `start` only while this process holds a session-level Postgres advisory lock, so during a
 * rolling deploy (two API containers side by side) the in-process queues never run twice. The
 * standby retries every `retry_ms`. When the old container stops, its session ends, the lock is
 * released, and the new one takes over. If the lock connection drops, `stop` runs and it retries.
 */
export function run_as_leader(name: string, key: number, start: () => Promise<void>, stop: () => Promise<void>, retry_ms = 5_000): LeaderHandle {
	let client: Client | null = null;
	let leading = false;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let attempt: Promise<void> = Promise.resolve();

	const step_down = async () => {
		if (!leading) return;
		leading = false;
		log.info(`${name}: stepping down`);
		await stop().catch((err: unknown) => log.error(`${name}: stop failed`, err));
	};

	const schedule = () => {
		if (!stopped) timer = setTimeout(() => { attempt = try_acquire(); }, retry_ms);
	};

	const try_acquire = async () => {
		try {
			client = new Client({ connectionString: process.env.DATABASE_URL, application_name: `illusi-leader-${name}` });
			client.on('error', (err) => {
				// Errors while acquiring are handled by the catch below.
				if (!leading) return;
				log.warn(`${name}: lock connection lost`, err);
				client = null;
				void step_down().then(schedule);
			});
			await client.connect();
			const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [key]);
			if (!rows[0]?.locked) {
				await client.end().catch(() => undefined);
				client = null;
				schedule();
				return;
			}
			if (stopped) {
				await client.end().catch(() => undefined);
				return;
			}
			leading = true;
			log.info(`${name}: acquired leadership`);
			await start();
		} catch (err) {
			log.warn(`${name}: could not acquire leadership`, err);
			await client?.end().catch(() => undefined);
			client = null;
			schedule();
		}
	};

	attempt = try_acquire();

	return {
		async stop() {
			stopped = true;
			clearTimeout(timer);
			await attempt;
			await step_down();
			await client?.end().catch(() => undefined);
			client = null;
		}
	};
}
