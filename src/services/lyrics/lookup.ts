import { config } from '../../config';
import { db } from '../../db';
import { emit } from '../../core/events';
import { logger } from '../../core/log';
import { due_server_services } from './schedule';
import { query_service } from './servers';
import type { LyricsQuery } from './servers';
import { insert_versions, load_lookups, load_track_context, write_lookups } from './store';
import type { TrackContext } from './store';

const log = logger('lyrics');

export function lyrics_query(ctx: TrackContext): LyricsQuery {
	return {
		title: ctx.title,
		artist: ctx.artists[0]?.name ?? '',
		album: ctx.album,
		duration_s: ctx.duration_ms == null ? null : Math.round(ctx.duration_ms / 1000),
		isrc: ctx.service_ids?.isrc ?? null,
		youtube_id: ctx.service_ids?.youtube_id ?? null
	};
}

/**
 * Queries every server service that is due in parallel, each with its own timeout,
 * then stores every version and one lookup record per queried service (step 3).
 */
async function run_lookup(track_id: string): Promise<void> {
	const ctx = await load_track_context(db, track_id);
	if (!ctx) return;
	const previous = (await load_lookups(db, [track_id])).get(track_id) ?? new Map();
	const due = due_server_services(previous, new Date());
	if (due.length === 0) return;
	const query = lyrics_query(ctx);
	if (!query.artist) log.debug(`track ${track_id} has no artist; querying by title only`);

	const outcomes = await Promise.all(due.map(service => query_service(service, query)));
	const now = new Date();
	let stored = 0;
	await db.transaction(async (tx) => {
		for (const o of outcomes) {
			if (o.versions.length > 0) stored += (await insert_versions(tx, track_id, o.service, o.versions)).length;
		}
		await write_lookups(tx, track_id, outcomes.map(o => ({ service: o.service, status: o.status, cooldown_until: o.cooldown_until })), previous, now);
	});
	if (stored > 0) emit('lyrics_stored', { track_id });
	log.info(`lookup ${track_id}`, Object.fromEntries(outcomes.map(o => [o.service, `${o.status}${o.versions.length > 0 ? `(${o.versions.length})` : ''}`])));
}

const in_flight = new Map<string, Promise<void>>();

/** One lookup per track at a time: concurrent callers share the same promise. Never rejects. */
export function lookup_track(track_id: string): Promise<void> {
	const existing = in_flight.get(track_id);
	if (existing) return existing;
	const promise = run_lookup(track_id)
		.catch((err: unknown) => { log.error(`lookup ${track_id} failed`, err); })
		.finally(() => in_flight.delete(track_id));
	in_flight.set(track_id, promise);
	return promise;
}

/** Waits for the shared lookup, but never past the overall deadline; the lookup keeps going and stores later. */
export async function lookup_track_with_deadline(track_id: string, deadline_ms = config.LYRICS_DEADLINE_MS): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		lookup_track(track_id),
		new Promise<void>((resolve) => { timer = setTimeout(resolve, deadline_ms); })
	]);
	clearTimeout(timer);
}

const BACKGROUND_CONCURRENCY = 2;
const MAX_BACKGROUND_QUEUE = 10_000;
const background_queue: string[] = [];
const queued = new Set<string>();
let running = 0;

function pump() {
	while (running < BACKGROUND_CONCURRENCY && background_queue.length > 0) {
		const track_id = background_queue.shift()!;
		running++;
		void lookup_track(track_id).finally(() => {
			running--;
			queued.delete(track_id);
			pump();
		});
	}
}

/** Background lookups with limited concurrency (rechecks, never-looked-up tracks from sync). */
export function enqueue_background(track_ids: readonly string[]) {
	for (const id of track_ids) {
		if (queued.has(id) || in_flight.has(id)) continue;
		if (background_queue.length >= MAX_BACKGROUND_QUEUE) {
			log.warn('background lyrics queue full; dropping lookups');
			break;
		}
		queued.add(id);
		background_queue.push(id);
	}
	pump();
}
