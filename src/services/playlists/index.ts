import { Router } from 'express';
import { db } from '../../db';
import { PendingEvents } from '../../core/events';
import { HttpError, require_user, uuid_schema } from '../../core/http';
import { copy_playlist } from './copy';

export { assert_inheritance_allowed, creates_cycle } from './inheritance';
export { invalidate_user_cache, resolve_playlist, resolve_playlist_track_ids } from './resolve';

/** Mounted after `require_auth`: `POST /playlists/:id/copy`. */
export const playlists_router = Router();

playlists_router.post('/playlists/:id/copy', async (req, res) => {
	const user = require_user(req);
	const id = uuid_schema.safeParse(req.params.id);
	if (!id.success) throw new HttpError(400, 'invalid playlist id');
	const events = new PendingEvents();
	const result = await db.transaction(async (tx) => {
		const copied = await copy_playlist(tx, user.id, id.data);
		events.push('user_library_changed', { user_id: user.id });
		return copied;
	});
	events.flush();
	res.status(201).json(result);
});
