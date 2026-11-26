import { config } from '../../config';
import { db } from '../../db';
import { on, PendingEvents } from '../../core/events';
import { logger } from '../../core/log';
import { chunk } from './batching';
import { ITunesClient, ITunesDropError, ITunesStoppedError } from './client';
import type { AlbumTracks, ArtistAlbums } from './client';
import { attach_itunes_album } from './album_link';
import { found_from_result, resolve_request, result_for_id } from './pipeline';
import type { Found } from './pipeline';
import { WorkQueue } from './queue';
import type { QueueItem } from './queue';
import { parse_lane_ratio } from './scheduler';
import type { Lane } from './scheduler';
import { find_entity, link_entities, link_states, record_lookup, scan_candidates } from './store';
import type { EntityType } from './store';

const log = logger('itunes');

const BACKFILL_PAGE = 500;
const BACKFILL_LOW_WATER = 50;
const BACKFILL_PHASES: readonly EntityType[] = ['track', 'album', 'artist'];
const ERROR_PAUSE_MS = 5_000;

interface KnownId { illusi_id: string; entity_type: EntityType; applemusic_id: string }

/** The process-wide iTunes queue and its background drain loop. */
export class ITunesService {
	private readonly client = new ITunesClient();
	private readonly queue = new WorkQueue(parse_lane_ratio(config.ITUNES_LIVE_TO_BACKFILL));
	private running = false;
	private loop: Promise<void> | null = null;
	private wake: (() => void) | null = null;
	private listening = false;
	private backfill = { phase: 0, after: undefined as string | undefined, done: true };
	/** Ids this service just linked, so its own `applemusic_id_filled` events don't requeue them. */
	private readonly self_filled = new Set<string>();

	start() {
		if (this.running) return;
		this.running = true;
		this.client.start();
		this.backfill = { phase: 0, after: undefined, done: false };
		this.listen();
		this.loop = this.drain().catch((err: unknown) => log.error('queue loop crashed', err));
	}

	async stop() {
		this.running = false;
		this.client.stop();
		this.wake?.();
		await this.loop;
		this.loop = null;
	}

	private listen() {
		if (this.listening) return;
		this.listening = true;
		on('entity_created', async ({ illusi_id, entity_type, imported }) => {
			if (imported) return;
			await this.enqueue_scanned(entity_type, [illusi_id], 'live');
		});
		// Names changed: the old match (or miss) was made with the old ones
		on('metadata_changed', async ({ illusi_id, entity_type }) => {
			await this.enqueue_scanned(entity_type, [illusi_id], 'live', true);
		});
		on('applemusic_id_filled', async ({ illusi_id, applemusic_id }) => {
			if (this.self_filled.delete(illusi_id)) return;
			const entity = await find_entity(illusi_id);
			if (!entity || entity.imported) return;
			// The fast path ignores retry_after.
			this.add({ illusi_id, entity_type: entity.entity_type, applemusic_id, request: null }, 'live');
		});
	}

	private add(candidate: Parameters<WorkQueue['add']>[0], lane: Lane) {
		if (this.queue.add(candidate, lane)) this.wake?.();
	}

	/** Queues the given local entities of one type if they're unlinked and their lookup is due, or always with `recheck`. */
	async enqueue_scanned(type: EntityType, illusi_ids: readonly string[], lane: Lane, recheck = false) {
		for (const ids of chunk(illusi_ids, 1000)) {
			for (const c of await scan_candidates(type, { ids, limit: ids.length, recheck })) this.add(c, lane);
		}
	}

	/** An artist's albums through the shared request gate (spacing, backoff and the 10 minute cache). */
	async artist_albums(artist_id: number): Promise<ArtistAlbums> {
		return this.client.artist_albums(artist_id);
	}

	/** Songs of up to 200 tracks' worth of albums through the shared request gate. */
	async album_tracks(collection_ids: readonly number[]): Promise<Map<number, AlbumTracks>> {
		return this.client.album_tracks(collection_ids);
	}

	async enqueue_if_needed(illusi_ids: readonly string[]) {
		const ids = [...new Set(illusi_ids)].filter(id => !this.queue.has(id));
		if (ids.length === 0) return;
		for (const type of BACKFILL_PHASES) await this.enqueue_scanned(type, ids, 'live');
	}

	private async refill_backfill() {
		while (!this.backfill.done && this.queue.size('backfill') < BACKFILL_LOW_WATER) {
			const type = BACKFILL_PHASES[this.backfill.phase];
			const rows = await scan_candidates(type, { after: this.backfill.after, limit: BACKFILL_PAGE });
			for (const c of rows) this.queue.add(c, 'backfill');
			if (rows.length < BACKFILL_PAGE) {
				this.backfill.phase++;
				this.backfill.after = undefined;
				if (this.backfill.phase >= BACKFILL_PHASES.length) {
					this.backfill.done = true;
					log.info('backfill scan complete');
				}
			} else this.backfill.after = rows[rows.length - 1].illusi_id;
		}
	}

	private idle(ms?: number) {
		return new Promise<void>((resolve) => {
			const timer = ms ? setTimeout(() => { this.wake = null; resolve(); }, ms) : null;
			this.wake = () => {
				if (timer) clearTimeout(timer);
				this.wake = null;
				resolve();
			};
		});
	}

	private async drain() {
		while (this.running) {
			try {
				await this.refill_backfill();
				const batch = this.queue.take();
				if (batch.length === 0) {
					await this.idle();
					continue;
				}
				await this.process(batch);
			} catch (err) {
				if (err instanceof ITunesStoppedError) break;
				log.error('queue iteration failed', err);
				if (this.running) await this.idle(ERROR_PAUSE_MS);
			}
		}
	}

	private async process(batch: QueueItem[]) {
		const known: KnownId[] = [];
		for (const item of batch) {
			const states = await link_states(item.entity_type, item.illusi_ids);
			if (item.recheck) {
				// A different match than the stored Apple Music id goes to review through the enrichment rules
				const ids = item.illusi_ids.filter(id => states.has(id));
				if (ids.length > 0 && item.request) await this.process_search(item, ids);
				continue;
			}
			const pending = item.illusi_ids.filter(id => states.has(id) && !states.get(id)!.linked);
			const search_ids: string[] = [];
			for (const id of pending) {
				const applemusic_id = states.get(id)!.applemusic_id;
				if (applemusic_id) known.push({ illusi_id: id, entity_type: item.entity_type, applemusic_id });
				else if (item.request) search_ids.push(id);
			}
			if (search_ids.length > 0) await this.process_search(item, search_ids);
		}
		for (const group of chunk(dedupe_known(known))) await this.process_known(group);
	}

	private async process_search(item: QueueItem, illusi_ids: string[]) {
		await this.guard(illusi_ids, item.entity_type, async () => {
			const found = await resolve_request(this.client, item.request!, config.ITUNES_MATCH_THRESHOLD);
			if (!found) {
				await record_lookup(db, illusi_ids, item.entity_type, 'NOT_FOUND');
				return;
			}
			await this.commit(found, illusi_ids, item.entity_type);
		});
	}

	/** One plain lookup for ≤ 200 known ids (fast path). */
	private async process_known(group: KnownId[]) {
		const ids = [...new Set(group.map(k => k.applemusic_id))];
		let results: Awaited<ReturnType<ITunesClient['lookup_ids']>>;
		try {
			results = await this.client.lookup_ids(ids);
		} catch (err) {
			if (err instanceof ITunesStoppedError) throw err;
			log.warn('id lookup dropped', err instanceof Error ? err.message : err);
			for (const type of BACKFILL_PHASES) await record_lookup(db, group.filter(k => k.entity_type === type).map(k => k.illusi_id), type, 'ERROR');
			return;
		}
		for (const k of group) {
			await this.guard([k.illusi_id], k.entity_type, async () => {
				const result = result_for_id(results, k.entity_type, k.applemusic_id);
				if (!result) await record_lookup(db, [k.illusi_id], k.entity_type, 'NOT_FOUND');
				else await this.commit(found_from_result(k.entity_type, result), [k.illusi_id], k.entity_type);
			});
		}
	}

	/** Stores the match, links it and records FOUND in one transaction; events go out after commit. */
	private async commit(found: Found, illusi_ids: string[], type: EntityType) {
		const events = new PendingEvents();
		const linked = await db.transaction(async (tx) => {
			const { artwork, preview_url } = await found.persist(tx);
			const linked_ids = await link_entities(tx, illusi_ids, type, found.itunes_id, artwork, preview_url, events);
			if (type === 'track') for (const id of linked_ids) await attach_itunes_album(tx, id, found.itunes_id, events);
			await record_lookup(tx, illusi_ids, type, 'FOUND');
			return linked_ids;
		});
		if (this.self_filled.size > 10_000) this.self_filled.clear();
		for (const id of linked) this.self_filled.add(id);
		events.flush();
		log.debug(`linked ${type} ${found.itunes_id} → ${linked.join(', ') || '(conflict)'}`);
	}

	/** Drops (4xx, retries exhausted) and unexpected failures become ERROR records; stopping propagates. */
	private async guard(illusi_ids: string[], type: EntityType, fn: () => Promise<void>) {
		try {
			await fn();
		} catch (err) {
			if (err instanceof ITunesStoppedError) throw err;
			if (err instanceof ITunesDropError) log.warn(`dropped ${type} ${illusi_ids.join(', ')}: ${err.message}`);
			else log.error(`${type} ${illusi_ids.join(', ')} failed`, err);
			await record_lookup(db, illusi_ids, type, 'ERROR').catch((e: unknown) => log.error('could not record lookup', e));
		}
	}
}

function dedupe_known(known: readonly KnownId[]): KnownId[] {
	const seen = new Set<string>();
	return known.filter(k => !seen.has(k.illusi_id) && seen.add(k.illusi_id));
}
