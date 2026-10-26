// Reconciliation worker: a separate process, `npm run worker:reconcile`. Shares the database and `src/db`.
import '../instrument';
import * as Sentry from '@sentry/node';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../core/log';
import { full_pass_due, local_day, parse_args } from './reconcile/cli';
import { run_pass } from './reconcile/run';
import { thresholds_from_config } from './reconcile/thresholds';

const log = logger('reconcile');
const TICK_MS = 60_000;

async function main() {
	const opts = parse_args(process.argv.slice(2), config.RECONCILE_DRY_RUN);
	const thresholds = thresholds_from_config();
	const pass = async (mode: 'full' | 'incremental') => {
		const report = await run_pass({ mode, dry_run: opts.dry_run, thresholds });
		if (opts.dry_run && report.plans) console.log(JSON.stringify(report.plans, null, '\t'));
		return report;
	};

	if (opts.once) {
		await pass(opts.initial ?? 'incremental');
		await db.$client.end();
		return;
	}

	let stopping = false;
	let running = false;
	let timer: NodeJS.Timeout | null = null;
	let last_full_day: string | null = null;
	let last_incremental = 0;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		log.info('stopping');
		if (timer) clearTimeout(timer);
		// A running pass finishes its current group transaction and the tick loop ends the pool.
		if (!running) void db.$client.end();
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);

	if (opts.initial === 'full') last_full_day = local_day(new Date());
	if (opts.initial) await pass(opts.initial);
	if (opts.initial) last_incremental = Date.now();

	const interval_ms = config.RECONCILE_INCREMENTAL_INTERVAL_MIN * 60_000;
	log.info(`scheduler up: incremental every ${config.RECONCILE_INCREMENTAL_INTERVAL_MIN} min, full pass daily from ${config.RECONCILE_FULL_HOUR}:00${opts.dry_run ? ', dry run' : ''}`);
	const tick = async () => {
		running = true;
		try {
			const now = new Date();
			if (full_pass_due(now, last_full_day, config.RECONCILE_FULL_HOUR)) {
				last_full_day = local_day(now);
				await pass('full');
				last_incremental = Date.now();
			} else if (Date.now() - last_incremental >= interval_ms) {
				last_incremental = Date.now();
				await pass('incremental');
			}
		} catch (err) {
			log.error('pass failed', err);
		}
		running = false;
		if (stopping) {
			await db.$client.end();
			return;
		}
		timer = setTimeout(() => void tick(), TICK_MS);
	};
	await tick();
}

main().catch((err: unknown) => {
	log.error('worker crashed', err);
	void Sentry.close(2_000).finally(() => process.exit(1));
});
