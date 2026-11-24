import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Executor } from '../../db';
import { albums_table, artist_release_checks_table, service_ids_table, user_release_feed_table } from '../../db/schema';
import { RELEASE_SERVICES } from './logic';
import type { AlbumRow, CheckCandidate, FeedAlbum, FeedArtist, FeedRow, ReleaseService, ReleaseWindow } from './logic';

/** Artists on any of the user's (non-deleted) library tracks. */
const library_artists = (user_id: string) => sql`
	select distinct ta.artist_id
	from user_tracks_table ut
	join tracks_artists_table ta on ta.track_id = ut.track_id
	where ut.user_id = ${user_id} and not ut.deleted`;

/**
 * SoundCloud uploaders the user follows through their library: users linked to a library artist
 * (artist `soundcloud_id` = SoundCloud user id), and uploaders of SoundCloud tracks in the library.
 */
const library_soundcloud_users = (user_id: string) => sql`
	select si.soundcloud_id as sc_user_id
	from (${library_artists(user_id)}) lib
	join service_ids_table si on si.illusi_id = lib.artist_id
	where si.soundcloud_id is not null
	union
	select st.user_id
	from user_tracks_table ut
	join service_ids_table si on si.illusi_id = ut.track_id
	join soundcloud_tracks_table st on st.id = si.soundcloud_id
	where ut.user_id = ${user_id} and not ut.deleted and st.user_id is not null`;

/** Albums, singles and EPs released in the window, newest first; one row per (album, artist, thumbnail). */
export async function released_albums(ex: Executor, window: ReleaseWindow, limit: number, user_id?: string): Promise<AlbumRow[]> {
	const scope: SQL = user_id
		? sql`and (
			a.artist_id in (select artist_id from lib)
			or exists (select 1 from artist_albums_table aa join lib on lib.artist_id = aa.artist_id where aa.album_id = a.id)
		)`
		: sql``;
	const lib = user_id ? sql`lib as (${library_artists(user_id)}),` : sql``;
	return ex.execute<AlbumRow>(sql`
		with ${lib} released as (
			select a.id, a.name, a.album_type, a.release_date, a.track_count, a.explicit, a.artist_id
			from albums_table a
			where a.release_date >= ${window.since} and a.release_date <= ${window.until} ${scope}
			order by a.release_date desc, a.id
			limit ${limit}
		)
		select r.id, r.name, r.album_type, r.release_date, r.track_count, r.explicit,
			ar.id as artist_id, ar.name as artist_name,
			t.url as thumbnail_url, t.width as thumbnail_width, t.height as thumbnail_height
		from released r
		left join lateral (
			select x.artist_id, min(x.rank) as rank from (
				select r.artist_id, -1 as rank where r.artist_id is not null
				union all
				select aa.artist_id, coalesce(aa.position, 2147483647) from artist_albums_table aa where aa.album_id = r.id
			) x group by x.artist_id
		) credit on true
		left join artists_table ar on ar.id = credit.artist_id
		left join thumbnails_table t on t.id = r.id
		order by r.release_date desc, r.id, credit.rank, ar.id, t.width desc nulls last`, 'objects');
}

export interface SoundCloudReleaseRow {
	id: number | string;
	illusi_id: string | null;
	title: string;
	permalink: string | null;
	artwork_url: string | null;
	duration: number | null;
	genre: string | null;
	explicit: boolean | null;
	released_at: Date | string;
	user_id: number | string | null;
	username: string | null;
	user_permalink: string | null;
	avatar_url: string | null;
	verified: boolean | null;
}

/** Public SoundCloud tracks that came out in the window, newest first. A user's are from library uploaders and their own stream. */
export async function released_soundcloud_tracks(ex: Executor, window: ReleaseWindow, limit: number, user_id?: string): Promise<SoundCloudReleaseRow[]> {
	// Must match the `soundcloud_tracks_released_at_idx` expression.
	const released_at = sql`coalesce(st.release_date, st.display_date, st.soundcloud_created_at)`;
	const scope = user_id
		? sql`and (
			st.user_id in (${library_soundcloud_users(user_id)})
			or exists (select 1 from user_release_feed_table f where f.user_id = ${user_id} and f.service = 'soundcloud' and f.external_id = st.id::text)
		)`
		: sql``;
	return ex.execute<SoundCloudReleaseRow>(sql`
		select st.id, tr.id as illusi_id, st.title, st.permalink, st.artwork_url, st.duration, st.genre, st.explicit,
			${released_at} as released_at,
			su.id as user_id, su.username, su.permalink as user_permalink, su.avatar_url, su.verified
		from soundcloud_tracks_table st
		left join soundcloud_users_table su on su.id = st.user_id
		left join service_ids_table si on si.soundcloud_id = st.id
		left join tracks_table tr on tr.id = si.illusi_id
		where ${released_at} >= ${window.since} and ${released_at} <= ${window.until}
			and coalesce(st.sharing, 'public') = 'public' and st.public is not false ${scope}
		order by ${released_at} desc, st.id desc
		limit ${limit}`, 'objects');
}

const feed_released_at = sql`coalesce(${user_release_feed_table.released_at}, ${user_release_feed_table.first_seen_at})`;

/** Adds or refreshes feed rows; a row keeps the time it was first seen. */
export async function upsert_feed(ex: Executor, rows: readonly FeedRow[]) {
	if (rows.length === 0) return;
	await ex.insert(user_release_feed_table)
		.values([...rows])
		.onConflictDoUpdate({
			target: [user_release_feed_table.user_id, user_release_feed_table.service, user_release_feed_table.external_id],
			set: {
				kind: sql`excluded.kind`,
				name: sql`excluded.name`,
				album_type: sql`excluded.album_type`,
				artists: sql`excluded.artists`,
				artwork_url: sql`excluded.artwork_url`,
				url: sql`excluded.url`,
				explicit: sql`excluded.explicit`,
				released_at: sql`excluded.released_at`,
				modified_at: sql`now()`
			}
		});
}

/** Forgets feed rows that have aged out of the window. */
export async function prune_feed(ex: Executor, user_id: string, window: ReleaseWindow) {
	await ex.delete(user_release_feed_table)
		.where(and(eq(user_release_feed_table.user_id, user_id), lt(feed_released_at, window.since)));
}

/** The user's feed albums and playlists in the window, newest first. */
export async function feed_albums(ex: Executor, user_id: string, window: ReleaseWindow, limit: number): Promise<FeedAlbum[]> {
	const t = user_release_feed_table;
	const rows = await ex.select({
		service: t.service, id: t.external_id, name: t.name, album_type: t.album_type, explicit: t.explicit,
		artwork_url: t.artwork_url, url: t.url, artists: t.artists, released_at: sql<Date | string>`${feed_released_at}`
	})
		.from(t)
		// Undated rows were first seen by the database's clock, which may be just past `until`; only dates the service gave can be future ones.
		.where(and(eq(t.user_id, user_id), eq(t.kind, 'album'), sql`${feed_released_at} >= ${window.since}`, sql`(${t.released_at} is null or ${t.released_at} <= ${window.until})`))
		.orderBy(desc(feed_released_at), t.service, t.external_id)
		.limit(limit);
	return rows.map(({ released_at, artists, ...row }) => ({
		...row,
		artists: Array.isArray(artists) ? artists as FeedArtist[] : [],
		release_date: new Date(released_at).toISOString()
	}));
}

/** Library artists with an id on `service` whose check isn't fresh, oldest check first. */
export async function check_candidates(ex: Executor, user_id: string, service: ReleaseService, cutoffs: { checked_before: Date; requested_before: Date }, limit: number): Promise<CheckCandidate[]> {
	const column = sql.identifier(RELEASE_SERVICES[service]);
	const rows = await ex.execute<{ artist_id: string; service_artist_id: string | number; requested_at: Date | string | null; checked_at: Date | string | null }>(sql`
		select lib.artist_id, si.${column} as service_artist_id, c.requested_at, c.checked_at
		from (${library_artists(user_id)}) lib
		join service_ids_table si on si.illusi_id = lib.artist_id
		left join artist_release_checks_table c on c.artist_id = lib.artist_id and c.service = ${service}
		where si.${column} is not null
			and (c.checked_at is null or c.checked_at < ${cutoffs.checked_before})
			and (c.requested_at is null or c.requested_at < ${cutoffs.requested_before})
		order by c.checked_at asc nulls first, lib.artist_id
		limit ${limit}`, 'objects');
	const date = (v: Date | string | null) => (v == null ? null : new Date(v));
	return rows.map(r => ({
		artist_id: r.artist_id,
		service,
		service_artist_id: String(r.service_artist_id),
		requested_at: date(r.requested_at),
		checked_at: date(r.checked_at)
	}));
}

export async function mark_requested(ex: Executor, checks: readonly Pick<CheckCandidate, 'artist_id' | 'service'>[], now: Date) {
	if (checks.length === 0) return;
	await ex.insert(artist_release_checks_table)
		.values(checks.map(c => ({ artist_id: c.artist_id, service: c.service, requested_at: now })))
		.onConflictDoUpdate({
			target: [artist_release_checks_table.artist_id, artist_release_checks_table.service],
			set: { requested_at: now }
		});
}

/** `user_id` is null when the server checked itself. */
export async function mark_checked(ex: Executor, artist_id: string, service: ReleaseService, user_id: string | null, now: Date) {
	await ex.insert(artist_release_checks_table)
		.values({ artist_id, service, checked_at: now, checked_by: user_id })
		.onConflictDoUpdate({
			target: [artist_release_checks_table.artist_id, artist_release_checks_table.service],
			set: { checked_at: now, checked_by: user_id }
		});
}

/** The artist's id on `service`, or null when the artist or the id doesn't exist. */
export async function artist_service_id(ex: Executor, artist_id: string, service: ReleaseService): Promise<string | number | null> {
	const column = service_ids_table[RELEASE_SERVICES[service]];
	const [row] = await ex.select({ value: column })
		.from(service_ids_table)
		.where(and(eq(service_ids_table.illusi_id, artist_id), sql`exists (select 1 from artists_table where id = ${artist_id})`))
		.limit(1);
	return row?.value ?? null;
}

/** Artists in anyone's library with an Apple Music id whose Apple Music check is older than `checked_before`, oldest first. */
export async function due_applemusic_artists(ex: Executor, checked_before: Date, limit: number): Promise<{ artist_id: string; applemusic_id: string }[]> {
	return ex.execute<{ artist_id: string; applemusic_id: string }>(sql`
		select lib.artist_id, si.applemusic_id
		from (select distinct ta.artist_id from user_tracks_table ut join tracks_artists_table ta on ta.track_id = ut.track_id where not ut.deleted) lib
		join service_ids_table si on si.illusi_id = lib.artist_id
		left join artist_release_checks_table c on c.artist_id = lib.artist_id and c.service = 'applemusic'
		where si.applemusic_id is not null and (c.checked_at is null or c.checked_at < ${checked_before})
		order by c.checked_at asc nulls first, lib.artist_id
		limit ${limit}`, 'objects');
}

/** Which of these Apple Music ids an album already has. */
export async function linked_applemusic_albums(ex: Executor, applemusic_ids: readonly string[]): Promise<Set<string>> {
	if (applemusic_ids.length === 0) return new Set();
	const rows = await ex.select({ id: service_ids_table.applemusic_id }).from(service_ids_table)
		.innerJoin(albums_table, eq(albums_table.id, service_ids_table.illusi_id))
		.where(inArray(service_ids_table.applemusic_id, [...applemusic_ids]));
	return new Set(rows.map(r => r.id).filter((id): id is string => id !== null));
}
