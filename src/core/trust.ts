import { config } from '../config';

/** What decides whether one user's report may count toward an automatic consensus. */
export interface Reporter {
	user_id: string;
	account_created_at: Date;
	signup_ip_prefix: string | null;
	/** The reporter has the entity in their (non-deleted) library. */
	in_library: boolean;
}

/**
 * Accounts at least TRUSTED_ACCOUNT_MIN_AGE_DAYS old that have the entity in their library. Throwaway accounts made to
 * outvote real users are new and have no library, so they don't count (their reports are still stored for review).
 */
export function is_trusted(reporter: Reporter, now = new Date()): boolean {
	return reporter.in_library && now.getTime() - reporter.account_created_at.getTime() >= config.TRUSTED_ACCOUNT_MIN_AGE_DAYS * 86_400_000;
}

/**
 * The reports that count: trusted reporters only, one per signup network (the first report from each /24 or /48;
 * accounts without a recorded network count on their own). Input order decides which report of a network counts.
 */
export function counted_reports<T extends Reporter>(reports: readonly T[], now = new Date()): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const report of reports) {
		if (!is_trusted(report, now)) continue;
		const network = report.signup_ip_prefix ?? `user:${report.user_id}`;
		if (seen.has(network)) continue;
		seen.add(network);
		out.push(report);
	}
	return out;
}
