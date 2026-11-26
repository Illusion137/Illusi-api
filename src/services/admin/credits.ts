/**
 * Track credits for the admin track page: which artists a track is by (in order, the first being the primary
 * artist) and which album it is on, edited in one save instead of row by row in the table browser.
 */
import { and, asc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../db';
import type { Executor, Tx } from '../../db';
import { album_tracks_table, albums_table, artist_albums_table, artists_table, service_ids_table, tracks_artists_table, tracks_table } from '../../db/schema';
import { write_audit } from '../../core/audit';
import { emit } from '../../core/events';
import { HttpError } from '../../core/http';
import { split_release_suffix } from '../../core/normalize';
import { resolve_redirect } from '../../core/redirects';

const escape_like = (s: string) => s.replace(/[\\%_]/gu, m => `\\${m}`);
const is_uuid = (v: string) => z.uuid().safeParse(v).success;

export const entity_search_schema = z.object({
	q: z.string().trim().min(1).max(256),
	limit: z.coerce.number().int().min(1).max(50).default(15)
});

/** Same name key first (case, accents, punctuation aside), then containing the text; most credited first. */
function name_filter(column: typeof artists_table.name | typeof albums_table.name, q: string) {
	return or(sql`illusi_name_key(${column}) = illusi_name_key(${q})`, ilike(column, `%${escape_like(q)}%`));
}

export async function search_artists(q: z.infer<typeof entity_search_schema>) {
	const tracks = sql<number>`(select count(*)::int from ${tracks_artists_table} x where x.artist_id = ${artists_table.id})`;
	const albums = sql<number>`(select count(*)::int from ${albums_table} x where x.artist_id = ${artists_table.id})`;
	const base = db.select({ id: artists_table.id, name: artists_table.name, tracks, albums }).from(artists_table);
	if (is_uuid(q.q)) return { items: await base.where(eq(artists_table.id, await resolve_redirect(db, q.q))) };
	const items = await base.where(name_filter(artists_table.name, q.q))
		.orderBy(sql`illusi_name_key(${artists_table.name}) = illusi_name_key(${q.q}) desc`, sql`${tracks} desc`, asc(artists_table.name)).limit(q.limit);
	return { items };
}

const album_artist = sql<string | null>`(select a.name from ${artists_table} a where a.id = ${albums_table.artist_id})`;

export async function search_albums(q: z.infer<typeof entity_search_schema>) {
	const tracks = sql<number>`(select count(*)::int from ${album_tracks_table} x where x.album_id = ${albums_table.id})`;
	const base = db.select({ id: albums_table.id, name: albums_table.name, artist: album_artist, album_type: albums_table.album_type, release_date: albums_table.release_date, tracks })
		.from(albums_table);
	if (is_uuid(q.q)) return { items: await base.where(eq(albums_table.id, await resolve_redirect(db, q.q))) };
	const items = await base.where(name_filter(albums_table.name, q.q))
		.orderBy(sql`illusi_name_key(${albums_table.name}) = illusi_name_key(${q.q}) desc`, sql`${tracks} desc`, asc(albums_table.name)).limit(q.limit);
	return { items };
}

/** The track's artists in credit order and every album it is on (its own album first). */
export async function track_credits(ex: Executor, track_id: string) {
	const [track] = await ex.select({ album_id: tracks_table.album_id }).from(tracks_table).where(eq(tracks_table.id, track_id));
	const artists = await ex.select({ id: artists_table.id, name: artists_table.name }).from(tracks_artists_table)
		.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
		.where(eq(tracks_artists_table.track_id, track_id)).orderBy(asc(tracks_artists_table.created_at), asc(artists_table.name));
	const linked = await ex.select({ id: albums_table.id, name: albums_table.name, artist: album_artist, album_type: albums_table.album_type, track_number: album_tracks_table.track_number })
		.from(album_tracks_table).innerJoin(albums_table, eq(albums_table.id, album_tracks_table.album_id)).where(eq(album_tracks_table.track_id, track_id));
	const own_id = track?.album_id ?? null;
	if (own_id && !linked.some(a => a.id === own_id)) {
		const [own] = await ex.select({ id: albums_table.id, name: albums_table.name, artist: album_artist, album_type: albums_table.album_type }).from(albums_table).where(eq(albums_table.id, own_id));
		if (own) linked.push({ ...own, track_number: null });
	}
	const albums = linked.map(a => ({ ...a, primary: a.id === own_id })).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
	return { artists, albums };
}

const artist_ref = z.union([z.object({ id: z.uuid() }), z.object({ name: z.string().trim().min(1).max(256) })]);

export const credits_body_schema = z.object({
	/** In credit order; the first is the primary artist. `{ name }` creates a new artist. */
	artists: z.array(artist_ref).min(1).max(50).optional(),
	/** The track's album: an existing one, a new one (`{ name }`, by the primary artist), or none. */
	album: z.union([z.object({ id: z.uuid() }), z.object({ name: z.string().trim().min(1).max(256) }), z.null()]).optional(),
	track_number: z.number().int().min(1).max(9999).nullable().optional(),
	/** Also unlink the track from albums other than its own (a compilation it was wrongly put on). */
	unlink_albums: z.array(z.uuid()).max(50).optional()
}).refine(b => b.artists !== undefined || b.album !== undefined || b.track_number !== undefined || (b.unlink_albums?.length ?? 0) > 0, 'nothing to change');

async function create_entity(tx: Tx, table: typeof artists_table | typeof albums_table, values: Record<string, unknown>): Promise<string> {
	const id = randomUUID();
	await tx.insert(service_ids_table).values({ illusi_id: id });
	await tx.insert(table).values({ ...values, id } as typeof table.$inferInsert);
	return id;
}

async function existing(tx: Tx, table: typeof artists_table | typeof albums_table, raw_id: string): Promise<string> {
	const id = await resolve_redirect(tx, raw_id);
	const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
	if (!row) throw new HttpError(400, 'referenced entity does not exist', { id: raw_id });
	return id;
}

/**
 * Replaces a track's credits. Artists are rewritten in the given order (their creation times carry the order, so
 * the first is the primary artist everywhere). Setting the album links the track to it (keeping other album
 * links unless listed in `unlink_albums`). The track's `modified_at` is bumped so clients pull it again, and iTunes
 * matches it again by its new credits.
 */
export async function update_track_credits(raw_id: string, body: z.infer<typeof credits_body_schema>, admin_id: string) {
	if (!is_uuid(raw_id)) throw new HttpError(400, 'invalid track id');
	const result = await db.transaction(async (tx) => {
		const id = await resolve_redirect(tx, raw_id);
		const [track] = await tx.select().from(tracks_table).where(eq(tracks_table.id, id)).for('update');
		if (!track) throw new HttpError(404, 'track not found');
		const before = await track_credits(tx, id);
		const created: { type: 'artist' | 'album'; id: string; name: string }[] = [];

		let artist_ids = before.artists.map(a => a.id);
		if (body.artists) {
			artist_ids = [];
			for (const ref of body.artists) {
				let artist_id: string;
				if ('id' in ref) {
					artist_id = await existing(tx, artists_table, ref.id);
				} else {
					artist_id = await create_entity(tx, artists_table, { name: ref.name });
					created.push({ type: 'artist', id: artist_id, name: ref.name });
				}
				if (!artist_ids.includes(artist_id)) artist_ids.push(artist_id);
			}
			await tx.delete(tracks_artists_table).where(eq(tracks_artists_table.track_id, id));
			const start = Date.now();
			await tx.insert(tracks_artists_table).values(artist_ids.map((artist_id, i) => {
				const at = new Date(start + i);
				return { artist_id, track_id: id, created_at: at, modified_at: at };
			}));
		}

		let album_id = track.album_id;
		if (body.album !== undefined) {
			if (body.album === null) {
				album_id = null;
			} else if ('id' in body.album) {
				album_id = await existing(tx, albums_table, body.album.id);
			} else {
				const release = split_release_suffix(body.album.name);
				album_id = await create_entity(tx, albums_table, { name: release.name, album_type: release.album_type, artist_id: artist_ids[0] ?? null });
				if (artist_ids[0]) await tx.insert(artist_albums_table).values({ artist_id: artist_ids[0], album_id, position: 0 }).onConflictDoNothing();
				created.push({ type: 'album', id: album_id, name: release.name });
			}
			if (track.album_id && track.album_id !== album_id) {
				await tx.delete(album_tracks_table).where(and(eq(album_tracks_table.track_id, id), eq(album_tracks_table.album_id, track.album_id)));
			}
		}
		if (album_id) {
			const number = body.track_number;
			await tx.insert(album_tracks_table).values({ album_id, track_id: id, track_number: number ?? null })
				.onConflictDoUpdate({
					target: [album_tracks_table.album_id, album_tracks_table.track_id],
					set: number === undefined ? { modified_at: new Date() } : { track_number: number, modified_at: new Date() }
				});
		}
		const unlink = (body.unlink_albums ?? []).filter(a => a !== album_id);
		if (unlink.length > 0) await tx.delete(album_tracks_table).where(and(eq(album_tracks_table.track_id, id), inArray(album_tracks_table.album_id, unlink), album_id ? ne(album_tracks_table.album_id, album_id) : undefined));
		await tx.update(tracks_table).set({ album_id, modified_at: new Date() }).where(eq(tracks_table.id, id));

		const after = await track_credits(tx, id);
		await write_audit(tx, {
			action: 'admin_edit',
			actor: 'admin',
			actor_user_id: admin_id,
			entity_table: 'tracks_table',
			entity_id: id,
			details: { credits: { before, after }, created },
			undo: { credits: { track_id: id, artists: before.artists.map(a => ({ id: a.id })), album_id: track.album_id, albums: before.albums.map(a => ({ id: a.id, track_number: a.track_number })) } }
		});
		return { id, ...after, created };
	});
	if (body.artists || body.album !== undefined) emit('metadata_changed', { illusi_id: result.id, entity_type: 'track' });
	return result;
}
