/**
 * Hourly housekeeping for tables that only ever grow: push replays, rotated and expired sessions, used action
 * tokens, verification links and reset codes, never-verified accounts and rate-limit counters. Runs in the process
 * holding the cleanup leader lock, on the owner connection. Deletes in batches so no run holds long locks.
 */
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';
import { logger } from './log';

const log = logger('cleanup');

const EVERY_MS = 60 * 60_000;
const BATCH = 5_000;

/** The tasks, each a table and the rows of it that can go. Exported for tests. */
export function cleanup_tasks(): { name: string; table: string; where: SQL }[] {
	// Rotated sessions stay as long as reuse detection and the lost-response grace can still look at them.
	const rotated_days = Math.max(7, config.REFRESH_LOST_RESPONSE_DAYS);
	return [
		{ name: 'sync_pushes', table: 'sync_pushes_table', where: sql`created_at < now() - make_interval(days => ${config.SYNC_PUSH_RETENTION_DAYS})` },
		{ name: 'sessions', table: 'sessions_table', where: sql`expires_at < now() or revoked_at < now() - make_interval(days => ${rotated_days})` },
		{ name: 'action_token_uses', table: 'action_token_uses_table', where: sql`expires_at < now()` },
		{ name: 'email_verifications', table: 'email_verifications_table', where: sql`expires_at < now() - interval '1 day' or used_at < now() - interval '1 day'` },
		{ name: 'password_resets', table: 'password_resets_table', where: sql`expires_at < now() - interval '1 day'` },
		// A never-verified account never reached anything outside /auth, so it has nothing to keep.
		{ name: 'unverified_users', table: 'users_table', where: sql`email_verified_at is null and created_at < now() - make_interval(days => ${config.UNVERIFIED_ACCOUNT_TTL_DAYS})` },
		{ name: 'rate_limit_counters', table: 'rate_limit_counters_table', where: sql`window_start < now() - interval '1 day'` },
		// Downloads recorded for logins that have ended (expired rather than logged out, which already clears them).
		{
			name: 'track_downloads', table: 'track_downloads_table',
			where: sql`not exists(select 1 from sessions_table s where s.family_id = track_downloads_table.session_family_id and s.revoked_at is null and s.expires_at > now())`
		}
	];
}

async function delete_batches(table: string, where: SQL): Promise<number> {
	let total = 0;
	for (;;) {
		const rows = await db.execute<{ n: number }>(sql`
			with gone as (delete from ${sql.identifier(table)} where ctid in (select ctid from ${sql.identifier(table)} where ${where} limit ${BATCH}) returning 1)
			select count(*)::int as n from gone
		`, 'objects');
		const n = rows[0]?.n ?? 0;
		total += n;
		if (n < BATCH) return total;
	}
}

export async function run_cleanup(): Promise<Record<string, number>> {
	const removed: Record<string, number> = {};
	for (const task of cleanup_tasks()) {
		try {
			removed[task.name] = await delete_batches(task.table, task.where);
		} catch (err) {
			log.warn(`cleanup of ${task.name} failed`, err);
		}
	}
	if (Object.values(removed).some(n => n > 0)) log.info('cleanup removed rows', removed);
	return removed;
}

let timer: NodeJS.Timeout | undefined;

export async function start(): Promise<void> {
	if (timer) return;
	void run_cleanup();
	timer = setInterval(() => { void run_cleanup(); }, EVERY_MS);
	timer.unref();
}

export async function stop(): Promise<void> {
	clearInterval(timer);
	timer = undefined;
}
