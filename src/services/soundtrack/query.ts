import { inArray, sql } from 'drizzle-orm';
import type { Executor } from '../../db';
import { tracks_artists_table } from '../../db/schema';
import type { RotationTrack } from './logic';

const uuid_array = (ids: readonly string[]) => sql`array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::uuid[]`;

/**
 * What the user has been playing in the last `days`, hottest first: each play counts `e^(-age / decay)`, so a track
 * played a lot this week beats one played a lot last month. Tracks they deleted from their library are left out.
 */
export async function heavy_rotation(ex: Executor, user_id: string, now: Date, opts: { days: number; decay_days: number; limit: number }): Promise<RotationTrack[]> {
	const since = new Date(now.getTime() - opts.days * 86_400_000);
	const rows = await ex.execute<{ track_id: string; plays: number | string; score: number | string }>(sql`
		select p.track_id, count(*) as plays,
			sum(exp(-extract(epoch from (${now}::timestamptz - p.created_at)) / ${opts.decay_days * 86_400})) as score
		from track_plays_table p
		where p.user_id = ${user_id} and p.created_at >= ${since}
			and not exists (select 1 from user_tracks_table ut where ut.user_id = p.user_id and ut.track_id = p.track_id and ut.deleted)
		group by p.track_id
		order by score desc, p.track_id
		limit ${opts.limit}`, 'objects');
	return rows.map(r => ({ track_id: r.track_id, plays: Number(r.plays), score: Number(r.score) }));
}

/** Credited artists of each track. */
export async function track_artists(ex: Executor, track_ids: readonly string[]): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	if (track_ids.length === 0) return out;
	const rows = await ex.select({ track_id: tracks_artists_table.track_id, artist_id: tracks_artists_table.artist_id })
		.from(tracks_artists_table)
		.where(inArray(tracks_artists_table.track_id, [...new Set(track_ids)]));
	for (const row of rows) out.set(row.track_id, [...(out.get(row.track_id) ?? []), row.artist_id]);
	return out;
}

/**
 * Tracks by artists similar to `artist_ids` (stored pairs, either direction) and other tracks by those artists, most
 * played overall first. The fallback for users whose taste vectors don't cover enough of the catalog.
 */
export async function artist_picks(ex: Executor, user_id: string, artist_ids: readonly string[], exclude_track_ids: readonly string[], limit: number): Promise<string[]> {
	if (artist_ids.length === 0 || limit <= 0) return [];
	const exclude = exclude_track_ids.length === 0 ? sql`` : sql`and not (ta.track_id = any(${uuid_array(exclude_track_ids)}))`;
	const rows = await ex.execute<{ track_id: string }>(sql`
		with seeds as (select unnest(${uuid_array(artist_ids)}) as artist_id),
		near as (
			select artist_id from seeds
			union
			select case when sa.artist_id = s.artist_id then sa.similar_artist_id else sa.artist_id end
			from similar_artists_table sa
			join seeds s on s.artist_id in (sa.artist_id, sa.similar_artist_id)
		)
		select ta.track_id
		from near n
		join tracks_artists_table ta on ta.artist_id = n.artist_id
		left join track_play_counts_table pc on pc.track_id = ta.track_id
		where not exists (select 1 from user_tracks_table ut where ut.user_id = ${user_id} and ut.track_id = ta.track_id and ut.deleted) ${exclude}
		group by ta.track_id
		order by max(coalesce(pc.plays, 0)) desc, ta.track_id
		limit ${limit}`, 'objects');
	return rows.map(r => r.track_id);
}
