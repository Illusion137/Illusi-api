export interface CliOptions {
	/** A pass to run immediately at startup. */
	initial: 'full' | 'incremental' | null;
	dry_run: boolean;
	/** Run `initial` (default incremental) once and exit instead of staying up as a scheduler. */
	once: boolean;
}

export const USAGE = 'usage: worker:reconcile [--full | --incremental] [--dry-run] [--once]';

/** `--full` / `--incremental` pick the pass to start with, `--once` exits after it, `--dry-run` writes nothing. */
export function parse_args(argv: readonly string[], dry_run_default: boolean): CliOptions {
	const opts: CliOptions = { initial: null, dry_run: dry_run_default, once: false };
	for (const arg of argv) {
		switch (arg) {
			case '--full': opts.initial = 'full'; break;
			case '--incremental': opts.initial = 'incremental'; break;
			case '--dry-run': opts.dry_run = true; break;
			case '--once': opts.once = true; break;
			default: throw new Error(`unknown argument ${arg}\n${USAGE}`);
		}
	}
	if (opts.once) opts.initial ??= 'incremental';
	return opts;
}

/** Local calendar day, used to run the nightly full pass once per day. */
export function local_day(d: Date): string {
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** The nightly full pass is due once the configured hour has been reached and it hasn't run today. */
export function full_pass_due(now: Date, last_full_day: string | null, hour: number): boolean {
	return now.getHours() >= hour && last_full_day !== local_day(now);
}
