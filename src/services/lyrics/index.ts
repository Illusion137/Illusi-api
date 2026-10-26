import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { tracks_table } from '../../db/schema';
import { issue_actions, with_actions } from '../../core/actions';
import type { ActionBody, ActionType } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { PendingEvents } from '../../core/events';
import { HttpError, json_body, parse_body, require_user, uuid_schema } from '../../core/http';
import { rate_limit_user } from '../../core/rate_limit';
import { resolve_redirect } from '../../core/redirects';
import { ingest_genius } from './genius_ingest';
import { enqueue_background, lookup_track, lookup_track_with_deadline } from './lookup';
import { client_services_to_ask, due_server_services, is_instrumental } from './schedule';
import { genius_instrumental_tracks, has_lyrics_rows, load_lookups, load_track_context, never_looked_up, resolve_best_rows, search_query } from './store';
import type { BestRow, LookupMap } from './store';
import type { ClientService, ParsedLyrics } from './types';
import { ingest_youtube_music } from './youtube_music';

export { rank_lyrics, set_lyrics_ranker } from './rank';
export type { LyricsRanker } from './rank';
export type { LyricsLine, LyricsSegment, ParsedLyrics } from './types';

/** Mounted after `require_auth`: `GET /tracks/:id/lyrics`, `POST /ingest/genius`, `POST /ingest/youtube_music_lyrics`. */
export const lyrics_router = Router();

/** What clients receive: parsed lyrics, never raw content. */
export type BestLyrics
	= | { instrumental: true }
		| { instrumental?: false; service: string; sync_type: string; lyrics: ParsedLyrics };

const to_best = (row: BestRow): BestLyrics => ({ service: row.service, sync_type: row.sync_type, lyrics: row.parsed });

/** Best parsed lyrics (or instrumental) per track, for sync pull. Tracks with nothing are absent. */
export async function get_best_lyrics(track_ids: readonly string[]): Promise<Map<string, BestLyrics>> {
	const out = new Map<string, BestLyrics>();
	if (track_ids.length === 0) return out;
	const best = await resolve_best_rows(db, track_ids);
	for (const [id, row] of best) out.set(id, to_best(row));
	const rest = track_ids.filter(id => !best.has(id));
	if (rest.length === 0) return out;
	const [lookups, genius] = await Promise.all([load_lookups(db, rest), genius_instrumental_tracks(db, rest)]);
	for (const id of rest) {
		if (is_instrumental(lookups.get(id) ?? new Map(), genius.has(id))) out.set(id, { instrumental: true });
	}
	return out;
}

function action_bodies(track_id: string, services: readonly ClientService[], query: string, youtube_id: string | null | undefined): ActionBody[] {
	return services.map((s): ActionBody => s === 'GENIUS'
		? { type: 'CHECK_GENIUS', track_id, query }
		: { type: 'CHECK_YOUTUBE_MUSIC', track_id, query, ...(youtube_id ? { youtube_id } : {}) });
}

async function actions_for_track(user: AuthUser, track_id: string, lookups: LookupMap, now: Date): Promise<ActionType[]> {
	const services = client_services_to_ask(lookups, now, false);
	if (services.length === 0) return [];
	const ctx = await load_track_context(db, track_id);
	if (!ctx) return [];
	return issue_actions(user, action_bodies(track_id, services, search_query(ctx), ctx.service_ids?.youtube_id));
}

/** CHECK_GENIUS / CHECK_YOUTUBE_MUSIC actions for tracks where every server service has a current NOT_FOUND. */
export async function lyrics_actions_for_tracks(user: AuthUser, track_ids: readonly string[], limit: number): Promise<ActionType[]> {
	if (limit <= 0 || track_ids.length === 0) return [];
	const now = new Date();
	const [lookups, with_rows, genius] = await Promise.all([load_lookups(db, track_ids), has_lyrics_rows(db, track_ids), genius_instrumental_tracks(db, track_ids)]);
	const out: ActionType[] = [];
	for (const id of new Set(track_ids)) {
		if (out.length >= limit) break;
		const map = lookups.get(id);
		if (!map || with_rows.has(id) || is_instrumental(map, genius.has(id))) continue;
		const actions = await actions_for_track(user, id, map, now);
		out.push(...actions.slice(0, limit - out.length));
	}
	return out;
}

/** Queues background lookups for tracks that have **never** been looked up. */
export async function queue_never_looked_up(track_ids: readonly string[]): Promise<void> {
	if (track_ids.length === 0) return;
	enqueue_background(await never_looked_up(db, track_ids));
}

interface LyricsResponse {
	track_id: string;
	lyrics: ParsedLyrics | null;
	service?: string;
	sync_type?: string;
	instrumental?: true;
}

async function current_state(track_id: string) {
	const [best, lookups, genius] = await Promise.all([
		resolve_best_rows(db, [track_id]),
		load_lookups(db, [track_id]),
		genius_instrumental_tracks(db, [track_id])
	]);
	const map = lookups.get(track_id) ?? new Map();
	return { best: best.get(track_id) ?? null, lookups: map, instrumental: is_instrumental(map, genius.has(track_id)) };
}

function respond(track_id: string, state: Awaited<ReturnType<typeof current_state>>): LyricsResponse | null {
	if (state.best) return { track_id, service: state.best.service, sync_type: state.best.sync_type, lyrics: state.best.parsed };
	if (state.instrumental) return { track_id, instrumental: true, lyrics: null };
	return null;
}

async function get_track_lyrics(user: AuthUser, id: string): Promise<LyricsResponse & { actions?: ActionType[] }> {
	const track_id = await resolve_redirect(db, id);
	const [track] = await db.select({ id: tracks_table.id }).from(tracks_table).where(eq(tracks_table.id, track_id));
	if (!track) throw new HttpError(404, 'track not found');

	let state = await current_state(track_id);
	const stored = respond(track_id, state);
	if (stored) {
		// Step 1: serve now; services that are due get rechecked in the background.
		if (state.best && due_server_services(state.lookups, new Date()).length > 0) void lookup_track(track_id);
		return stored;
	}

	await lookup_track_with_deadline(track_id);
	state = await current_state(track_id);
	const found = respond(track_id, state);
	if (found) return found;
	return with_actions({ track_id, lyrics: null }, await actions_for_track(user, track_id, state.lookups, new Date()));
}

lyrics_router.get('/tracks/:id/lyrics', rate_limit_user('lyrics_get', 120, 60_000), async (req, res) => {
	const user = require_user(req);
	const id = parse_body(uuid_schema, req.params.id);
	res.json(await get_track_lyrics(user, id));
});

const token_schema = z.string().min(1).max(4096);

const genius_schema = z.object({
	token: token_schema,
	track_id: uuid_schema,
	result: z.literal('NOT_FOUND').optional(),
	preloaded_state: z.unknown().optional()
}).refine(b => b.result === 'NOT_FOUND' || (typeof b.preloaded_state === 'object' && b.preloaded_state !== null), { message: 'preloaded_state or result: "NOT_FOUND" is required' });

lyrics_router.post('/ingest/genius', rate_limit_user('ingest_genius', 30, 60_000), json_body('2mb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(genius_schema, req.body);
	const events = new PendingEvents();
	const result = await db.transaction(async tx => ingest_genius(tx, user, body, events));
	events.flush();
	if (result.kind === 'rejected') throw new HttpError(422, 'Genius song does not match the track', { reason: result.reason });
	res.json(respond(result.track_id, await current_state(result.track_id)) ?? { track_id: result.track_id, lyrics: null });
});

const youtube_music_schema = z.object({
	token: token_schema,
	track_id: uuid_schema,
	youtube_id: z.string().min(1).max(256).optional(),
	lyrics: z.union([z.string().max(512_000), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
	result: z.literal('NOT_FOUND').optional()
});

lyrics_router.post('/ingest/youtube_music_lyrics', rate_limit_user('ingest_youtube_music', 30, 60_000), json_body('1mb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(youtube_music_schema, req.body);
	const events = new PendingEvents();
	const result = await db.transaction(async tx => ingest_youtube_music(tx, user, body, events));
	events.flush();
	res.json(respond(result.track_id, await current_state(result.track_id)) ?? { track_id: result.track_id, lyrics: null });
});
