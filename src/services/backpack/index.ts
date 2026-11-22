/**
 * Unavailable ("backpacked") tracks. A client reports a track it can't play or download; the server flags it and asks
 * users who have it in their library to look for it on a download service (RESEARCH_TRACK). Once every service has
 * answered without a usable result (or BACKPACK_RESEARCH_WINDOW_HOURS passed), any user or device that downloaded
 * it is asked for a copy (UPLOAD_MEDIA, backpacked tracks first). Media or a usable research result clears the flag.
 */
import { and, asc, eq, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { consume_action_token, issue_actions, research_target } from '../../core/actions';
import type { ActionBody, ActionType } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { enrich_service_ids } from '../../core/enrich';
import { PendingEvents } from '../../core/events';
import { HttpError, json_body, parse_body, require_user, uuid_schema } from '../../core/http';
import { rate_limit_user } from '../../core/rate_limit';
import { resolve_redirect } from '../../core/redirects';
import { normalize_service_id } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';
import { db } from '../../db';
import type { Executor, Tx } from '../../db';
import {
	artists_table, media_table, RESEARCH_SERVICES, service_ids_table, track_research_table, track_unavailable_reports_table, tracks_artists_table,
	tracks_table, user_tracks_table
} from '../../db/schema';
import { next_research_service, RESEARCH_COLUMNS, research_query } from './logic';
import type { ResearchService } from './logic';

export { next_research_service, research_due, research_query, RESEARCH_COLUMNS } from './logic';
export type { ResearchService } from './logic';

/** Mounted after `require_auth`: `POST /tracks/:id/unavailable`, `GET /backpack/requests`, `POST /ingest/track_research`. */
export const backpack_router = Router();

/** Backpacked tracks considered per request when building research actions. */
const RESEARCH_CANDIDATES = 50;

const policy = () => ({
	cooldown_ms: config.BACKPACK_RESEARCH_COOLDOWN_MIN * 60_000,
	retry_ms: config.BACKPACK_RESEARCH_RETRY_DAYS * 86_400_000
});

/** Clears the flag once the track is playable again (media uploaded, or a research result written). */
export async function clear_backpacked(tx: Tx, track_id: string): Promise<boolean> {
	const cleared = await tx.update(tracks_table)
		.set({ backpacked: false, backpacked_at: null, modified_at: new Date() })
		.where(and(eq(tracks_table.id, track_id), eq(tracks_table.backpacked, true)))
		.returning({ id: tracks_table.id });
	return cleared.length > 0;
}

/**
 * RESEARCH_TRACK actions for `user`: backpacked tracks in their library with no media, each on the next due service.
 * Marks every handed-out pair as requested.
 */
export async function research_actions(user: AuthUser, limit: number, now = new Date()): Promise<ActionType[]> {
	if (limit <= 0) return [];
	const candidates = await db.select({ id: tracks_table.id, title: tracks_table.title, duration_ms: tracks_table.duration_ms })
		.from(tracks_table)
		.innerJoin(user_tracks_table, and(eq(user_tracks_table.track_id, tracks_table.id), eq(user_tracks_table.user_id, user.id), eq(user_tracks_table.deleted, false)))
		.where(and(
			eq(tracks_table.backpacked, true),
			isNotNull(tracks_table.backpacked_at),
			notExists(db.select({ one: media_table.id }).from(media_table).where(eq(media_table.track_id, tracks_table.id)))
		))
		.orderBy(asc(tracks_table.backpacked_at), asc(tracks_table.id))
		.limit(RESEARCH_CANDIDATES);
	if (candidates.length === 0) return [];

	const ids = candidates.map(c => c.id);
	const [service_ids, research, credits] = await Promise.all([
		db.select().from(service_ids_table).where(inArray(service_ids_table.illusi_id, ids)),
		db.select().from(track_research_table).where(inArray(track_research_table.track_id, ids)),
		db.select({ track_id: tracks_artists_table.track_id, name: artists_table.name })
			.from(tracks_artists_table).innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
			.where(inArray(tracks_artists_table.track_id, ids)).orderBy(asc(tracks_artists_table.created_at))
	]);
	const sids = new Map(service_ids.map(r => [r.illusi_id, r]));
	const artists = new Map<string, string[]>();
	for (const c of credits) artists.set(c.track_id, [...(artists.get(c.track_id) ?? []), c.name]);

	const bodies: (ActionBody & { type: 'RESEARCH_TRACK' })[] = [];
	for (const track of candidates) {
		if (bodies.length >= limit) break;
		const row = sids.get(track.id);
		const filled = new Set<ServiceIdColumn>(RESEARCH_SERVICES.map(s => RESEARCH_COLUMNS[s]).filter(c => row?.[c] != null));
		const service = next_research_service(RESEARCH_SERVICES, filled, research.filter(r => r.track_id === track.id), now, policy());
		if (!service) continue;
		const names = artists.get(track.id) ?? [];
		bodies.push({ type: 'RESEARCH_TRACK', track_id: track.id, service, query: research_query(track.title, names), title: track.title, artists: names, duration_ms: track.duration_ms });
	}
	if (bodies.length === 0) return [];

	await db.insert(track_research_table)
		.values(bodies.map(b => ({ track_id: b.track_id, service: b.service, status: 'PENDING' as const, requested_at: now })))
		.onConflictDoUpdate({
			target: [track_research_table.track_id, track_research_table.service],
			set: { status: 'PENDING', requested_at: now, modified_at: now }
		});
	return issue_actions(user, bodies);
}

async function track_exists(ex: Executor, id: string): Promise<boolean> {
	const [row] = await ex.select({ id: tracks_table.id }).from(tracks_table).where(eq(tracks_table.id, id));
	return row !== undefined;
}

const report_schema = z.object({
	service: z.enum(RESEARCH_SERVICES),
	reason: z.string().trim().max(256).optional()
});

backpack_router.post('/tracks/:id/unavailable', rate_limit_user('backpack_report', 60, 60_000), json_body('8kb'), async (req, res) => {
	const user = require_user(req);
	const requested = uuid_schema.safeParse(req.params.id);
	if (!requested.success) throw new HttpError(400, 'invalid track id');
	const body = parse_body(report_schema, req.body);
	const track_id = await resolve_redirect(db, requested.data);

	const result = await db.transaction(async (tx) => {
		if (!(await track_exists(tx, track_id))) throw new HttpError(404, 'track not found');
		const [media] = await tx.select({ id: media_table.id }).from(media_table).where(eq(media_table.track_id, track_id)).limit(1);
		const now = new Date();
		await tx.insert(track_unavailable_reports_table)
			.values({ track_id, user_id: user.id, service: body.service, reason: body.reason ?? null })
			.onConflictDoUpdate({
				target: [track_unavailable_reports_table.track_id, track_unavailable_reports_table.user_id, track_unavailable_reports_table.service],
				set: { reason: body.reason ?? null, modified_at: now }
			});
		// A server copy exists, so the track is playable through GET /media.
		if (media) return { track_id, backpacked: false, backpacked_at: null, has_media: true };
		// Only someone who has the track can say it's unplayable for them; other reports are kept but flag nothing.
		const [own] = await tx.select({ track_id: user_tracks_table.track_id }).from(user_tracks_table)
			.where(and(eq(user_tracks_table.user_id, user.id), eq(user_tracks_table.track_id, track_id), eq(user_tracks_table.deleted, false)));
		if (!own) {
			const [current] = await tx.select({ backpacked: tracks_table.backpacked, backpacked_at: tracks_table.backpacked_at }).from(tracks_table).where(eq(tracks_table.id, track_id));
			return { track_id, backpacked: current.backpacked, backpacked_at: current.backpacked_at, has_media: false };
		}
		const [row] = await tx.update(tracks_table)
			.set({ backpacked: true, backpacked_at: sql`coalesce(${tracks_table.backpacked_at}, ${now})`, modified_at: now })
			.where(eq(tracks_table.id, track_id))
			.returning({ backpacked_at: tracks_table.backpacked_at });
		return { track_id, backpacked: true, backpacked_at: row.backpacked_at, has_media: false };
	});
	res.json({ ...result, ...(track_id === requested.data ? {} : { redirected_from: requested.data }) });
});

const requests_query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

backpack_router.get('/backpack/requests', rate_limit_user('backpack_requests', 60, 60_000), async (req, res) => {
	const user = require_user(req);
	const query = requests_query.safeParse(req.query);
	if (!query.success) throw new HttpError(400, 'invalid query', { issues: query.error.issues });
	res.json({ actions: await research_actions(user, query.data.limit) });
});

const research_schema = z.object({
	token: z.string().min(1).max(4096),
	track_id: uuid_schema,
	service: z.enum(RESEARCH_SERVICES),
	result: z.literal('NOT_FOUND').optional(),
	/** The id or link found on `service`. */
	service_id: z.string().trim().min(1).max(512).optional()
}).refine(b => (b.result === 'NOT_FOUND') !== (b.service_id !== undefined), { message: 'send either service_id or result: "NOT_FOUND"' });

/**
 * Fulfils a RESEARCH_TRACK action. A found id goes through the shared service-id writer: an empty column is filled
 * and the track stops being backpacked; a different existing value becomes a service id conflict for review and the
 * track stays backpacked until that's resolved or media arrives.
 */
backpack_router.post('/ingest/track_research', rate_limit_user('track_research', 60, 60_000), json_body('8kb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(research_schema, req.body);
	const service: ResearchService = body.service;
	const column = RESEARCH_COLUMNS[service];
	const events = new PendingEvents();

	const result = await db.transaction(async (tx) => {
		const action = await consume_action_token(tx, user, body.token, 'RESEARCH_TRACK', research_target(service, body.track_id));
		const now = new Date();
		const record = async (status: 'FOUND' | 'NOT_FOUND', found_value: string | null) => {
			await tx.insert(track_research_table)
				.values({ track_id: body.track_id, service, status, checked_at: now, checked_by: user.id, found_value })
				.onConflictDoUpdate({
					target: [track_research_table.track_id, track_research_table.service],
					set: { status, checked_at: now, checked_by: user.id, found_value, modified_at: now }
				});
		};

		if (body.result === 'NOT_FOUND') {
			await record('NOT_FOUND', null);
			return { track_id: body.track_id, service, status: 'NOT_FOUND' as const, applied: false, backpacked: await still_backpacked(tx, body.track_id) };
		}

		const value = normalize_service_id(column, body.service_id!);
		if (value === null) throw new HttpError(422, `invalid ${service} id`, { column });
		const enriched = await enrich_service_ids(tx, body.track_id, { [column]: value }, { source: 'research', user_id: user.id, token_jti: action.jti, events });
		await record('FOUND', String(value));
		const applied = enriched.filled.includes(column);
		if (applied) await clear_backpacked(tx, body.track_id);
		const conflict = enriched.conflicts.find(c => c.column === column);
		return {
			track_id: body.track_id,
			service,
			status: 'FOUND' as const,
			applied,
			backpacked: await still_backpacked(tx, body.track_id),
			...(conflict ? { conflict } : {})
		};
	});
	events.flush();
	res.json(result);
});

async function still_backpacked(ex: Executor, track_id: string): Promise<boolean> {
	const [row] = await ex.select({ backpacked: tracks_table.backpacked }).from(tracks_table).where(eq(tracks_table.id, track_id));
	return row?.backpacked ?? false;
}
