import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
	action_token_uses_table, audit_log_table, export_jobs_table, media_table, playlists_table, review_items_table, service_id_conflicts_table,
	track_lyrics_lookups_table, track_lyrics_table, users_table
} from '../../db/schema';
import { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { logger } from '../../core/log';
import { remove_artwork_files } from '../playlists';
import { remove_export_files } from './export';

const log = logger('account');

/**
 * Deletes an account and everything personal in one transaction. Rows owned by the user go with it through their
 * foreign keys (sessions, library, playlists and their tracks and inheritance, plays, searches, linked playlists,
 * reports, exports, sync replays). What the user added to the shared catalog stays, with the user's id removed
 * from every column that recorded it. Their playlist artwork and export files are removed after commit.
 */
export async function delete_account(user_id: string): Promise<void> {
	const events = new PendingEvents();
	const files = await db.transaction(async (tx) => {
		const [user] = await tx.select({ id: users_table.id }).from(users_table).where(eq(users_table.id, user_id)).for('update');
		if (!user) throw new HttpError(404, 'user not found');

		const artwork = await tx.select({ id: playlists_table.artwork_id }).from(playlists_table)
			.where(and(eq(playlists_table.user_id, user_id), isNotNull(playlists_table.artwork_id)));
		const exports = await tx.select({ file_name: export_jobs_table.file_name }).from(export_jobs_table)
			.where(and(eq(export_jobs_table.user_id, user_id), isNotNull(export_jobs_table.file_name)));

		// Columns that record a user id without a foreign key.
		await tx.update(media_table).set({ uploaded_by: null }).where(eq(media_table.uploaded_by, user_id));
		await tx.update(service_id_conflicts_table).set({ source_user_id: null }).where(eq(service_id_conflicts_table.source_user_id, user_id));
		await tx.update(audit_log_table).set({ actor_user_id: null }).where(eq(audit_log_table.actor_user_id, user_id));
		await tx.update(track_lyrics_table).set({ source_user_id: null }).where(eq(track_lyrics_table.source_user_id, user_id));
		await tx.update(track_lyrics_lookups_table).set({ source_user_id: null }).where(eq(track_lyrics_lookups_table.source_user_id, user_id));
		await tx.delete(action_token_uses_table).where(eq(action_token_uses_table.user_id, user_id));
		await tx.execute(sql`
			update ${review_items_table} set
				source_user_ids = array_remove(${review_items_table.source_user_ids}, ${user_id}::uuid),
				proposed_values = (
					select coalesce(jsonb_agg(
						case when jsonb_typeof(v->'source_user_ids') = 'array'
							then jsonb_set(v, '{source_user_ids}', coalesce(
								(select jsonb_agg(s) from jsonb_array_elements(v->'source_user_ids') s where s <> to_jsonb(${user_id}::text)),
								'[]'::jsonb))
							else v end
						order by i), '[]'::jsonb)
					from jsonb_array_elements(${review_items_table.proposed_values}) with ordinality p(v, i)
				)
			where ${user_id}::uuid = any(${review_items_table.source_user_ids})
				or ${review_items_table.proposed_values}::text like ${`%${user_id}%`}`);

		// Foreign keys do the rest: cascades for personal rows, set null for catalog bookkeeping
		// (contributions_log_table, review_items_table.resolved_by, release checks, research).
		await tx.delete(users_table).where(eq(users_table.id, user_id));
		events.push('user_library_changed', { user_id });
		events.push('user_deleted', { user_id });
		return { artwork: artwork.map(r => r.id), exports: exports.map(r => r.file_name) };
	});
	events.flush();
	await remove_artwork_files(files.artwork);
	await remove_export_files(files.exports);
	log.info('account deleted', { user_id, artwork_files: files.artwork.length, export_files: files.exports.length });
}
