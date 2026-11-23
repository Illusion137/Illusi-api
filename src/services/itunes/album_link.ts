import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../../db';
import {
	album_tracks_table, albums_table, artist_albums_table, artists_table, itunes_artists_table, itunes_collections_table, itunes_tracks_table,
	service_ids_table, tracks_artists_table, tracks_table
} from '../../db/schema';
import { enrich_service_ids } from '../../core/enrich';
import type { PendingEvents } from '../../core/events';
import { durations_match, name_similarity, names_match } from '../../core/normalize';
import { itunes_thumbnails, upsert_thumbnails } from '../../core/thumbnails';
import { album_candidates } from '../entities/candidates';

type AlbumType = NonNullable<typeof albums_table.$inferInsert.album_type>;

const RELEASE_SUFFIX_RE = /\s+-\s+(Single|EP)$/iu;

/** iTunes names singles and EPs "Name - Single" / "Name - EP" */
export function collection_album(name: string, track_count: number | null): { name: string; album_type: AlbumType } {
	const suffix = RELEASE_SUFFIX_RE.exec(name)?.[1]?.toUpperCase();
	const clean = name.replace(RELEASE_SUFFIX_RE, '').trim() || name;
	if (suffix === 'SINGLE') return { name: clean, album_type: 'SINGLE' };
	if (suffix === 'EP') return { name: clean, album_type: 'EP' };
	return { name: clean, album_type: track_count === 1 ? 'SINGLE' : 'ALBUM' };
}

/** `Song (feat. X)`, `Song [with X]`, `Song ft. X`: the featured artists, which iTunes and uploads write differently. */
const FEATURE_RE = /\s*(?:[([]\s*(?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]|\s(?:feat|ft|featuring)\.?\s.*$)/giu;
const without_features = (title: string) => title.replace(FEATURE_RE, '').trim() || title;

/** The same song title, featured artists aside. */
function same_title(title: string, song: string | null): boolean {
	if (!song) return false;
	return name_similarity(title, song) === 1 || name_similarity(without_features(title), without_features(song)) === 1;
}

/**
 * Puts a track with no album on the album of the iTunes song it was linked to, only when the song is surely the
 * track: the same title (featured artists aside), the song's artist among the track's credits, and a duration within
 * tolerance. Reuses the catalog's album for that collection (by Apple Music id, else by name under
 * the artist) before creating one. Returns the album id.
 */
export async function attach_itunes_album(tx: Tx, track_id: string, itunes_track_id: number, events: PendingEvents): Promise<string | null> {
	const [track] = await tx.select({ title: tracks_table.title, duration_ms: tracks_table.duration_ms, album_id: tracks_table.album_id })
		.from(tracks_table).where(eq(tracks_table.id, track_id)).for('update');
	if (track?.album_id !== null) return null;
	const [on_album] = await tx.select({ id: album_tracks_table.album_id }).from(album_tracks_table).where(eq(album_tracks_table.track_id, track_id)).limit(1);
	if (on_album) return null;

	const [song] = await tx.select({ t: itunes_tracks_table, artist_name: itunes_artists_table.name }).from(itunes_tracks_table)
		.leftJoin(itunes_artists_table, eq(itunes_artists_table.id, itunes_tracks_table.artist_id))
		.where(eq(itunes_tracks_table.id, itunes_track_id));
	if (!song?.artist_name || song.t.collection_id === null) return null;
	const credited = await tx.select({ id: artists_table.id, name: artists_table.name }).from(tracks_artists_table)
		.innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
		.where(eq(tracks_artists_table.track_id, track_id)).orderBy(asc(tracks_artists_table.created_at), asc(artists_table.id));
	const artist = credited.find(a => names_match(a.name, song.artist_name!));
	if (!artist) return null;
	if (!same_title(track.title, song.t.name) && !same_title(track.title, song.t.censored_name)) return null;
	if (!durations_match(track.duration_ms, song.t.track_time_millis)) return null;

	const [collection] = await tx.select().from(itunes_collections_table).where(eq(itunes_collections_table.id, song.t.collection_id));
	if (!collection) return null;
	const album_id = await album_for_collection(tx, collection, artist.id, events);

	await tx.update(tracks_table).set({ album_id }).where(and(eq(tracks_table.id, track_id), isNull(tracks_table.album_id)));
	await tx.insert(album_tracks_table).values({ album_id, track_id, track_number: song.t.track_number }).onConflictDoNothing();
	return album_id;
}

async function album_for_collection(tx: Tx, collection: typeof itunes_collections_table.$inferSelect, artist_id: string, events: PendingEvents): Promise<string> {
	const applemusic_id = String(collection.id);
	const [linked] = await tx.select({ id: albums_table.id }).from(service_ids_table)
		.innerJoin(albums_table, eq(albums_table.id, service_ids_table.illusi_id))
		.where(eq(service_ids_table.applemusic_id, applemusic_id)).limit(1);
	if (linked) return linked.id;

	const { name, album_type } = collection_album(collection.name, collection.track_count);
	const named = (await album_candidates(tx, name, [artist_id])).find(c => c.artist_ids.includes(artist_id) && name_similarity(name, c.name) === 1);
	if (named) {
		await enrich_service_ids(tx, named.id, { applemusic_id }, { source: 'itunes', events });
		return named.id;
	}

	const id = randomUUID();
	await tx.insert(service_ids_table).values({ illusi_id: id });
	await tx.insert(albums_table).values({
		id, name, artist_id, album_type, track_count: collection.track_count, release_date: collection.release_date,
		explicit: collection.explicitness === null ? null : collection.explicitness === 'explicit'
	});
	await tx.insert(artist_albums_table).values({ artist_id, album_id: id, position: null }).onConflictDoNothing();
	await enrich_service_ids(tx, id, { applemusic_id }, { source: 'itunes', events });
	await upsert_thumbnails(tx, id, itunes_thumbnails(collection));
	events.push('entity_created', { illusi_id: id, entity_type: 'album', imported: false });
	return id;
}
