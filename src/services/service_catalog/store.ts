import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../db';
import type { Tx } from '../../db';
import { albums_table, artists_table, service_albums_table, service_artists_table, service_ids_table, service_tracks_table, tracks_table } from '../../db/schema';
import type { CatalogService } from '../../db/schema';
import { SERVICE_ID_COLUMN } from './normalize';
import type { CatalogItem } from './normalize';

const CHUNK = 200;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** A later sighting that lacks a field keeps the stored one; the payload and `last_seen_at` always follow the latest. */
function upsert_set(table: PgTable, keep: readonly string[]): Record<string, SQL> {
	const cols = table as unknown as Record<string, { name: string }>;
	const set: Record<string, SQL> = {
		last_seen_at: sql`now()`,
		raw: sql`coalesce(excluded.raw, ${cols.raw as never})`
	};
	for (const key of keep) set[key] = sql`coalesce(excluded.${sql.identifier(cols[key].name)}, ${cols[key] as never})`;
	return set;
}

type Kind = CatalogItem['kind'];

/**
 * Points rows without a link at the global entity carrying the same service id. The entity's table is part of the
 * join, so a track id never links to an album.
 */
async function link(tx: Tx, service: CatalogService, kind: Kind, external_ids: string[]) {
	const column = service_ids_table[SERVICE_ID_COLUMN[service]];
	const [rows, entities] = kind === 'track' ? [service_tracks_table, tracks_table] : kind === 'album' ? [service_albums_table, albums_table] : [service_artists_table, artists_table];
	for (const part of chunks(external_ids)) {
		const found = await tx.select({ external_id: sql<string>`${column}::text`, illusi_id: service_ids_table.illusi_id })
			.from(service_ids_table).innerJoin(entities, eq(entities.id, service_ids_table.illusi_id))
			.where(inArray(sql`${column}::text`, part));
		for (const { external_id, illusi_id } of found) {
			await tx.update(rows).set({ illusi_id }).where(and(eq(rows.service, service), eq(rows.external_id, external_id), isNull(rows.illusi_id)));
		}
	}
}

async function write_kind<T extends CatalogItem>(items: T[], write: (batch: T[]) => Promise<unknown>) {
	for (const part of chunks(items)) await write(part);
}

/** Writes a validated batch in one transaction. Returns how many rows were written per kind. */
export async function write_items(items: readonly CatalogItem[]) {
	const counts = { artists: 0, albums: 0, tracks: 0 };
	await db.transaction(async (tx) => {
		const artists = items.filter(i => i.kind === 'artist');
		const albums = items.filter(i => i.kind === 'album');
		const tracks = items.filter(i => i.kind === 'track');
		await write_kind(artists, async (batch) => {
			await tx.insert(service_artists_table).values(batch.map(a => ({
				service: a.service, external_id: a.id, name: a.name, artwork_url: a.artwork_url ?? null, verified: a.verified ?? null,
				description: a.description ?? null, followers_count: a.followers_count ?? null, raw: a.raw ?? null
			}))).onConflictDoUpdate({
				target: [service_artists_table.service, service_artists_table.external_id],
				set: { ...upsert_set(service_artists_table, ['artwork_url', 'verified', 'description', 'followers_count']), name: sql`excluded.name` }
			});
		});
		await write_kind(albums, async (batch) => {
			await tx.insert(service_albums_table).values(batch.map(a => ({
				service: a.service, external_id: a.id, title: a.title, artist_names: a.artist_names ?? null, artist_external_ids: a.artist_ids ?? null,
				album_type: a.album_type ?? null, release_date: a.release_date ?? null, explicit: a.explicit ?? null,
				track_count: a.track_count ?? null, artwork_url: a.artwork_url ?? null, raw: a.raw ?? null
			}))).onConflictDoUpdate({
				target: [service_albums_table.service, service_albums_table.external_id],
				set: { ...upsert_set(service_albums_table, ['artist_names', 'artist_external_ids', 'album_type', 'release_date', 'explicit', 'track_count', 'artwork_url']), title: sql`excluded.title` }
			});
		});
		await write_kind(tracks, async (batch) => {
			await tx.insert(service_tracks_table).values(batch.map(t => ({
				service: t.service, external_id: t.id, title: t.title, alt_title: t.alt_title ?? null, artist_names: t.artist_names ?? null,
				artist_external_ids: t.artist_ids ?? null, album_title: t.album_title ?? null, album_external_id: t.album_id ?? null,
				duration_ms: t.duration_ms ?? null, explicit: t.explicit ?? null, plays: t.plays ?? null, isrc: t.isrc ?? null,
				artwork_url: t.artwork_url ?? null, raw: t.raw ?? null
			}))).onConflictDoUpdate({
				target: [service_tracks_table.service, service_tracks_table.external_id],
				set: { ...upsert_set(service_tracks_table, ['alt_title', 'artist_names', 'artist_external_ids', 'album_title', 'album_external_id', 'duration_ms', 'explicit', 'plays', 'isrc', 'artwork_url']), title: sql`excluded.title` }
			});
		});
		const by_group = new Map<string, { service: CatalogService; kind: Kind; ids: string[] }>();
		for (const item of items) {
			const key = `${item.service}:${item.kind}`;
			const group = by_group.get(key) ?? { service: item.service, kind: item.kind, ids: [] };
			group.ids.push(item.id);
			by_group.set(key, group);
		}
		for (const { service, kind, ids } of by_group.values()) await link(tx, service, kind, ids);
		counts.artists = artists.length;
		counts.albums = albums.length;
		counts.tracks = tracks.length;
	});
	return counts;
}
