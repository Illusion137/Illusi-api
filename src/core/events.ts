import { EventEmitter } from 'node:events';
import { logger } from './log';

const log = logger('events');

/**
 * In-process events that start downstream work. Emit them only **after** the transaction that
 * produced them commits; use `PendingEvents` inside a transaction and `flush()` after it.
 */
export interface EventMap {
	/** A local track/album/artist and its `service_ids_table` row were inserted (live lane). */
	entity_created: { illusi_id: string; entity_type: 'track' | 'album' | 'artist'; imported: boolean };
	/** `service_ids_table.applemusic_id` was newly filled (fast path). */
	applemusic_id_filled: { illusi_id: string; applemusic_id: string };
	/** The iTunes service stored an `itunes_tracks_table` row linked to a local track. */
	itunes_track_linked: { track_id: string; itunes_track_id: number; preview_url: string | null };
	/** A `media_table` row was inserted. */
	media_inserted: { track_id: string; resource_id: string };
	/** A user's library, playlists or inheritance rows changed (cache invalidation). */
	user_library_changed: { user_id: string };
	/** Service ids were newly filled on an entity (follow-up work). */
	service_ids_filled: { illusi_id: string; columns: string[] };
}

export type EventName = keyof EventMap;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function on<K extends EventName>(name: K, handler: (payload: EventMap[K]) => void | Promise<void>) {
	emitter.on(name, (payload: EventMap[K]) => {
		Promise.resolve()
			.then(() => handler(payload))
			.catch((err: unknown) => log.error(`handler for ${name} failed`, err));
	});
}

export function emit<K extends EventName>(name: K, payload: EventMap[K]) {
	emitter.emit(name, payload);
}

export class PendingEvents {
	private queue: { name: EventName; payload: unknown }[] = [];

	push<K extends EventName>(name: K, payload: EventMap[K]) {
		this.queue.push({ name, payload });
	}

	flush() {
		const queue = this.queue;
		this.queue = [];
		for (const { name, payload } of queue) emitter.emit(name, payload);
	}
}
