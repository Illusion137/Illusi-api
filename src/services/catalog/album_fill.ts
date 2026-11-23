/**
 * Albums from iTunes that the catalog holds only part of (the tracks someone happened to match) get the rest of their
 * songs from an iTunes album lookup, added through the contribution engine like new releases, so the whole album can
 * be viewed. Asked for when an album is served; each album is looked up at most once per RETRY_AFTER_MS.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { albums_table, service_ids_table } from '../../db/schema';
import { logger } from '../../core/log';
import { ProvenanceLog } from '../../core/provenance';
import { apply_graph, flush_engine_events, validate_graph } from '../entities';
import { itunes_lookups } from '../itunes';
import type { ITunesLookups } from '../itunes';
import { ITunesStoppedError } from '../itunes/client';
import { scope_graph } from '../releases/logic';
import { itunes_release_graph } from '../releases/itunes_checks';

const log = logger('album_fill');

/** How long a request waits for the fill before answering with what the catalog has. */
const FILL_WAIT_MS = 4_000;
const RETRY_AFTER_MS = 24 * 3_600_000;
const MAX_REMEMBERED = 10_000;

const tried = new Map<string, number>();
const running = new Map<string, Promise<number>>();

/** The album's iTunes collection, when the catalog has fewer of its tracks than iTunes lists (or the count is unknown). */
async function incomplete_collection(album_id: string): Promise<{ artist_id: string; collection_id: number } | null> {
	const [row] = await db.select({
		artist_id: albums_table.artist_id,
		applemusic_id: service_ids_table.applemusic_id,
		track_count: sql<number | null>`(select c.track_count from itunes_collections_table c where c.id::text = ${service_ids_table.applemusic_id})`,
		stored: sql<number>`(select count(distinct t.id)::int from tracks_table t where t.album_id = ${albums_table.id}
			or exists(select 1 from album_tracks_table x where x.track_id = t.id and x.album_id = ${albums_table.id}))`
	}).from(albums_table).innerJoin(service_ids_table, eq(service_ids_table.illusi_id, albums_table.id)).where(eq(albums_table.id, album_id));
	if (!row?.artist_id || !row.applemusic_id || !/^\d+$/u.test(row.applemusic_id)) return null;
	if (row.track_count != null && row.stored >= row.track_count) return null;
	return { artist_id: row.artist_id, collection_id: Number(row.applemusic_id) };
}

/** Adds the album's missing iTunes songs; returns how many tracks were created. */
export async function fill_album(lookups: ITunesLookups, album_id: string): Promise<number> {
	const target = await incomplete_collection(album_id);
	if (!target) return 0;
	const entry = (await lookups.album_tracks([target.collection_id])).get(target.collection_id);
	if (!entry?.collection || entry.tracks.length === 0) return 0;
	const graph = itunes_release_graph(target.artist_id, entry.collection.artistId ?? -1, [entry.collection], new Map([[target.collection_id, entry.tracks]]));

	const result = await db.transaction(async (tx) => {
		const validated = validate_graph(graph);
		const scoped = scope_graph(validated.graph, target.artist_id);
		const provenance = new ProvenanceLog('itunes', null);
		const applied = await apply_graph(tx, scoped.graph, { user_id: null, source: 'itunes', provenance });
		const rejected = [...validated.rejected, ...scoped.rejected, ...applied.rejected];
		if (rejected.length > 0) log.warn(`album ${album_id}: rejected parts`, { rejected });
		await provenance.write(tx, { refs: applied.refs, created: applied.created, matched: applied.matched });
		return { created: applied.created.filter(c => c.type === 'track').length, events: applied.events };
	});
	flush_engine_events(result);
	if (result.created > 0) log.info(`filled album ${album_id} with ${result.created} track(s) from iTunes collection ${target.collection_id}`);
	return result.created;
}

/**
 * Starts filling the album if it may be incomplete and wasn't tried lately, and waits up to `wait_ms` for it, so the
 * first view usually shows the whole album. A slower fill finishes in the background.
 */
export async function complete_album(album_id: string, wait_ms = FILL_WAIT_MS, lookups: ITunesLookups = itunes_lookups): Promise<void> {
	let job = running.get(album_id);
	if (!job) {
		const now = Date.now();
		if ((tried.get(album_id) ?? 0) > now - RETRY_AFTER_MS) return;
		if (tried.size >= MAX_REMEMBERED) tried.clear();
		tried.set(album_id, now);
		job = fill_album(lookups, album_id)
			.catch((err: unknown) => {
				if (!(err instanceof ITunesStoppedError)) log.warn(`could not fill album ${album_id}`, err);
				return 0;
			})
			.finally(() => running.delete(album_id));
		running.set(album_id, job);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([job, new Promise<void>((resolve) => { timer = setTimeout(resolve, wait_ms); })]).finally(() => clearTimeout(timer));
}

/** Forgets which albums were tried (tests). */
export function reset_album_fill() {
	tried.clear();
}
