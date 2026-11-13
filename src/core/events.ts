import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import type { Notification } from 'pg';
import { db, owner_database_url } from '../db';
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
	/** A `media_table` row was inserted. Reaches every API process (the analyzer queue runs in one of them). */
	media_inserted: { track_id: string; resource_id: string };
	/** New lyrics were stored for a track. Reaches every API process (the analyzer queue runs in one of them). */
	lyrics_stored: { track_id: string };
	/** The app asked to align a track's plain lyrics and nothing is stored yet. Reaches every API process. */
	alignment_requested: { track_id: string };
	/** A user's library, playlists or inheritance rows changed (cache invalidation). Reaches every API process. */
	user_library_changed: { user_id: string };
	/** Service ids were newly filled on an entity (follow-up work). */
	service_ids_filled: { illusi_id: string; columns: string[] };
	/**
	 * Ids were merged (`illusi_id_redirects_table` changed, by any process), or notifications may have been missed:
	 * anything cached by entity id is stale. Sent by a database trigger on commit.
	 */
	ids_redirected: Record<string, never>;
	/** An account was deleted; its access tokens stop working everywhere. Reaches every API process. */
	user_deleted: { user_id: string };
	/** A data export was requested; wakes the export runner wherever it runs. Reaches every API process. */
	export_requested: { id: string };
}

export type EventName = keyof EventMap;

/** Postgres channel that carries events between processes (API replicas, the reconcile worker). */
const CHANNEL = 'illusi_events';
/** Events that are also published to every other process once emitted here. */
const BROADCAST: ReadonlySet<EventName> = new Set<EventName>(['user_library_changed', 'user_deleted', 'export_requested', 'media_inserted', 'lyrics_stored', 'alignment_requested']);
/** Marks this process's own notifications, which it already handled locally. */
const ORIGIN = randomUUID();
const RECONNECT_MS = 2_000;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);
let bridge_running = false;

export function on<K extends EventName>(name: K, handler: (payload: EventMap[K]) => void | Promise<void>) {
	emitter.on(name, (payload: EventMap[K]) => {
		Promise.resolve()
			.then(() => handler(payload))
			.catch((err: unknown) => log.error(`handler for ${name} failed`, err));
	});
}

function publish(name: EventName, payload: unknown) {
	if (!bridge_running || !BROADCAST.has(name)) return;
	db.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify({ name, payload, origin: ORIGIN })})`)
		.catch((err: unknown) => log.warn(`failed to publish ${name}`, err));
}

export function emit<K extends EventName>(name: K, payload: EventMap[K]) {
	emitter.emit(name, payload);
	publish(name, payload);
}

export class PendingEvents {
	private queue: { name: EventName; payload: unknown }[] = [];

	push<K extends EventName>(name: K, payload: EventMap[K]) {
		this.queue.push({ name, payload });
	}

	flush() {
		const queue = this.queue;
		this.queue = [];
		for (const { name, payload } of queue) {
			emitter.emit(name, payload);
			publish(name, payload);
		}
	}
}

/** Parses a notification from CHANNEL; null for this process's own or malformed ones. */
export function parse_notification(raw: string | undefined, origin: string = ORIGIN): { name: EventName; payload: unknown } | null {
	if (!raw) return null;
	try {
		const message = JSON.parse(raw) as { name?: unknown; payload?: unknown; origin?: unknown };
		if (typeof message.name !== 'string' || message.origin === origin) return null;
		return { name: message.name as EventName, payload: message.payload ?? {} };
	} catch {
		return null;
	}
}

/**
 * Listens on CHANNEL with a dedicated connection and re-emits other processes' events here. While disconnected,
 * notifications are lost, so every (re)connect emits `ids_redirected` to drop anything cached. Call once per
 * process that keeps caches; the returned function stops it.
 */
export function start_event_bridge(): () => Promise<void> {
	bridge_running = true;
	let client: Client | null = null;
	let timer: NodeJS.Timeout | undefined;

	const reconnect = () => {
		client = null;
		if (bridge_running) timer = setTimeout(() => { void connect(); }, RECONNECT_MS);
	};

	const connect = async () => {
		const next = new Client({ connectionString: owner_database_url(), application_name: 'illusi-events' });
		next.on('notification', (msg: Notification) => {
			if (msg.channel !== CHANNEL) return;
			const event = parse_notification(msg.payload);
			if (event) emitter.emit(event.name, event.payload);
		});
		next.on('error', (err) => {
			if (client !== next) return;
			log.warn('event bridge connection lost', err);
			void next.end().catch(() => undefined);
			reconnect();
		});
		next.on('end', () => {
			if (client !== next) return;
			log.warn('event bridge connection closed');
			reconnect();
		});
		try {
			await next.connect();
			await next.query(`listen ${CHANNEL}`);
			if (!bridge_running) {
				await next.end();
				return;
			}
			client = next;
			emitter.emit('ids_redirected', {});
		} catch (err) {
			log.warn('event bridge could not connect', err);
			await next.end().catch(() => undefined);
			reconnect();
		}
	};

	void connect();
	return async () => {
		bridge_running = false;
		clearTimeout(timer);
		await client?.end().catch(() => undefined);
		client = null;
	};
}
