import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
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

/** Rotation with reuse detection: presenting an already-rotated token revokes the whole chain. */
export async function rotate_refresh_token(refresh_token: string): Promise<RefreshResult> {
	const token_hash = hash_token(refresh_token);
	return db.transaction(async (tx) => {
		const [row] = await tx.select().from(sessions_table).where(eq(sessions_table.token_hash, token_hash)).for('update');
		if (!row) return { ok: false, reason: 'unknown' } as const;
		if (row.revoked_at) {
			if (row.replaced_by) {
				await tx.update(sessions_table).set({ revoked_at: new Date() })
					.where(and(eq(sessions_table.family_id, row.family_id), isNull(sessions_table.revoked_at)));
				await tx.delete(track_downloads_table).where(eq(track_downloads_table.session_family_id, row.family_id));
				log.warn(`refresh token reuse detected; revoked session family ${row.family_id}`, { user_id: row.user_id });
				return { ok: false, reason: 'reused' } as const;
			}
			return { ok: false, reason: 'revoked' } as const;
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
		await tx.update(sessions_table).set({ revoked_at: now, replaced_by: next_id, last_used_at: now }).where(eq(sessions_table.id, row.id));
		return { ok: true, tokens: { access_token: await sign_access_token({ id: user.id, role: user.role, sid: row.family_id }), refresh_token: next_token } } as const;
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
