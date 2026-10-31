import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import {
	contributions_log_table, export_jobs_table, linked_playlists_table, media_table, playlist_inherited_playlists_table,
	playlist_inherited_searches_table, playlist_tracks_table, playlists_table, sessions_table, track_plays_table,
	track_unavailable_reports_table, user_recent_searches, user_tracks_table
} from '../../db/schema';
import { free_bytes } from '../../core/disk';
import { on } from '../../core/events';
import { logger } from '../../core/log';
import { track_views } from '../catalog/views';
import { load_user } from '../sync/rows';

const log = logger('export');

export type ExportJob = typeof export_jobs_table.$inferSelect;

/** Export files live in a hidden folder of MEDIA_DIR: not backed up, never served except through the export route. */
export const EXPORTS_SUBDIR = '.exports';
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.gz$/u;
const PAGE = 1_000;
const TRACK_BATCH = 200;
const POLL_MS = 10_000;
const CLEANUP_EVERY_MS = 60 * 60_000;
/** Finished, failed and expired job rows are kept this long (the cooldown is computed from them). */
const KEEP_ROWS_DAYS = 30;
const GB = 1024 ** 3;
/** A job still writing after this long is abandoned (failed), so one stuck export can't block the queue. */
const JOB_DEADLINE_MS = 30 * 60_000;
const STOP_WAIT_MS = 5_000;
export const EXPORT_FORMAT_VERSION = 1;

export function exports_dir(): string {
	return path.join(config.MEDIA_DIR, EXPORTS_SUBDIR);
}

/** Absolute path of an export file, or null for a name that isn't one. */
export function export_path(file_name: string): string | null {
	return FILE_RE.test(file_name) ? path.join(exports_dir(), file_name) : null;
}

export async function remove_export_files(file_names: readonly (string | null)[]) {
	for (const name of file_names) {
		const file = name ? export_path(name) : null;
		if (file) await rm(file, { force: true }).catch((err: unknown) => log.warn('could not remove export file', { file_name: name, err }));
	}
}

/** What clients see of a job. */
export function job_view(job: ExportJob) {
	return {
		id: job.id,
		status: job.status,
		created_at: job.created_at,
		started_at: job.started_at,
		finished_at: job.finished_at,
		expires_at: job.expires_at,
		size: job.size,
		error: job.error
	};
}

/** Streams JSON text through gzip into a file, honouring backpressure. */
class JsonGzWriter {
	private gzip = createGzip();
	private done: Promise<void>;
	private failed: Error | null = null;

	constructor(file: string, private deadline = Date.now() + JOB_DEADLINE_MS) {
		this.done = pipeline(this.gzip, createWriteStream(file, { flags: 'wx' }));
		this.done.catch((err: unknown) => { this.failed = err instanceof Error ? err : new Error(String(err)); });
	}

	private check() {
		if (this.failed) throw this.failed;
		if (Date.now() > this.deadline) throw new Error('export took too long');
	}

	async write(text: string) {
		this.check();
		if (!this.gzip.write(text)) await Promise.race([once(this.gzip, 'drain'), this.done]);
		this.check();
	}

	async end() {
		this.gzip.end();
		await this.done;
	}

	destroy() {
		this.gzip.destroy();
	}
}

/** Writes `"key":[...]` from pages of rows, separating items with commas. */
async function write_array<T>(out: JsonGzWriter, key: string, pages: AsyncIterable<T[]>, first = false) {
	await out.write(`${first ? '' : ','}${JSON.stringify(key)}:[`);
	let n = 0;
	for await (const rows of pages) {
		for (const row of rows) await out.write(`${n++ === 0 ? '' : ','}${JSON.stringify(row)}`);
	}
	await out.write(']');
}

async function* single<T>(rows: Promise<T[]>): AsyncIterable<T[]> {
	yield await rows;
}

/**
 * Writes every piece of personal data the server holds about `user_id` as one JSON document, plus a `tracks` map
 * with the catalog view of every track it mentions, so the file reads on its own.
 */
export async function write_export(user_id: string, file: string): Promise<void> {
	const out = new JsonGzWriter(file);
	const track_ids = new Set<string>();
	const note = <T extends { track_id: string }>(rows: T[]) => {
		for (const r of rows) track_ids.add(r.track_id);
		return rows;
	};
	try {
		const user = await load_user(db, user_id);
		if (!user) throw new Error('user not found');
		await out.write(`{"format":"illusi-export","version":${EXPORT_FORMAT_VERSION},"exported_at":${JSON.stringify(new Date())},"user":${JSON.stringify(user)}`);

		await write_array(out, 'sessions', single(db.select({
			device_name: sessions_table.device_name,
			created_at: sessions_table.created_at,
			last_used_at: sessions_table.last_used_at,
			expires_at: sessions_table.expires_at,
			revoked_at: sessions_table.revoked_at
		}).from(sessions_table).where(eq(sessions_table.user_id, user_id)).orderBy(asc(sessions_table.created_at))));

		await write_array(out, 'library', (async function* () {
			let after: string | null = null;
			for (;;) {
				const rows: (typeof user_tracks_table.$inferSelect)[] = await db.select().from(user_tracks_table)
					.where(and(eq(user_tracks_table.user_id, user_id), after === null ? undefined : gt(user_tracks_table.track_id, after)))
					.orderBy(asc(user_tracks_table.track_id)).limit(PAGE);
				if (rows.length === 0) return;
				yield note(rows);
				after = rows[rows.length - 1].track_id;
			}
		})());

		await write_array(out, 'playlists', (async function* () {
			const playlists = await db.select().from(playlists_table).where(eq(playlists_table.user_id, user_id)).orderBy(asc(playlists_table.created_at));
			for (const playlist of playlists) {
				const [tracks, inherited_searches, inherited_playlists] = await Promise.all([
					db.select().from(playlist_tracks_table).where(eq(playlist_tracks_table.playlist_id, playlist.id))
						.orderBy(asc(playlist_tracks_table.created_at), asc(playlist_tracks_table.track_id)),
					db.select().from(playlist_inherited_searches_table).where(eq(playlist_inherited_searches_table.playlist_id, playlist.id))
						.orderBy(asc(playlist_inherited_searches_table.id)),
					db.select().from(playlist_inherited_playlists_table).where(eq(playlist_inherited_playlists_table.playlist_id, playlist.id))
						.orderBy(asc(playlist_inherited_playlists_table.id))
				]);
				yield [{ ...playlist, tracks: note(tracks), inherited_searches, inherited_playlists }];
			}
		})());

		await write_array(out, 'linked_playlists', single(db.select().from(linked_playlists_table)
			.where(eq(linked_playlists_table.user_id, user_id)).orderBy(asc(linked_playlists_table.created_at))));

		await write_array(out, 'plays', (async function* () {
			let after = 0;
			for (;;) {
				const rows = await db.select({ id: track_plays_table.id, track_id: track_plays_table.track_id, client_id: track_plays_table.client_id, created_at: track_plays_table.created_at })
					.from(track_plays_table).where(and(eq(track_plays_table.user_id, user_id), gt(track_plays_table.id, after)))
					.orderBy(asc(track_plays_table.id)).limit(PAGE);
				if (rows.length === 0) return;
				yield note(rows);
				after = rows[rows.length - 1].id;
			}
		})());

		await write_array(out, 'recent_searches', single(db.select({ text: user_recent_searches.text, client_id: user_recent_searches.client_id, created_at: user_recent_searches.created_at })
			.from(user_recent_searches).where(eq(user_recent_searches.user_id, user_id)).orderBy(asc(user_recent_searches.created_at))));

		await write_array(out, 'unavailable_reports', single(db.select().from(track_unavailable_reports_table)
			.where(eq(track_unavailable_reports_table.user_id, user_id)).then(note)));

		await write_array(out, 'media_uploads', single(db.select({
			track_id: media_table.track_id,
			resource_id: media_table.resource_id,
			quality: media_table.quality,
			content_hash: media_table.content_hash,
			created_at: media_table.created_at
		}).from(media_table).where(eq(media_table.uploaded_by, user_id)).orderBy(asc(media_table.created_at)).then(note)));

		// Paged by id: timestamps come back with millisecond precision while Postgres keeps microseconds.
		await write_array(out, 'contributions', (async function* () {
			let after: string | null = null;
			for (;;) {
				const rows: { id: string; contribution_id: string | null; source: string; entities: unknown; received_at: Date }[] = await db.select({
					id: contributions_log_table.id,
					contribution_id: contributions_log_table.contribution_id,
					source: contributions_log_table.source,
					entities: contributions_log_table.entities,
					received_at: contributions_log_table.received_at
				}).from(contributions_log_table)
					.where(and(eq(contributions_log_table.user_id, user_id), after === null ? undefined : gt(contributions_log_table.id, after)))
					.orderBy(asc(contributions_log_table.id)).limit(PAGE);
				if (rows.length === 0) return;
				yield rows;
				after = rows[rows.length - 1].id;
			}
		})());

		// The catalog side of every track mentioned above, keyed by id.
		await out.write(',"tracks":{');
		const ids = [...track_ids].sort();
		let n = 0;
		for (let i = 0; i < ids.length; i += TRACK_BATCH) {
			const views = await track_views(db, user_id, ids.slice(i, i + TRACK_BATCH));
			for (const [id, view] of views) await out.write(`${n++ === 0 ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(view)}`);
		}
		await out.write('}}');
		await out.end();
	} catch (err) {
		out.destroy();
		throw err;
	}
}

let running = false;
let wake: (() => void) | null = null;
let loop_done: Promise<void> = Promise.resolve();
let cleanup_timer: NodeJS.Timeout | undefined;

on('export_requested', () => { wake?.(); });

/** Claims the oldest pending job, if any. */
async function claim(): Promise<ExportJob | null> {
	const rows = await db.execute<ExportJob>(sql`
		update ${export_jobs_table} set status = 'RUNNING', started_at = now()
		where id = (
			select id from ${export_jobs_table} where status = 'PENDING' order by created_at limit 1 for update skip locked
		)
		returning id, user_id, status, file_name, size, error, created_at, started_at, finished_at, expires_at`);
	return rows.rows[0] ?? null;
}

async function finish(id: string, values: Partial<ExportJob>) {
	return db.update(export_jobs_table).set({ finished_at: new Date(), ...values }).where(eq(export_jobs_table.id, id)).returning({ id: export_jobs_table.id });
}

export async function run_job(job: ExportJob): Promise<void> {
	await mkdir(exports_dir(), { recursive: true });
	const file_name = `${job.id}.json.gz`;
	const file = path.join(exports_dir(), file_name);
	const part = `${file}.part`;
	try {
		if (await free_bytes().then(b => b < config.DISK_MIN_FREE_GB * GB, () => false)) {
			await finish(job.id, { status: 'FAILED', error: 'server storage is full; try again later' });
			log.warn('export refused: disk full', { job_id: job.id });
			return;
		}
		const started = performance.now();
		await write_export(job.user_id, part);
		await rename(part, file);
		const size = (await stat(file)).size;
		const updated = await finish(job.id, {
			status: 'READY',
			file_name,
			size,
			expires_at: new Date(Date.now() + config.EXPORT_TTL_DAYS * 86_400_000)
		});
		// The account was deleted meanwhile: its job row went with it.
		if (updated.length === 0) await rm(file, { force: true });
		else log.info('export ready', { job_id: job.id, user_id: job.user_id, bytes: size, duration_ms: Math.round(performance.now() - started) });
	} catch (err) {
		await rm(part, { force: true });
		await rm(file, { force: true });
		log.error('export failed', { job_id: job.id, user_id: job.user_id, err });
		await finish(job.id, { status: 'FAILED', error: 'export failed; request a new one' }).catch(() => undefined);
	}
}

/** Expires ready exports past `expires_at` (their files are removed) and forgets old finished jobs. */
export async function cleanup_exports(): Promise<void> {
	await db.update(export_jobs_table).set({ status: 'EXPIRED', file_name: null })
		.where(and(eq(export_jobs_table.status, 'READY'), lt(export_jobs_table.expires_at, new Date())));
	const keep_after = new Date(Date.now() - KEEP_ROWS_DAYS * 86_400_000);
	await db.delete(export_jobs_table).where(and(
		inArray(export_jobs_table.status, ['FAILED', 'EXPIRED']),
		lt(export_jobs_table.created_at, keep_after)
	));
	// Every file without a READY job is stale: expired ones, leftovers from crashes and deleted accounts.
	const ready = new Set((await db.select({ file_name: export_jobs_table.file_name }).from(export_jobs_table)
		.where(eq(export_jobs_table.status, 'READY'))).map(r => r.file_name));
	let names: string[];
	try {
		names = await readdir(exports_dir());
	} catch {
		return;
	}
	for (const name of names) {
		if (!ready.has(name) && !(running && name.endsWith('.part'))) await rm(path.join(exports_dir(), name), { force: true });
	}
}

async function loop() {
	while (running) {
		let job: ExportJob | null = null;
		try {
			job = await claim();
		} catch (err) {
			log.warn('could not claim an export job', err);
		}
		if (job) {
			await run_job(job);
			continue;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, POLL_MS);
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		wake = null;
	}
}

/**
 * Starts the export runner. Call only in the process holding the exports leader lock: jobs found RUNNING were
 * interrupted (that process died) and are queued again.
 */
export async function start(): Promise<void> {
	if (running) return;
	await db.update(export_jobs_table).set({ status: 'PENDING', started_at: null }).where(eq(export_jobs_table.status, 'RUNNING'));
	await cleanup_exports().catch((err: unknown) => log.warn('export cleanup failed', err));
	running = true;
	loop_done = loop();
	cleanup_timer = setInterval(() => {
		cleanup_exports().catch((err: unknown) => log.warn('export cleanup failed', err));
	}, CLEANUP_EVERY_MS);
	cleanup_timer.unref();
}

/** Stops after the current job, waiting at most a few seconds: an unfinished job is queued again by the next leader. */
export async function stop(): Promise<void> {
	running = false;
	clearInterval(cleanup_timer);
	wake?.();
	await Promise.race([loop_done, new Promise(resolve => setTimeout(resolve, STOP_WAIT_MS).unref())]);
}
