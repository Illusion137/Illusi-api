import { inArray } from 'drizzle-orm';
import type { Tx } from '../../db';
import { genius_annotations_table, genius_artists_table, genius_referents_table, genius_song_artists_table, genius_songs_table, genius_users_table, tracks_producers_table } from '../../db/schema';
import { consume_action_token } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { enrich_service_ids } from '../../core/enrich';
import type { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { logger } from '../../core/log';
import { names_match } from '../../core/normalize';
import { ProvenanceLog } from '../../core/provenance';
import { resolve_redirect } from '../../core/redirects';
import { add_review_item } from '../../core/review';
import type { ServiceIds } from '../../core/service_ids';
import { upsert_thumbnails } from '../../core/thumbnails';
import { truncate_to_columns } from '../../core/truncate';
import { extract_genius_payload, match_genius_song } from './genius_extract';
import type { GeniusExtraction, TrackFacts } from './genius_extract';
import { coalesce_set, insert_versions, load_lookups, load_track_context, write_lookups } from './store';
import type { TrackContext } from './store';

const log = logger('genius');

export type GeniusIngestResult
	= | { kind: 'stored'; track_id: string }
		| { kind: 'not_found'; track_id: string }
		| { kind: 'rejected'; track_id: string; reason: string };

export function track_facts(ctx: TrackContext): TrackFacts {
	return {
		service_ids: ctx.service_ids ?? {},
		title: ctx.title,
		artists: ctx.artists.map(a => a.name),
		album: ctx.album,
		duration_ms: ctx.duration_ms
	};
}

/** Ids among `wanted` that exist in the table (so optional foreign keys are only set when they resolve). */
async function existing_ids(tx: Tx, table: typeof genius_users_table | typeof genius_artists_table, wanted: Iterable<number>, known: Set<number>): Promise<Set<number>> {
	const missing = [...new Set(wanted)].filter(id => !known.has(id));
	const out = new Set(known);
	if (missing.length === 0) return out;
	const rows = await tx.select({ id: table.id }).from(table).where(inArray(table.id, missing));
	for (const r of rows) out.add(r.id);
	return out;
}

const truncate = <T extends Record<string, unknown>>(table: Parameters<typeof truncate_to_columns>[0], rows: T[], ctx: string) => rows.map(r => truncate_to_columns(table, r, ctx));

/** Every Genius entity, upserted by Genius id with never-null-out `COALESCE`. */
async function write_genius_entities(tx: Tx, ex: GeniusExtraction, prov: ProvenanceLog) {
	const context = `genius song ${ex.song_id}`;
	if (ex.users.length > 0) {
		await tx.insert(genius_users_table).values(truncate(genius_users_table, ex.users, context))
			.onConflictDoUpdate({ target: genius_users_table.id, set: coalesce_set(genius_users_table) });
	}
	if (ex.artists.length > 0) {
		await tx.insert(genius_artists_table).values(truncate(genius_artists_table, ex.artists, context))
			.onConflictDoUpdate({ target: genius_artists_table.id, set: coalesce_set(genius_artists_table) });
	}

	const referenced_users = [ex.song.lyrics_owner_id, ...ex.referents.map(r => r.annotator_id), ...ex.annotations.map(a => a.created_by_id)]
		.filter((id): id is number => id != null);
	const users = await existing_ids(tx, genius_users_table, referenced_users, new Set(ex.users.map(u => u.id)));
	const user_or_null = (id: number | null | undefined) => (id != null && users.has(id) ? id : null);

	await tx.insert(genius_songs_table).values(truncate_to_columns(genius_songs_table, { ...ex.song, lyrics_owner_id: user_or_null(ex.song.lyrics_owner_id) }, context))
		.onConflictDoUpdate({ target: genius_songs_table.id, set: coalesce_set(genius_songs_table) });
	prov.touch('genius_songs_table', ex.song_id, ['*']);

	if (ex.song_artists.length > 0) {
		await tx.insert(genius_song_artists_table).values(ex.song_artists.map(r => ({ song_id: ex.song_id, ...r }))).onConflictDoNothing();
	}
	if (ex.referents.length > 0) {
		await tx.insert(genius_referents_table).values(truncate(genius_referents_table, ex.referents.map(r => ({ ...r, annotator_id: user_or_null(r.annotator_id) })), context))
			.onConflictDoUpdate({ target: genius_referents_table.id, set: coalesce_set(genius_referents_table) });
	}
	if (ex.annotations.length > 0) {
		await tx.insert(genius_annotations_table).values(truncate(genius_annotations_table, ex.annotations.map(a => ({ ...a, created_by_id: user_or_null(a.created_by_id) })), context))
			.onConflictDoUpdate({ target: genius_annotations_table.id, set: coalesce_set(genius_annotations_table) });
	}
}

/** Ids and artwork onto the matched track and its artists. */
async function enrich_track(tx: Tx, ctx: TrackContext, ex: GeniusExtraction, prov: ProvenanceLog, token_jti: string | null, user_id: string, events: PendingEvents) {
	const ids: ServiceIds = {};
	for (const c of ex.ids) {
		const current = ids[c.column];
		if (current == null) ids[c.column] = c.value;
		else if (String(current) !== String(c.value)) log.info(`song ${ex.song_id} has several ${c.column} values; keeping the first`, { kept: current, ignored: c.value, from: c.from });
	}
	for (const p of ex.unknown_providers) log.info(`unknown Genius media provider '${p.provider}'`, { song_id: ex.song_id, url: p.url });

	// applemusic_id: fills only when empty (then the iTunes fast path runs via `events`), conflicts are recorded.
	const enrich_ctx = { source: 'genius', user_id, token_jti, events };
	const result = await enrich_service_ids(tx, ctx.id, ids, enrich_ctx);
	prov.touch('service_ids_table', ctx.id, result.filled);

	for (const artist of ex.credited_artists) {
		const local = ctx.artists.find(a => names_match(a.name, artist.name));
		if (!local) continue;
		const r = await enrich_service_ids(tx, local.id, { genius_id: artist.id }, enrich_ctx);
		prov.touch('service_ids_table', local.id, r.filled);
		await upsert_thumbnails(tx, local.id, artist.image_urls.map(url => ({ url })));
	}

	// Genius artwork sizes are unknown → NULL.
	await upsert_thumbnails(tx, ctx.id, ex.song_thumbnails.map(url => ({ url })));
}

export interface GeniusIngestBody {
	/** Absent for a page the client found on its own, which is still matched against the track */
	token?: string;
	track_id: string;
	result?: 'NOT_FOUND';
	preloaded_state?: unknown;
}

/** Runs inside the caller's transaction; the 422 is decided by the caller after commit. */
export async function ingest_genius(tx: Tx, user: AuthUser, body: GeniusIngestBody, events: PendingEvents): Promise<GeniusIngestResult> {
	if (body.token === undefined && body.result === 'NOT_FOUND') throw new HttpError(400, 'result: "NOT_FOUND" needs an action token');
	const jti = body.token === undefined ? null : (await consume_action_token(tx, user, body.token, 'CHECK_GENIUS', body.track_id)).jti;
	const track_id = await resolve_redirect(tx, body.track_id);
	const ctx = await load_track_context(tx, track_id);
	if (!ctx) throw new HttpError(404, 'track not found');
	const prov = new ProvenanceLog('genius', user.id, jti);
	const previous = (await load_lookups(tx, [track_id])).get(track_id) ?? new Map();
	const record = async (status: 'FOUND' | 'NOT_FOUND' | 'INSTRUMENTAL') => {
		await write_lookups(tx, track_id, [{ service: 'GENIUS', status, source_user_id: user.id }], previous);
		prov.touch('track_lyrics_lookups_table', `${track_id}:GENIUS`, ['status']);
	};

	if (body.result === 'NOT_FOUND') {
		await record('NOT_FOUND');
		await prov.write(tx);
		return { kind: 'not_found', track_id };
	}

	const ex = extract_genius_payload(body.preloaded_state);
	if ('error' in ex) throw new HttpError(400, ex.error);

	// Genius entities are stored even when the match fails; only the links depend on it.
	await write_genius_entities(tx, ex, prov);

	const match = match_genius_song(track_facts(ctx), ex);
	if (!match.matched) {
		await add_review_item(tx, {
			kind: 'GENIUS_MATCH_REJECTED',
			entity_table: 'tracks_table',
			entity_id: track_id,
			current_value: { title: ctx.title, artists: ctx.artists.map(a => a.name), album: ctx.album, duration_ms: ctx.duration_ms },
			proposed_value: { genius_song_id: ex.song_id },
			source_user_id: user.id,
			evidence: { reason: match.reason, genius: ex.facts, ids: ex.ids }
		});
		await record('NOT_FOUND');
		await prov.write(tx);
		log.info(`rejected Genius song ${ex.song_id} for track ${track_id}`, { reason: match.reason, user_id: user.id });
		return { kind: 'rejected', track_id, reason: match.reason };
	}

	if (ex.lyrics) {
		const ids = await insert_versions(tx, track_id, 'GENIUS', [ex.lyrics], { user_id: user.id, token_jti: jti });
		for (const id of ids) prov.touch('track_lyrics_table', id, ['*']);
		if (ids.length > 0) events.push('lyrics_stored', { track_id });
	}
	if (ex.producer_ids.length > 0) {
		await tx.insert(tracks_producers_table).values(ex.producer_ids.map(producer_id => ({ producer_id, track_id }))).onConflictDoNothing();
		prov.touch('tracks_producers_table', track_id, ex.producer_ids.map(String));
	}
	await enrich_track(tx, ctx, ex, prov, jti, user.id, events);
	await record(ex.instrumental ? 'INSTRUMENTAL' : ex.lyrics ? 'FOUND' : 'NOT_FOUND');
	await prov.write(tx);
	log.info(`stored Genius song ${ex.song_id} for track ${track_id}`, { match: match.method, user_id: user.id });
	return { kind: 'stored', track_id };
}
