import { rm } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, count, desc, eq, ilike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import {
	albums_table, artists_table, audit_log_table, media_table, service_ids_table, track_research_table, track_unavailable_reports_table,
	track_vocals_table, tracks_artists_table, tracks_table, users_table, RESEARCH_SERVICES
} from '../../db/schema';
import { write_audit } from '../../core/audit';
import { HttpError } from '../../core/http';
import { logger } from '../../core/log';
import { resolve_redirect } from '../../core/redirects';
import { is_valid_resource_id } from '../media';

const log = logger('admin');

export const tracks_query_schema = z.object({
	q: z.string().trim().min(1).max(256),
	limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const backpack_query_schema = z.object({
	sort: z.enum(['reports', 'age']).default('reports'),
	/** Only tracks every research service answered NOT_FOUND for. */
	exhausted: z.stringbool().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const audit_query_schema = z.object({
	action: z.string().max(32).optional(),
	actor: z.string().max(32).optional(),
	entity_id: z.string().max(64).optional(),
	before_id: z.coerce.number().int().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});

const escape_like = (s: string) => s.replace(/[\\%_]/gu, m => `\\${m}`);
const is_uuid = (v: string) => z.uuid().safeParse(v).success;

// Spelled out: drizzle leaves columns unqualified in single-table selects, where `id` would bind to the subquery's table.
const track_id_ref = sql.raw('"tracks_table"."id"');

const artist_names = sql<string[]>`coalesce((
	select array_agg(a.name order by a.name) from ${tracks_artists_table} ta join ${artists_table} a on a.id = ta.artist_id where ta.track_id = ${track_id_ref}
), '{}')`;
const media_count = sql<number>`(select count(*)::int from ${media_table} m where m.track_id = ${track_id_ref})`;

const track_summary = {
	id: tracks_table.id,
	title: tracks_table.title,
	duration_ms: tracks_table.duration_ms,
	album: albums_table.name,
	artists: artist_names,
	backpacked: tracks_table.backpacked,
	backpacked_at: tracks_table.backpacked_at,
	imported: tracks_table.imported,
	media_count
};

const media_columns = {
	id: media_table.id,
	track_id: media_table.track_id,
	resource_id: media_table.resource_id,
	quality: media_table.quality,
	content_hash: media_table.content_hash,
	uploaded_by: media_table.uploaded_by,
	uploader: users_table.username,
	created_at: media_table.created_at
};

export async function search_tracks(q: z.infer<typeof tracks_query_schema>) {
	const base = db.select(track_summary).from(tracks_table).leftJoin(albums_table, eq(albums_table.id, tracks_table.album_id));
	if (is_uuid(q.q)) return { items: await base.where(eq(tracks_table.id, await resolve_redirect(db, q.q))) };
	const items = await base.where(ilike(tracks_table.search_title, `%${escape_like(q.q.toLowerCase())}%`))
		.orderBy(asc(sql`length(${tracks_table.title})`), asc(tracks_table.title)).limit(q.limit);
	return { items };
}

export async function track_detail(raw_id: string) {
	if (!is_uuid(raw_id)) throw new HttpError(400, 'invalid track id');
	const id = await resolve_redirect(db, raw_id);
	const [track] = await db.select({ ...track_summary, album_id: tracks_table.album_id, created_at: tracks_table.created_at, modified_at: tracks_table.modified_at })
		.from(tracks_table).leftJoin(albums_table, eq(albums_table.id, tracks_table.album_id)).where(eq(tracks_table.id, id));
	if (!track) throw new HttpError(404, 'track not found');
	const [[service_ids], media, reports, research, audit] = await Promise.all([
		db.select().from(service_ids_table).where(eq(service_ids_table.illusi_id, id)),
		db.select(media_columns).from(media_table).leftJoin(users_table, eq(users_table.id, media_table.uploaded_by))
			.where(eq(media_table.track_id, id)).orderBy(desc(media_table.created_at)),
		db.select({
			user_id: track_unavailable_reports_table.user_id, username: users_table.username, service: track_unavailable_reports_table.service,
			reason: track_unavailable_reports_table.reason, created_at: track_unavailable_reports_table.created_at, modified_at: track_unavailable_reports_table.modified_at
		}).from(track_unavailable_reports_table).leftJoin(users_table, eq(users_table.id, track_unavailable_reports_table.user_id))
			.where(eq(track_unavailable_reports_table.track_id, id)).orderBy(desc(track_unavailable_reports_table.modified_at)),
		db.select().from(track_research_table).where(eq(track_research_table.track_id, id)).orderBy(asc(track_research_table.service)),
		db.select().from(audit_log_table).where(eq(audit_log_table.entity_id, id)).orderBy(desc(audit_log_table.id)).limit(20)
	]);
	return { track, redirected_from: id === raw_id ? null : raw_id, service_ids: service_ids ?? null, media, reports, research, audit };
}

/** Backpacked tracks with their reports and research progress: most reported first, or longest backpacked. */
export async function backpack_overview(q: z.infer<typeof backpack_query_schema>) {
	const reports = sql<number>`(select count(*)::int from ${track_unavailable_reports_table} r where r.track_id = ${track_id_ref})`;
	const reporters = sql<number>`(select count(distinct r.user_id)::int from ${track_unavailable_reports_table} r where r.track_id = ${track_id_ref})`;
	const last_reported_at = sql<string | null>`(select max(r.modified_at) from ${track_unavailable_reports_table} r where r.track_id = ${track_id_ref})`;
	const reported_services = sql<string[]>`coalesce((select array_agg(distinct r.service) from ${track_unavailable_reports_table} r where r.track_id = ${track_id_ref}), '{}')`;
	const research = sql<Record<string, string> | null>`(select jsonb_object_agg(x.service, x.status) from ${track_research_table} x where x.track_id = ${track_id_ref})`;
	const not_found = sql`(select count(*) from ${track_research_table} x where x.track_id = ${track_id_ref} and x.status = 'NOT_FOUND')`;

	const filters = [eq(tracks_table.backpacked, true)];
	if (q.exhausted) filters.push(sql`${not_found} >= ${RESEARCH_SERVICES.length}`);
	const where = and(...filters);
	const [{ total }] = await db.select({ total: count() }).from(tracks_table).where(where);
	const items = await db.select({ ...track_summary, reports, reporters, last_reported_at, reported_services, research })
		.from(tracks_table).leftJoin(albums_table, eq(albums_table.id, tracks_table.album_id)).where(where)
		.orderBy(...q.sort === 'reports' ? [desc(reports), asc(tracks_table.backpacked_at)] : [asc(tracks_table.backpacked_at)], asc(tracks_table.id))
		.limit(q.limit).offset((q.page - 1) * q.limit);
	return { items, total, page: q.page, limit: q.limit, has_more: q.page * q.limit < total };
}

/**
 * Removes a stored media file (wrong song, bad rip, takedown). The row goes in the transaction, the file after commit.
 * Vocal analysis of that file is dropped so the track is analyzed again from its next media.
 */
export async function remove_media(media_id: number, admin_id: string) {
	const removed = await db.transaction(async (tx) => {
		const [row] = await tx.delete(media_table).where(eq(media_table.id, media_id)).returning();
		if (!row) throw new HttpError(404, 'media not found');
		await tx.delete(track_vocals_table).where(and(eq(track_vocals_table.track_id, row.track_id), eq(track_vocals_table.resource_id, row.resource_id)));
		await tx.update(tracks_table).set({ modified_at: new Date() }).where(eq(tracks_table.id, row.track_id));
		await write_audit(tx, {
			action: 'admin_delete',
			actor: 'admin',
			actor_user_id: admin_id,
			entity_table: 'media_table',
			entity_id: row.track_id,
			details: { media: row }
		});
		return row;
	});
	if (is_valid_resource_id(removed.resource_id)) {
		await rm(path.join(config.MEDIA_DIR, removed.resource_id), { force: true })
			.catch((err: unknown) => log.error('could not remove media file', { resource_id: removed.resource_id, err }));
	}
	log.info('media removed by admin', { media_id, track_id: removed.track_id, resource_id: removed.resource_id, admin_id });
	return { id: removed.id, track_id: removed.track_id, resource_id: removed.resource_id };
}

export async function list_audit(q: z.infer<typeof audit_query_schema>) {
	const filters = [];
	if (q.action) filters.push(eq(audit_log_table.action, q.action));
	if (q.actor) filters.push(eq(audit_log_table.actor, q.actor));
	if (q.entity_id) filters.push(eq(audit_log_table.entity_id, q.entity_id));
	if (q.before_id) filters.push(sql`${audit_log_table.id} < ${q.before_id}`);
	const items = await db.select({
		id: audit_log_table.id,
		action: audit_log_table.action,
		actor: audit_log_table.actor,
		actor_user_id: audit_log_table.actor_user_id,
		actor_username: users_table.username,
		entity_table: audit_log_table.entity_table,
		entity_id: audit_log_table.entity_id,
		details: audit_log_table.details,
		created_at: audit_log_table.created_at
	}).from(audit_log_table).leftJoin(users_table, eq(users_table.id, audit_log_table.actor_user_id))
		.where(filters.length > 0 ? and(...filters) : undefined).orderBy(desc(audit_log_table.id)).limit(q.limit + 1);
	return { items: items.slice(0, q.limit), has_more: items.length > q.limit };
}
