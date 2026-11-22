import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db';
import { track_lyrics_table } from '../../db/schema';
import type { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { try_parse_lyrics } from './parse';
import { content_hash } from './store';
import type { LyricsVersion } from './types';

/**
 * Stores a user's edit of a track's lyrics as their one `USER` version, replacing their previous edit. It's ranked
 * with every other version, so it can become the track's best lyrics for everyone.
 */
export async function upsert_user_lyrics(tx: Tx, user_id: string, track_id: string, version: LyricsVersion, events: PendingEvents) {
	const parsed = try_parse_lyrics(version.format, version.sync_type, version.raw_content);
	if (!parsed.ok) throw new HttpError(400, 'lyrics don\'t parse', { reason: parsed.error });
	const t = track_lyrics_table;
	const hash = content_hash(version.raw_content);
	// Serializes this user's edits of the track, so they keep a single version
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user_lyrics:${user_id}:${track_id}`}, 0))`);
	const [own] = await tx.select({ id: t.id }).from(t).where(and(eq(t.track_id, track_id), eq(t.service, 'USER'), eq(t.source_user_id, user_id)));
	const [same] = await tx.select({ id: t.id }).from(t).where(and(eq(t.track_id, track_id), eq(t.content_hash, hash)));
	// An edit identical to a stored version adds nothing of its own
	if (same && same.id !== own?.id) {
		if (own) await tx.delete(t).where(eq(t.id, own.id));
		return;
	}
	const values = { sync_type: version.sync_type, format: version.format, raw_content: version.raw_content, content_hash: hash, parsed_cache: null, parser_version: null };
	if (own) await tx.update(t).set(values).where(eq(t.id, own.id));
	else await tx.insert(t).values({ ...values, track_id, service: 'USER', source_user_id: user_id });
	events.push('lyrics_stored', { track_id });
}
