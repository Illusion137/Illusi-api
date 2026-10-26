import type { Tx } from '../../db';
import { consume_action_token } from '../../core/actions';
import type { AuthUser } from '../../core/auth/tokens';
import { enrich_service_ids } from '../../core/enrich';
import type { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { ProvenanceLog } from '../../core/provenance';
import { resolve_redirect } from '../../core/redirects';
import { ytm_version } from './formats';
import { insert_versions, load_lookups, load_track_context, write_lookups } from './store';

export interface YoutubeMusicIngestBody {
	token: string;
	track_id: string;
	youtube_id?: string;
	lyrics?: unknown;
	result?: 'NOT_FOUND';
}

/** Stores the payload as `YOUTUBE_MUSIC` (raw), records the lookup, and enriches `youtube_id`. */
export async function ingest_youtube_music(tx: Tx, user: AuthUser, body: YoutubeMusicIngestBody, events: PendingEvents): Promise<{ track_id: string; found: boolean }> {
	const consumed = await consume_action_token(tx, user, body.token, 'CHECK_YOUTUBE_MUSIC', body.track_id);
	const track_id = await resolve_redirect(tx, body.track_id);
	const ctx = await load_track_context(tx, track_id);
	if (!ctx) throw new HttpError(404, 'track not found');
	const prov = new ProvenanceLog('youtube_music', user.id, consumed.jti);
	const previous = (await load_lookups(tx, [track_id])).get(track_id) ?? new Map();

	const version = body.result === 'NOT_FOUND' ? null : ytm_version(body.lyrics);
	if (version) {
		const ids = await insert_versions(tx, track_id, 'YOUTUBE_MUSIC', [version], { user_id: user.id, token_jti: consumed.jti });
		for (const id of ids) prov.touch('track_lyrics_table', id, ['*']);
	}
	if (body.youtube_id) {
		const r = await enrich_service_ids(tx, track_id, { youtube_id: body.youtube_id }, { source: 'youtube_music', user_id: user.id, token_jti: consumed.jti, events });
		prov.touch('service_ids_table', track_id, r.filled);
	}
	await write_lookups(tx, track_id, [{ service: 'YOUTUBE_MUSIC', status: version ? 'FOUND' : 'NOT_FOUND', source_user_id: user.id }], previous);
	prov.touch('track_lyrics_lookups_table', `${track_id}:YOUTUBE_MUSIC`, ['status']);
	await prov.write(tx);
	return { track_id, found: version !== null };
}
