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
import { group_album_rows, is_release_service, parse_services, pick_checks, release_window, scope_graph, scope_soundcloud_batch } from './logic';
import type { ReleaseService, ReleaseWindow } from './logic';
import { artist_service_id, check_candidates, mark_checked, mark_requested, released_albums, released_soundcloud_tracks } from './query';
import type { SoundCloudReleaseRow } from './query';

export { RELEASE_SERVICES } from './logic';

/** Mounted after `require_auth`: `GET /new-releases`, `GET /new-releases/me`, `POST /ingest/new_releases`. */
export const releases_router = Router();

const SC_ITEMS_MAX = 500;

const list_query_schema = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(200)
});

function parse_list_query(req: Request) {
	const query = list_query_schema.safeParse(req.query);
	if (!query.success) throw new HttpError(400, 'invalid query', { issues: query.error.issues });
	return query.data;
}

function soundcloud_release(row: SoundCloudReleaseRow) {
	return {
		id: row.id,
		illusi_id: row.illusi_id,
		title: row.title,
		permalink: row.permalink,
		artwork_url: row.artwork_url,
		duration: row.duration,
		genre: row.genre,
		explicit: row.explicit,
		release_date: new Date(row.released_at).toISOString(),
		user: row.user_id == null ? null : { id: row.user_id, username: row.username, permalink: row.user_permalink, avatar_url: row.avatar_url, verified: row.verified }
	};
}

async function new_releases(window: ReleaseWindow, limit: number, user_id?: string) {
	const [albums, soundcloud] = await Promise.all([
		released_albums(db, window, limit, user_id),
		released_soundcloud_tracks(db, window, limit, user_id)
	]);
	return {
		since: window.since.toISOString(),
		until: window.until.toISOString(),
		albums: group_album_rows(albums),
		soundcloud_tracks: soundcloud.map(soundcloud_release)
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
