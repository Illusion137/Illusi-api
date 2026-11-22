import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import type { Executor } from '../../db';
import { sessions_table, track_downloads_table, users_table } from '../../db/schema';
import { logger } from '../log';
import { hash_token, new_refresh_token, sign_access_token } from './tokens';
import type { AuthUser } from './tokens';

const log = logger('sessions');

export interface TokenPair { access_token: string; refresh_token: string }

const refresh_expiry = () => new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

export async function create_session(user: { id: string; role: AuthUser['role'] }, device_name?: string | null): Promise<TokenPair> {
	const refresh_token = new_refresh_token();
	const id = randomUUID();
	await db.insert(sessions_table).values({
		id,
		family_id: id,
		user_id: user.id,
		token_hash: hash_token(refresh_token),
		device_name: device_name ?? null,
		expires_at: refresh_expiry()
	});
	return { access_token: await sign_access_token({ id: user.id, role: user.role, sid: id }), refresh_token };
}

export type RefreshResult = { ok: true; tokens: TokenPair } | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' };

/**
 * Rotation with reuse detection: presenting an already-rotated token revokes the whole chain. The exception is a
 * token whose replacement was never used (within REFRESH_LOST_RESPONSE_DAYS): the client never received the
 * refresh response, so it rotates again from there instead of losing the login.
 */
export async function rotate_refresh_token(refresh_token: string): Promise<RefreshResult> {
	const token_hash = hash_token(refresh_token);
	return db.transaction(async (tx) => {
		const [row] = await tx.select().from(sessions_table).where(eq(sessions_table.token_hash, token_hash)).for('update');
		if (!row) return { ok: false, reason: 'unknown' } as const;
		let lost_replacement: string | null = null;
		if (row.revoked_at) {
			if (!row.replaced_by) return { ok: false, reason: 'revoked' } as const;
			const [next] = await tx.select().from(sessions_table).where(eq(sessions_table.id, row.replaced_by)).for('update');
			// A retired unreceived replacement is expired on retirement, so it never qualifies: presenting it is reuse.
			const lost = next?.revoked_at === null && next.replaced_by === null && row.expires_at.getTime() > Date.now()
				&& Date.now() - row.revoked_at.getTime() <= config.REFRESH_LOST_RESPONSE_DAYS * 86_400_000;
			if (!lost) {
				await tx.update(sessions_table).set({ revoked_at: new Date() })
					.where(and(eq(sessions_table.family_id, row.family_id), isNull(sessions_table.revoked_at)));
				await tx.delete(track_downloads_table).where(eq(track_downloads_table.session_family_id, row.family_id));
				log.warn(`refresh token reuse detected; revoked session family ${row.family_id}`, { user_id: row.user_id });
				return { ok: false, reason: 'reused' } as const;
			}
			lost_replacement = next.id;
			log.info('refresh response was lost; rotating again', { user_id: row.user_id, family_id: row.family_id });
		}
		if (row.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'expired' } as const;

		const [user] = await tx.select({ id: users_table.id, role: users_table.role }).from(users_table).where(eq(users_table.id, row.user_id));
		if (!user) return { ok: false, reason: 'unknown' } as const;

		const next_token = new_refresh_token();
		const next_id = randomUUID();
		const now = new Date();
		await tx.insert(sessions_table).values({
			id: next_id,
			family_id: row.family_id,
			user_id: row.user_id,
			token_hash: hash_token(next_token),
			device_name: row.device_name,
			last_used_at: now,
			expires_at: refresh_expiry()
		});
		if (lost_replacement) {
			// The unreceived replacement is retired for good (presenting it later counts as reuse), and the presented
			// token now leads to the new one, so a second lost response is survived the same way.
			await tx.update(sessions_table).set({ revoked_at: now, replaced_by: next_id, expires_at: now }).where(eq(sessions_table.id, lost_replacement));
			await tx.update(sessions_table).set({ replaced_by: next_id, last_used_at: now }).where(eq(sessions_table.id, row.id));
		} else {
			await tx.update(sessions_table).set({ revoked_at: now, replaced_by: next_id, last_used_at: now }).where(eq(sessions_table.id, row.id));
		}
		return { ok: true, tokens: { access_token: await sign_access_token({ id: user.id, role: user.role, sid: row.family_id }), refresh_token: next_token } } as const;
	});
}

/** Revokes the login a refresh token belongs to; false if the token is unknown. Lets a device log out without an access token. */
export async function revoke_by_refresh_token(refresh_token: string): Promise<boolean> {
	const [row] = await db.select({ family_id: sessions_table.family_id }).from(sessions_table).where(eq(sessions_table.token_hash, hash_token(refresh_token)));
	if (!row) return false;
	await revoke_family(row.family_id);
	return true;
}

/** Revokes every login of the user except `keep_family_id` (after a password change on that device). */
export async function revoke_other_sessions(user_id: string, keep_family_id: string) {
	await db.transaction(async (tx) => {
		await tx.update(sessions_table).set({ revoked_at: new Date() })
			.where(and(eq(sessions_table.user_id, user_id), isNull(sessions_table.revoked_at), ne(sessions_table.family_id, keep_family_id)));
		await tx.delete(track_downloads_table).where(and(eq(track_downloads_table.user_id, user_id), ne(track_downloads_table.session_family_id, keep_family_id)));
	});
}

/** A logged-out device can't upload anything, so its downloads are forgotten with it. */
export async function revoke_family(family_id: string) {
	await db.transaction(async (tx) => {
		await tx.update(sessions_table).set({ revoked_at: new Date() }).where(and(eq(sessions_table.family_id, family_id), isNull(sessions_table.revoked_at)));
		await tx.delete(track_downloads_table).where(eq(track_downloads_table.session_family_id, family_id));
	});
}

export async function revoke_all_for_user(user_id: string) {
	await db.transaction(async (tx) => {
		await tx.update(sessions_table).set({ revoked_at: new Date() }).where(and(eq(sessions_table.user_id, user_id), isNull(sessions_table.revoked_at)));
		await tx.delete(track_downloads_table).where(eq(track_downloads_table.user_id, user_id));
	});
}

/** A session family is live while it has an unrevoked, unexpired row. Used to invalidate action tokens. */
export async function is_session_live(ex: Executor, family_id: string): Promise<boolean> {
	const [row] = await ex.select({ id: sessions_table.id }).from(sessions_table).where(and(
		eq(sessions_table.family_id, family_id),
		isNull(sessions_table.revoked_at),
		gt(sessions_table.expires_at, new Date())
	)).limit(1);
	return !!row;
}
