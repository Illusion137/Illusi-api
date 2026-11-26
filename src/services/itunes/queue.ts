import { ITUNES_LOOKUP_LIMIT } from './batching';
import type { LookupRequest } from './matching';
import { request_key } from './matching';
import { LaneScheduler } from './scheduler';
import type { Lane, LaneRatio } from './scheduler';
import type { Candidate, EntityType } from './store';

export interface QueueItem {
	key: string;
	lane: Lane;
	entity_type: EntityType;
	/** Local entities waiting on this request; duplicates by key share one request. */
	illusi_ids: string[];
	/** Known id (fast path) or the names to search with. */
	applemusic_id: string | null;
	request: LookupRequest | null;
	/** Searched by its names even if linked (`Candidate.recheck`). */
	recheck: boolean;
}

/**
 * The in-memory two-lane queue. Pure: no I/O. Dedupes by type + normalized fields and never
 * holds the same `illusi_id` twice; a known id replaces a waiting name search for the same entity, and a recheck
 * replaces anything else waiting for it.
 */
export class WorkQueue {
	private lanes: Record<Lane, QueueItem[]> = { live: [], backfill: [] };
	private by_key = new Map<string, QueueItem>();
	private by_illusi = new Map<string, QueueItem>();
	private scheduler: LaneScheduler;

	constructor(ratio: LaneRatio) {
		this.scheduler = new LaneScheduler(ratio);
	}

	size(lane?: Lane): number {
		return lane ? this.lanes[lane].length : this.lanes.live.length + this.lanes.backfill.length;
	}

	has(illusi_id: string): boolean {
		return this.by_illusi.has(illusi_id);
	}

	/** Returns false when the candidate was skipped (nothing to look up, or already waiting). */
	add(candidate: Candidate, lane: Lane): boolean {
		let key: string;
		const recheck = candidate.recheck === true;
		if (candidate.applemusic_id && !recheck) key = `id|${candidate.entity_type}|${candidate.applemusic_id}`;
		else if (candidate.request) key = `${recheck ? 'recheck|' : ''}${candidate.entity_type}|${request_key(candidate.request)}`;
		else return false;

		const waiting = this.by_illusi.get(candidate.illusi_id);
		if (waiting) {
			if (waiting.recheck || (!recheck && (!candidate.applemusic_id || waiting.applemusic_id))) return false;
			this.remove_illusi_id(candidate.illusi_id);
		}

		const same = this.by_key.get(key);
		if (same) {
			same.illusi_ids.push(candidate.illusi_id);
			this.by_illusi.set(candidate.illusi_id, same);
			return true;
		}
		const item: QueueItem = {
			key, lane, entity_type: candidate.entity_type, illusi_ids: [candidate.illusi_id],
			applemusic_id: recheck ? null : candidate.applemusic_id, request: candidate.applemusic_id && !recheck ? null : candidate.request, recheck
		};
		this.lanes[lane].push(item);
		this.by_key.set(key, item);
		this.by_illusi.set(candidate.illusi_id, item);
		return true;
	}

	private remove_illusi_id(illusi_id: string) {
		const item = this.by_illusi.get(illusi_id);
		if (!item) return;
		this.by_illusi.delete(illusi_id);
		item.illusi_ids = item.illusi_ids.filter(id => id !== illusi_id);
		if (item.illusi_ids.length > 0) return;
		this.by_key.delete(item.key);
		const lane = this.lanes[item.lane];
		const i = lane.indexOf(item);
		if (i >= 0) lane.splice(i, 1);
	}

	private forget(item: QueueItem) {
		this.by_key.delete(item.key);
		for (const id of item.illusi_ids) this.by_illusi.delete(id);
	}

	/**
	 * Next unit of work by the lane ratio: one search item, or a run of known-id items from the same
	 * lane with up to 200 distinct ids so they share one lookup.
	 */
	take(): QueueItem[] {
		const lane = this.scheduler.next(this.lanes.live.length, this.lanes.backfill.length);
		if (!lane) return [];
		const queue = this.lanes[lane];
		const head = queue.shift()!;
		this.forget(head);
		if (!head.applemusic_id) return [head];
		const batch = [head];
		const ids = new Set([head.applemusic_id]);
		for (let i = 0; i < queue.length && ids.size < ITUNES_LOOKUP_LIMIT;) {
			const item = queue[i];
			if (item.applemusic_id) {
				queue.splice(i, 1);
				this.forget(item);
				batch.push(item);
				ids.add(item.applemusic_id);
			} else i++;
		}
		return batch;
	}
}
