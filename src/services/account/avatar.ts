import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import { users_table } from '../../db/schema';
import { HttpError } from '../../core/http';
import { logger } from '../../core/log';
import { delete_remote_media } from '../media/remote';
import { normalize_image } from '../media/transcode';

const log = logger('avatar');

/** Avatars live in their own folder of MEDIA_DIR as `<uuid>.webp`, always re-encoded on upload. */
export const AVATAR_SUBDIR = 'avatars';
const AVATAR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/u;

/** Absolute path of an avatar file, or null for a malformed id. */
export function avatar_path(avatar_id: string): string | null {
	return AVATAR_ID_RE.test(avatar_id) ? path.join(config.MEDIA_DIR, AVATAR_SUBDIR, avatar_id) : null;
}

/** Removes avatar files whose rows are gone, here and in the media bucket; a missing file is fine. */
export async function remove_avatar_files(avatar_ids: readonly (string | null)[]) {
	const removed: string[] = [];
	for (const id of avatar_ids) {
		const file = id ? avatar_path(id) : null;
		if (!file) continue;
		await rm(file, { force: true }).catch((err: unknown) => log.warn('could not remove avatar file', { avatar_id: id, err }));
		removed.push(`${AVATAR_SUBDIR}/${id}`);
	}
	await delete_remote_media(removed);
}

/** Normalizes an accepted upload into `MEDIA_DIR/avatars/<uuid>.webp` (at most AVATAR_MAX_PX a side) and returns its id. */
export async function store_avatar_file(temp_path: string): Promise<string> {
	const dir = path.join(config.MEDIA_DIR, AVATAR_SUBDIR);
	await mkdir(dir, { recursive: true });
	const avatar_id = `${randomUUID()}.webp`;
	const part = path.join(config.MEDIA_DIR, '.incoming', `${avatar_id}.part`);
	try {
		await normalize_image(temp_path, part, config.AVATAR_MAX_PX, 'webp');
		if ((await stat(part)).size === 0) throw new HttpError(422, 'could not decode image');
		await rename(part, path.join(dir, avatar_id));
	} finally {
		await rm(part, { force: true });
	}
	return avatar_id;
}

/**
 * Sets (`avatar_id`, a stored avatar file) or clears (null) the user's avatar. The replaced file is removed after
 * commit; the new one, if the update fails.
 */
export async function set_avatar(user_id: string, avatar_id: string | null): Promise<{ avatar_id: string | null }> {
	const previous = await db.transaction(async (tx) => {
		const [cur] = await tx.select({ avatar_id: users_table.avatar_id }).from(users_table).where(eq(users_table.id, user_id)).for('update');
		if (!cur) throw new HttpError(404, 'user not found');
		await tx.update(users_table).set({ avatar_id }).where(eq(users_table.id, user_id));
		return cur.avatar_id;
	}).catch(async (err: unknown) => {
		await remove_avatar_files([avatar_id]);
		throw err;
	});
	if (previous !== avatar_id) await remove_avatar_files([previous]);
	return { avatar_id };
}

/** Whether a user the caller can see has this avatar. */
export async function avatar_exists(avatar_id: string): Promise<boolean> {
	const [row] = await db.select({ id: users_table.id }).from(users_table).where(eq(users_table.avatar_id, avatar_id)).limit(1);
	return row !== undefined;
}
