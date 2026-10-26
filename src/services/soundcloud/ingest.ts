import { and, getColumns, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Column, SQL } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import type { Tx } from '../../db';
import {
	albums_table, artists_table, service_ids_table, soundcloud_playlist_table, soundcloud_playlist_tracks_table,
	soundcloud_tracks_table, soundcloud_transcodings_table, soundcloud_users_table, tracks_table
} from '../../db/schema';
import { enrich_service_ids } from '../../core/enrich';
import { PendingEvents } from '../../core/events';
import { logger } from '../../core/log';
import { ProvenanceLog } from '../../core/provenance';
import { soundcloud_thumbnails, upsert_thumbnails } from '../../core/thumbnails';
import type { Batch } from './normalize';
import { changed_fields, decide_membership, VOLATILE_FIELDS } from './normalize';
import { pg_error_code, PG_ERRORS } from '../../core/pg_errors';

const log = logger('soundcloud');

const CHUNK = 500;

/** True when a transcoding URL hasn't been seen in a submission for `SC_TRANSCODING_STALE_AFTER_HOURS`. */
export function is_transcoding_stale(last_seen_at: Date | string | null | undefined, now = Date.now()): boolean {
	if (last_seen_at == null) return true;
	const t = new Date(last_seen_at).getTime();
	if (Number.isNaN(t)) return true;
	return now - t > config.SC_TRANSCODING_STALE_AFTER_HOURS * 3_600_000;
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

type ScEntityTable = typeof soundcloud_users_table | typeof soundcloud_tracks_table | typeof soundcloud_playlist_table;

/**
 * `ON CONFLICT DO UPDATE` set for a SoundCloud entity table: every column is
 * `coalesce(excluded, existing)`, descriptive columns keep the stored value when the incoming
 * `last_modified` is older, volatile counters always move, and `soundcloud_last_modified` only advances.
 */
function upsert_set(table: ScEntityTable, volatile: readonly string[]): Record<string, SQL> {
	const columns = getColumns(table) as Record<string, Column>;
	const lm = sql.identifier('soundcloud_last_modified');
	const stored_lm = sql`${table.soundcloud_last_modified}`;
	const stale = sql`(excluded.${lm} is not null and ${stored_lm} is not null and excluded.${lm} < ${stored_lm})`;
	const set: Record<string, SQL> = {};
	for (const [key, column] of Object.entries(columns)) {
		// `modified_at` is bumped by drizzle's `$onUpdate`.
		if (key === 'id' || key === 'created_at' || key === 'modified_at') continue;
		const ident = sql.identifier(column.name);
		const existing = sql`${column}`;
		if (key === 'soundcloud_last_modified') set[key] = sql`greatest(excluded.${ident}, ${existing})`;
		else if (volatile.includes(key)) set[key] = sql`coalesce(excluded.${ident}, ${existing})`;
		else set[key] = sql`case when ${stale} then ${existing} else coalesce(excluded.${ident}, ${existing}) end`;
	}
	return set;
}

async function existing_ids(tx: Tx, table: typeof soundcloud_users_table | typeof soundcloud_tracks_table, ids: number[]): Promise<Set<number>> {
	const out = new Set<number>();
	for (const part of chunks(ids)) {
		const rows = await tx.select({ id: table.id }).from(table).where(inArray(table.id, part));
		for (const r of rows) out.add(r.id);
	}
	return out;
}

async function select_existing<T extends ScEntityTable>(tx: Tx, table: T, ids: number[]): Promise<Map<number, Record<string, unknown>>> {
	const out = new Map<number, Record<string, unknown>>();
	for (const part of chunks(ids)) {
		const rows = await tx.select().from(table).where(inArray(table.id, part)) as Record<string, unknown>[];
		for (const r of rows) out.set(r.id as number, r);
	}
	return out;
}

/** Ids of SoundCloud users that exist (in this batch or stored), so `user_id` FKs can be nulled otherwise. */
async function known_user_ids(tx: Tx, batch: Batch, wanted: Iterable<number | null | undefined>): Promise<Set<number>> {
	const known = new Set(batch.users.keys());
	const missing = [...new Set([...wanted].filter((id): id is number => id != null && !known.has(id)))];
	for (const id of await existing_ids(tx, soundcloud_users_table, missing)) known.add(id);
	return known;
}

async function write_users(tx: Tx, batch: Batch, prov: ProvenanceLog) {
	const rows = [...batch.users.values()].sort((a, b) => a.id - b.id);
	if (rows.length === 0) return;
	const ids = rows.map(r => r.id);
	const existing = await select_existing(tx, soundcloud_users_table, ids);
	// `permalink` is unique; a stored user that no longer owns it (renamed on SoundCloud) gets it suffixed.
	const permalinks = rows.map(r => r.permalink);
	for (const part of chunks(permalinks)) {
		const taken = await tx.update(soundcloud_users_table)
			.set({ permalink: sql`left(${soundcloud_users_table.permalink}, 100) || '~' || ${soundcloud_users_table.id}` })
			.where(and(inArray(soundcloud_users_table.permalink, part), notInArray(soundcloud_users_table.id, ids)))
			.returning({ id: soundcloud_users_table.id });
		if (taken.length > 0) log.warn('released permalinks of renamed soundcloud users', taken.map(t => t.id));
	}
	for (const part of chunks(rows)) {
		await tx.insert(soundcloud_users_table).values(part).onConflictDoUpdate({
			target: soundcloud_users_table.id,
			set: upsert_set(soundcloud_users_table, VOLATILE_FIELDS.users)
		});
	}
	for (const row of rows) prov.touch('soundcloud_users_table', row.id, changed_fields(existing.get(row.id), row, VOLATILE_FIELDS.users));
}

async function write_tracks(tx: Tx, batch: Batch, prov: ProvenanceLog) {
	const entries = [...batch.tracks.values()].sort((a, b) => a.row.id - b.row.id);
	if (entries.length === 0) return;
	const known_users = await known_user_ids(tx, batch, entries.map(e => e.row.user_id));
	const rows = entries.map(e => ({ ...e.row, user_id: e.row.user_id != null && known_users.has(e.row.user_id) ? e.row.user_id : null }));
	const existing = await select_existing(tx, soundcloud_tracks_table, rows.map(r => r.id));
	for (const part of chunks(rows)) {
		await tx.insert(soundcloud_tracks_table).values(part).onConflictDoUpdate({
			target: soundcloud_tracks_table.id,
			set: upsert_set(soundcloud_tracks_table, VOLATILE_FIELDS.tracks)
		});
	}
	for (const row of rows) prov.touch('soundcloud_tracks_table', row.id, changed_fields(existing.get(row.id), row, VOLATILE_FIELDS.tracks));
}

async function write_transcodings(tx: Tx, batch: Batch, prov: ProvenanceLog) {
	const with_media = [...batch.tracks.values()].filter(e => e.transcodings !== null);
	if (with_media.length === 0) return;
	const seen_at = new Date();
	const by_url = new Map<string, NonNullable<typeof with_media[number]['transcodings']>[number]>();
	for (const e of with_media) for (const t of e.transcodings ?? []) by_url.set(t.url, t);
	const rows = [...by_url.values()].sort((a, b) => a.url.localeCompare(b.url)).map(t => ({ ...t, last_seen_at: seen_at }));
	const t = soundcloud_transcodings_table;
	for (const part of chunks(rows)) {
		const written = await tx.insert(t).values(part).onConflictDoUpdate({
			target: t.url,
			set: {
				track_id: sql`excluded.track_id`,
				preset: sql`coalesce(excluded.preset, ${t.preset})`,
				protocol: sql`coalesce(excluded.protocol, ${t.protocol})`,
				mime_type: sql`coalesce(excluded.mime_type, ${t.mime_type})`,
				quality: sql`coalesce(excluded.quality, ${t.quality})`,
				duration: sql`coalesce(excluded.duration, ${t.duration})`,
				snipped: sql`coalesce(excluded.snipped, ${t.snipped})`,
				last_seen_at: sql`excluded.last_seen_at`
			}
		}).returning({ id: t.id, inserted: sql<boolean>`(xmax = 0)` });
		for (const w of written) if (w.inserted) prov.touch('soundcloud_transcodings_table', w.id, ['*']);
	}
	// A media block is the track's full transcoding set: drop the ones it no longer lists.
	for (const part of chunks(with_media.map(e => e.row.id))) {
		await tx.delete(t).where(and(inArray(t.track_id, part), or(sql`${t.last_seen_at} is null`, ne(t.last_seen_at, seen_at))));
	}
}

async function write_playlists(tx: Tx, batch: Batch, prov: ProvenanceLog) {
	const entries = [...batch.playlists.values()].sort((a, b) => a.row.id - b.row.id);
	if (entries.length === 0) return;
	const known_users = await known_user_ids(tx, batch, entries.map(e => e.row.user_id));
	const rows = entries.map(e => ({ ...e.row, user_id: e.row.user_id != null && known_users.has(e.row.user_id) ? e.row.user_id : null }));
	const existing = await select_existing(tx, soundcloud_playlist_table, rows.map(r => r.id));
	for (const part of chunks(rows)) {
		await tx.insert(soundcloud_playlist_table).values(part).onConflictDoUpdate({
			target: soundcloud_playlist_table.id,
			set: upsert_set(soundcloud_playlist_table, VOLATILE_FIELDS.playlists)
		});
	}
	for (const row of rows) prov.touch('soundcloud_playlist_table', row.id, changed_fields(existing.get(row.id), row, VOLATILE_FIELDS.playlists));
}

async function write_playlist_tracks(tx: Tx, batch: Batch, prov: ProvenanceLog) {
	const entries = [...batch.playlists.values()].filter(e => e.members !== null).sort((a, b) => a.row.id - b.row.id);
	if (entries.length === 0) return;
	const known = new Set(batch.tracks.keys());
	const stub_ids = [...new Set(entries.flatMap(e => e.members ?? []).filter(id => !known.has(id)))];
	for (const id of await existing_ids(tx, soundcloud_tracks_table, stub_ids)) known.add(id);
	const pt = soundcloud_playlist_tracks_table;
	for (const entry of entries) {
		const decision = decide_membership(entry.members, entry.row.track_count, known);
		if (decision.mode === 'none') continue;
		const playlist_id = entry.row.id;
		const rows = decision.rows.map(r => ({ playlist_id, track_id: r.track_id, position: r.position }));
		if (decision.mode === 'replace') {
			const keep = rows.map(r => r.track_id);
			await tx.delete(pt).where(and(sql`${pt.playlist_id} = ${playlist_id}`, keep.length > 0 ? notInArray(pt.track_id, keep) : undefined));
			for (const part of chunks(rows)) {
				await tx.insert(pt).values(part).onConflictDoUpdate({
					target: [pt.playlist_id, pt.track_id],
					set: { position: sql`excluded.position` }
				});
			}
		} else {
			for (const part of chunks(rows)) await tx.insert(pt).values(part).onConflictDoNothing();
		}
		prov.touch('soundcloud_playlist_tracks_table', playlist_id, [`${decision.mode}:${rows.length}`]);
	}
}

/**
 * Enrichment and thumbnails, only for SoundCloud ids already linked to an Illusi entity of
 * the matching type (track ↔ track, playlist ↔ album, user ↔ artist).
 */
async function enrich_linked(tx: Tx, batch: Batch, user_id: string, prov: ProvenanceLog, events: PendingEvents) {
	const sc_ids = [...new Set([...batch.tracks.keys(), ...batch.playlists.keys(), ...batch.users.keys()])];
	if (sc_ids.length === 0) return;
	const links = new Map<number, string>();
	for (const part of chunks(sc_ids)) {
		const rows = await tx.select({ illusi_id: service_ids_table.illusi_id, soundcloud_id: service_ids_table.soundcloud_id })
			.from(service_ids_table).where(inArray(service_ids_table.soundcloud_id, part));
		for (const r of rows) if (r.soundcloud_id != null) links.set(r.soundcloud_id, r.illusi_id);
	}
	if (links.size === 0) return;
	const illusi_ids = [...new Set(links.values())];
	const ids_in = async (table: typeof tracks_table | typeof albums_table | typeof artists_table) => {
		const out = new Set<string>();
		for (const part of chunks(illusi_ids)) {
			for (const r of await tx.select({ id: table.id }).from(table).where(inArray(table.id, part))) out.add(r.id);
		}
		return out;
	};
	const [tracks, albums, artists] = [await ids_in(tracks_table), await ids_in(albums_table), await ids_in(artists_table)];
	const ctx = { source: 'soundcloud', user_id, events };

	const apply = async (illusi_id: string, ids: Record<string, string | null>, artwork: string | null | undefined) => {
		const result = await enrich_service_ids(tx, illusi_id, ids, ctx);
		prov.touch('service_ids_table', illusi_id, result.filled);
		const thumbs = soundcloud_thumbnails(artwork);
		if (thumbs.length > 0) await upsert_thumbnails(tx, illusi_id, thumbs);
	};

	for (const [id, entry] of batch.tracks) {
		const illusi_id = links.get(id);
		if (illusi_id && tracks.has(illusi_id)) await apply(illusi_id, { soundcloud_permalink: entry.permalink_url, isrc: entry.row.isrc ?? null }, entry.row.artwork_url);
	}
	for (const [id, entry] of batch.playlists) {
		const illusi_id = links.get(id);
		if (illusi_id && albums.has(illusi_id)) await apply(illusi_id, { soundcloud_permalink: entry.permalink_url }, entry.row.artwork_url);
	}
	for (const [id, row] of batch.users) {
		const illusi_id = links.get(id);
		// A user's permalink_url is a single path segment, which isn't a valid `soundcloud_permalink`.
		if (illusi_id && artists.has(illusi_id)) await apply(illusi_id, {}, row.avatar_url);
	}
}

/** Writes one request's batch in a single transaction, in FK order, plus provenance. */
export async function ingest_batch(user_id: string, batch: Batch) {
	const events = new PendingEvents();
	await db.transaction(async (tx) => {
		const prov = new ProvenanceLog('soundcloud', user_id);
		await write_batch(tx, user_id, batch, prov, events);
		if (prov.entities.length > 0) await prov.write(tx);
	});
	events.flush();
}

/** The writes of `ingest_batch` inside the caller's transaction; the caller writes `prov` and flushes `events`. */
export async function write_batch(tx: Tx, user_id: string, batch: Batch, prov: ProvenanceLog, events: PendingEvents) {
	await write_users(tx, batch, prov);
	await write_tracks(tx, batch, prov);
	await write_transcodings(tx, batch, prov);
	await write_playlists(tx, batch, prov);
	await write_playlist_tracks(tx, batch, prov);
	await enrich_linked(tx, batch, user_id, prov, events);
}

const RETRYABLE = new Set<string>([PG_ERRORS.deadlock_detected, PG_ERRORS.serialization_failure]);
const MAX_CONCURRENT = 2;
const MAX_WAITING = 200;
let running = 0;
const waiting: (() => void)[] = [];

/** Background processing with bounded concurrency; retries once on deadlock/serialization failure. */
export function enqueue_batch(user_id: string, batch: Batch) {
	const run = async () => {
		running++;
		try {
			try {
				await ingest_batch(user_id, batch);
			} catch (err) {
				if (!RETRYABLE.has(pg_error_code(err) ?? '')) throw err;
				await ingest_batch(user_id, batch);
			}
		} catch (err) {
			log.error('soundcloud ingest failed', err);
		} finally {
			running--;
			waiting.shift()?.();
		}
	};
	if (running < MAX_CONCURRENT) void run();
	else if (waiting.length < MAX_WAITING) waiting.push(() => void run());
	else log.warn('soundcloud ingest queue full, dropping batch', { user_id });
}
