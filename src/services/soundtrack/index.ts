import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { require_user } from '../../core/http';
import { rate_limit_user } from '../../core/rate_limit';
import { track_views } from '../catalog/views';
import { parse_query } from '../catalog/paging';
import { recent_play_track_ids, taste_search, user_library_track_ids } from '../vectors';
import { day_seed, mix_soundtrack, seeded_random } from './logic';
import { artist_picks, heavy_rotation, track_artists } from './query';

/** Mounted after `require_auth`: `GET /me/soundtrack`. */
export const soundtrack_router = Router();

/** Plays this recent count towards heavy rotation, each weighing e^(-age / ROTATION_DECAY_DAYS) */
const ROTATION_DAYS = 60;
const ROTATION_DECAY_DAYS = 10;
const ROTATION_POOL = 80;
/** The hottest tracks whose mean vector is the user's current taste */
const TASTE_SEEDS = 40;
/** Without recent plays, the library stands in for taste; a sample keeps the mean cheap */
const LIBRARY_TASTE_SAMPLE = 300;
const TOP_ARTISTS = 12;

const query_schema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

/**
 * "My Soundtrack": the tracks the user has on heavy rotation right now, mixed with tracks picked for them (nearest
 * their current taste vector and outside their library, then by similar artists). The mix changes once a day.
 */
soundtrack_router.get('/me/soundtrack', rate_limit_user('soundtrack', 60, 60_000), async (req, res) => {
	const user = require_user(req);
	const { limit } = parse_query(query_schema, req);
	const now = new Date();
	const rotation = await heavy_rotation(db, user.id, now, { days: ROTATION_DAYS, decay_days: ROTATION_DECAY_DAYS, limit: ROTATION_POOL });
	const rotation_ids = rotation.map(r => r.track_id);

	let taste = rotation_ids.slice(0, TASTE_SEEDS);
	if (taste.length === 0) taste = await recent_play_track_ids(user.id, TASTE_SEEDS);
	if (taste.length === 0) taste = (await user_library_track_ids(user.id)).slice(0, LIBRARY_TASTE_SAMPLE);
	const near = await taste_search(taste, limit * 3, [...new Set([...rotation_ids, ...taste])], { user_id: user.id, exclude_library_of: user.id });
	const recommended = near.map(n => n.track_id);

	const artists = await track_artists(db, [...rotation_ids, ...recommended]);
	if (recommended.length < limit * 2) {
		const top_artists = [...new Set(rotation.flatMap(r => artists.get(r.track_id) ?? []))].slice(0, TOP_ARTISTS);
		const picks = await artist_picks(db, user.id, top_artists, [...rotation_ids, ...recommended], limit * 2 - recommended.length);
		for (const [track_id, ids] of await track_artists(db, picks)) artists.set(track_id, ids);
		recommended.push(...picks);
	}

	const mix = mix_soundtrack({ rotation, recommended, artists, limit, random: seeded_random(day_seed(user.id, now)) });
	const views = await track_views(db, user.id, mix.map(m => m.track_id));
	res.json({
		generated_at: now.toISOString(),
		items: mix.flatMap(({ track_id, reason }) => {
			const track = views.get(track_id);
			return track ? [{ reason, track }] : [];
		})
	});
});
