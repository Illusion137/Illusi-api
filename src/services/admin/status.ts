import { statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import { count, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import { export_jobs_table, review_items_table, service_id_conflicts_table, tracks_table, users_table } from '../../db/schema';
import { is_draining, ping_database, uptime_s } from '../../core/health';
import { LEADER_LOCKS } from '../../core/leader';
import { check_health } from '../analyzer/client';
import { list_log_files } from './logs';

const GB = 1024 ** 3;
const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latency_ms: number }> {
	const start = performance.now();
	const value = await fn();
	return { value, latency_ms: Math.round(performance.now() - start) };
}

async function disk() {
	try {
		const s = await statfs(config.MEDIA_DIR);
		const free_gb = round(s.bavail * s.bsize / GB);
		return {
			ok: free_gb >= config.DISK_WARN_FREE_GB,
			path: config.MEDIA_DIR,
			free_gb,
			total_gb: round(s.blocks * s.bsize / GB),
			warn_below_gb: config.DISK_WARN_FREE_GB,
			uploads_refused: free_gb < config.DISK_MIN_FREE_GB,
			uploads_refused_below_gb: config.DISK_MIN_FREE_GB
		};
	} catch (err) {
		return { ok: false, path: config.MEDIA_DIR, error: (err as Error).message };
	}
}

async function analyzer() {
	const { value: ok, latency_ms } = await timed(() => check_health(config.ANALYZER_URL));
	return { ok, latency_ms, url: config.ANALYZER_URL };
}

/** Every Illusi connection to this database, grouped by process (application name and container address). */
async function connections() {
	return db.execute<{ application_name: string; client_addr: string | null; connections: number; active: number; since: string }>(sql`
		select application_name, client_addr::text as client_addr, count(*)::int as connections,
			(count(*) filter (where state = 'active'))::int as active, min(backend_start) as since
		from pg_stat_activity
		where datname = current_database() and application_name like 'illusi%'
		group by 1, 2 order by 1, 2
	`, 'objects');
}

async function leaders() {
	const keys = Object.values(LEADER_LOCKS);
	const rows = await db.execute<{ key: number; application_name: string; client_addr: string | null; since: string }>(sql`
		select l.objid::int as key, a.application_name, a.client_addr::text as client_addr, a.backend_start as since
		from pg_locks l join pg_stat_activity a on a.pid = l.pid
		where l.locktype = 'advisory' and l.granted and l.classid = 0 and l.objsubid = 1
			and l.objid in (${sql.join(keys.map(k => sql`${k}`), sql`, `)})
	`, 'objects');
	return Object.entries(LEADER_LOCKS).map(([role, key]) => {
		const holder = rows.find(r => r.key === key);
		return { role, held: holder !== undefined, client_addr: holder?.client_addr ?? null, since: holder?.since ?? null };
	});
}

async function queues() {
	const [review, conflicts, [backpacked], exports, [users]] = await Promise.all([
		db.select({ kind: review_items_table.kind, n: count() }).from(review_items_table).where(eq(review_items_table.status, 'OPEN')).groupBy(review_items_table.kind),
		db.select({ status: service_id_conflicts_table.status, n: count() }).from(service_id_conflicts_table)
			.where(inArray(service_id_conflicts_table.status, ['open', 'deferred'])).groupBy(service_id_conflicts_table.status),
		db.select({ n: count() }).from(tracks_table).where(eq(tracks_table.backpacked, true)),
		db.select({ status: export_jobs_table.status, n: count() }).from(export_jobs_table)
			.where(inArray(export_jobs_table.status, ['PENDING', 'RUNNING', 'FAILED'])).groupBy(export_jobs_table.status),
		db.select({ total: count(), unverified: sql<number>`(count(*) filter (where ${users_table.email_verified_at} is null))::int` }).from(users_table)
	]);
	return {
		review: Object.fromEntries(review.map(r => [r.kind, r.n])),
		service_id_conflicts: Object.fromEntries(conflicts.map(r => [r.status, r.n])),
		backpacked_tracks: backpacked.n,
		exports: Object.fromEntries(exports.map(r => [r.status, r.n])),
		users
	};
}

/** When each service last wrote to today's log file: the worker has no health endpoint, this shows it's alive. */
async function log_activity() {
	if (!config.LOG_DIR) return [];
	const today = new Date().toISOString().slice(0, 10);
	return (await list_log_files()).filter(f => f.day === today).map(f => ({ service: f.service, last_write: f.modified_at, size: f.size }));
}

/** A live snapshot. Process figures are for the replica that answered; the database view covers every process. */
export async function system_status() {
	const pool = db.$client;
	const [database, db_size, conns, leader_rows, analyzer_status, disk_status, queue_counts, logs] = await Promise.all([
		ping_database(),
		db.execute<{ bytes: string }>(sql`select pg_database_size(current_database())::text as bytes`, 'objects'),
		connections(),
		leaders(),
		analyzer(),
		disk(),
		queues(),
		log_activity()
	]);
	const memory = process.memoryUsage();
	return {
		time: new Date().toISOString(),
		process: {
			host: hostname(),
			pid: process.pid,
			version: config.APP_VERSION,
			node: process.version,
			environment: config.NODE_ENV,
			uptime_s: uptime_s(),
			draining: is_draining(),
			memory_mb: { rss: round(memory.rss / 2 ** 20), heap_used: round(memory.heapUsed / 2 ** 20) },
			background_services: config.BACKGROUND_SERVICES
		},
		database: {
			...database,
			size_gb: round(Number(db_size[0]?.bytes ?? 0) / GB, 2),
			pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
			connections: conns
		},
		leaders: leader_rows,
		analyzer: analyzer_status,
		disk: disk_status,
		queues: queue_counts,
		logs
	};
}
