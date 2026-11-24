import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { consume_action_token, issue_actions, release_check_target, with_actions } from '../../core/actions';
import type { ActionType } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { PendingEvents } from '../../core/events';
import { HttpError, json_body, parse_body, require_user } from '../../core/http';
import { ProvenanceLog } from '../../core/provenance';
import { rate_limit_user } from '../../core/rate_limit';
import { apply_graph, CONTRIBUTE_MAX_ENTITIES, CONTRIBUTE_MAX_RELATIONS, flush_engine_events, graph_counts, raw_graph_schema, validate_graph } from '../entities';
import { flatten_items, unwrap_items, write_batch } from '../soundcloud';
import {
	dedupe_feed_albums, feed_ids, group_album_rows, is_release_service, parse_services, pick_checks, release_window, scope_graph, scope_soundcloud_batch,
	soundcloud_feed_rows, youtube_music_feed_rows
} from './logic';
import type { ReleaseService, ReleaseWindow, YouTubeMusicFeedAlbum } from './logic';
import { artist_service_id, check_candidates, feed_albums, mark_checked, mark_requested, prune_feed, released_albums, released_soundcloud_tracks, upsert_feed } from './query';
import type { SoundCloudReleaseRow } from './query';

export { RELEASE_SERVICES } from './logic';

/** Mounted after `require_auth`: `GET /new-releases`, `GET|POST /new-releases/me`, `POST /ingest/new_releases`. */
export const releases_router = Router();

const SC_ITEMS_MAX = 500;
const YTM_ALBUMS_MAX = 200;

const list_query_schema = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(200)
});

function parse_list_query(req: Request) {
	const query = list_query_schema.safeParse(req.query);
	if (!query.success) throw new HttpError(400, 'invalid query', { issues: query.error.issues });
	return query.data;
}

/** Raw queries return bigints as strings; SoundCloud ids fit a number. */
function soundcloud_release(row: SoundCloudReleaseRow) {
	return {
		id: Number(row.id),
		illusi_id: row.illusi_id,
		title: row.title,
		permalink: row.permalink,
		artwork_url: row.artwork_url,
		duration: row.duration,
		genre: row.genre,
		explicit: row.explicit,
		release_date: new Date(row.released_at).toISOString(),
		user: row.user_id == null ? null : { id: Number(row.user_id), username: row.username, permalink: row.user_permalink, avatar_url: row.avatar_url, verified: row.verified }
	};
}

/** A user's releases also hold the albums and playlists their own feeds showed them (`feed_albums`). */
async function new_releases(window: ReleaseWindow, limit: number, user_id?: string) {
	const [album_rows, soundcloud, feed] = await Promise.all([
		released_albums(db, window, limit, user_id),
		released_soundcloud_tracks(db, window, limit, user_id),
		user_id ? feed_albums(db, user_id, window, limit) : Promise.resolve(null)
	]);
	const albums = group_album_rows(album_rows);
	return {
		since: window.since.toISOString(),
		until: window.until.toISOString(),
		albums,
		soundcloud_tracks: soundcloud.map(soundcloud_release),
		...(feed ? { feed_albums: dedupe_feed_albums(feed, albums) } : {})
	};
}

/**
 * FETCH_NEW_RELEASES actions for library artists on the services the client says it's logged into
 *. Each handed-out check is marked requested so the next load doesn't ask for it again.
 */
async function release_check_actions(user: AuthUser, services: readonly ReleaseService[], window: ReleaseWindow): Promise<ActionType[]> {
	const limit = config.NEW_RELEASES_MAX_ACTIONS;
	if (services.length === 0 || limit <= 0) return [];
	const now = window.until;
	const policy = {
		recheck_after_ms: config.NEW_RELEASES_RECHECK_HOURS * 3_600_000,
		request_cooldown_ms: config.NEW_RELEASES_REQUEST_COOLDOWN_MIN * 60_000
	};
	const cutoffs = {
		checked_before: new Date(now.getTime() - policy.recheck_after_ms),
		requested_before: new Date(now.getTime() - policy.request_cooldown_ms)
	};
	const candidates = (await Promise.all(services.map(service => check_candidates(db, user.id, service, cutoffs, limit)))).flat();
	const picked = pick_checks(candidates, services, now, policy, limit);
	await mark_requested(db, picked, now);
	return issue_actions(user, picked.map(c => ({
		type: 'FETCH_NEW_RELEASES' as const,
		artist_id: c.artist_id,
		service: c.service,
		service_artist_id: c.service_artist_id,
		since: window.since.toISOString()
	})));
}

releases_router.get('/new-releases', async (req, res) => {
	const { limit } = parse_list_query(req);
	res.json(await new_releases(release_window(new Date(), config.NEW_RELEASES_WINDOW_DAYS), limit));
});

/** Only releases by artists in the user's library. `?services=spotify,soundcloud` asks for check actions on those services. */
releases_router.get('/new-releases/me', async (req, res) => {
	const user = require_user(req);
	const { limit } = parse_list_query(req);
	const window = release_window(new Date(), config.NEW_RELEASES_WINDOW_DAYS);
	const [data, actions] = await Promise.all([
		new_releases(window, limit, user.id),
		release_check_actions(user, parse_services(req.query.services), window)
	]);
	res.json(with_actions(data, actions));
});

const feed_artist_schema = z.object({
	name: z.string().trim().min(1).max(1024),
	id: z.string().trim().min(1).max(256).nullish()
});
const youtube_music_album_schema = z.object({
	id: z.string().trim().min(1).max(256),
	name: z.string().trim().min(1).max(1024),
	album_type: z.string().trim().min(1).max(32).nullish(),
	artists: z.array(feed_artist_schema).max(32).default([]),
	artwork_url: z.url({ protocol: /^https?$/u }).max(1024).nullish(),
	explicit: z.boolean().nullish()
});
const feed_schema = z.object({
	limit: z.number().int().min(1).max(500).default(200),
	/** Services the client is logged into; each adds FETCH_NEW_RELEASES actions, as `?services=` does on the GET */
	services: z.array(z.string().max(32)).max(16).default([]),
	/** Raw SoundCloud stream items (`/stream` collection entries or plain tracks and playlists) */
	soundcloud_items: z.array(z.unknown()).max(SC_ITEMS_MAX).default([]),
	/** Albums from YouTube Music's new-releases page; a malformed one is skipped, not the request */
	youtube_music_albums: z.array(z.unknown()).max(YTM_ALBUMS_MAX).default([])
});

/**
 * The client hands over what its own SoundCloud stream and YouTube Music new-releases page show, and gets back the
 * whole list: those (SoundCloud ones also go into the catalog) and releases by artists in the library.
 */
releases_router.post('/new-releases/me', rate_limit_user('new_releases_feed', 30, 60_000), json_body('4mb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(feed_schema, req.body);
	const window = release_window(new Date(), config.NEW_RELEASES_WINDOW_DAYS);
	const ytm_albums: YouTubeMusicFeedAlbum[] = [];
	let rejected = 0;
	for (const item of body.youtube_music_albums) {
		const parsed = youtube_music_album_schema.safeParse(item);
		if (parsed.success) ytm_albums.push(parsed.data);
		else rejected++;
	}
	const sc_items = unwrap_items(body.soundcloud_items);
	if (sc_items.length > SC_ITEMS_MAX) throw new HttpError(413, 'too many items', { max_items: SC_ITEMS_MAX });
	const { batch, rejected: sc_rejected } = flatten_items(sc_items);

	const pending = await db.transaction(async (tx) => {
		const events = new PendingEvents();
		if (batch.users.size + batch.tracks.size + batch.playlists.size > 0) {
			const prov = new ProvenanceLog('soundcloud', user.id);
			await write_batch(tx, user.id, batch, prov, events);
			if (prov.entities.length > 0) await prov.write(tx);
		}
		await prune_feed(tx, user.id, window);
		await upsert_feed(tx, [...soundcloud_feed_rows(user.id, batch, feed_ids(sc_items), window), ...youtube_music_feed_rows(user.id, ytm_albums)]);
		return events;
	});
	pending.flush();

	const [data, actions] = await Promise.all([
		new_releases(window, body.limit, user.id),
		release_check_actions(user, parse_services(body.services), window)
	]);
	res.json(with_actions({ ...data, rejected: rejected + sc_rejected }, actions));
});

const fulfil_schema = z.object({
	token: z.string().min(1).max(4096),
	artist_id: z.uuid(),
	service: z.string().refine(is_release_service, 'unknown service'),
	contribution_id: z.uuid().optional(),
	/** Albums/tracks found on the service, as a contribution graph. Not used for SoundCloud. */
	releases: raw_graph_schema.optional(),
	/** Raw SoundCloud objects. SoundCloud only. */
	soundcloud_items: z.array(z.unknown()).max(SC_ITEMS_MAX).optional()
});

/**
 * Fulfils a FETCH_NEW_RELEASES action. An empty submission is valid: it records that the artist had
 * nothing new. Anything not about the target artist is dropped, the rest goes through the
 * shared contribution engine or the SoundCloud writer in the same transaction as the token.
 */
releases_router.post('/ingest/new_releases', rate_limit_user('new_releases_ingest', 120, 60_000), json_body('4mb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(fulfil_schema, req.body);
	const service = body.service;
	if (body.releases) {
		const counts = graph_counts(body.releases);
		if (counts.entities > CONTRIBUTE_MAX_ENTITIES || counts.relations > CONTRIBUTE_MAX_RELATIONS) {
			throw new HttpError(413, 'too many entities', { max_entities: CONTRIBUTE_MAX_ENTITIES, max_relations: CONTRIBUTE_MAX_RELATIONS });
		}
	}

	const result = await db.transaction(async (tx) => {
		const action = await consume_action_token(tx, user, body.token, 'FETCH_NEW_RELEASES', release_check_target(service, body.artist_id));
		const now = new Date();
		const events: PendingEvents[] = [];
		let response: Record<string, unknown> = {};

		if (service === 'soundcloud') {
			const sc_user_id = Number(await artist_service_id(tx, body.artist_id, service));
			if (!sc_user_id) throw new HttpError(409, 'artist has no soundcloud id');
			const { batch, rejected } = flatten_items(unwrap_items(body.soundcloud_items ?? []));
			const scoped = scope_soundcloud_batch(batch, sc_user_id);
			const prov = new ProvenanceLog('soundcloud', user.id, action.jti);
			const pending = new PendingEvents();
			await write_batch(tx, user.id, scoped.batch, prov, pending);
			if (prov.entities.length > 0) await prov.write(tx);
			events.push(pending);
			response = {
				written: { users: scoped.batch.users.size, tracks: scoped.batch.tracks.size, playlists: scoped.batch.playlists.size },
				// Malformed items, and objects (nested ones included) not by the target's SoundCloud user.
				rejected,
				dropped: scoped.dropped
			};
		} else if (body.releases) {
			const validated = validate_graph(body.releases);
			const scoped = scope_graph(validated.graph, body.artist_id);
			const prov = new ProvenanceLog('contribute', user.id, action.jti, body.contribution_id ?? null);
			const applied = await apply_graph(tx, scoped.graph, { user_id: user.id, source: 'contribute', provenance: prov });
			response = {
				refs: applied.refs,
				created: applied.created,
				matched: applied.matched,
				conflicts: applied.conflicts,
				rejected: [...validated.rejected, ...scoped.rejected, ...applied.rejected]
			};
			await prov.write(tx, response);
			events.push(...applied.events);
		}

		await mark_checked(tx, body.artist_id, service, user.id, now);
		return { response, events };
	});
	flush_engine_events(result);
	res.json(result.response);
});
