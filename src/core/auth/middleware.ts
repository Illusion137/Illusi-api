import { eq, sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../../db';
import { users_table } from '../../db/schema';
import { current_context } from '../context';
import { on } from '../events';
import { HttpError } from '../http';
import { verify_access_token } from './tokens';

/** How long a user known to exist is trusted without asking the database again. Deletion clears it at once. */
const USER_EXISTS_TTL_MS = 60_000;
const MAX_KNOWN_USERS = 50_000;
const known_users = new Map<string, number>();

on('user_deleted', ({ user_id }) => { known_users.delete(user_id); });
// Emitted on every event-bridge (re)connect too, when a deletion notice may have been missed.
on('ids_redirected', () => { known_users.clear(); });

/** Access tokens are stateless, so a deleted account's tokens would otherwise keep working until they expire. */
async function user_status(user_id: string): Promise<{ verified: boolean } | null> {
	const checked = known_users.get(user_id);
	if (checked !== undefined && Date.now() - checked < USER_EXISTS_TTL_MS) return { verified: true };
	const [row] = await db.select({ verified: sql<boolean>`${users_table.email_verified_at} is not null` }).from(users_table).where(eq(users_table.id, user_id));
	if (!row) {
		known_users.delete(user_id);
		return null;
	}
	// Only verified users are remembered, so a fresh confirmation takes effect on the next request.
	if (row.verified) {
		if (known_users.size >= MAX_KNOWN_USERS) known_users.clear();
		known_users.set(user_id, Date.now());
	}
	return row;
}

/** Forgets a user immediately in this process (the deletion broadcast covers the others). */
export function forget_user(user_id: string) {
	known_users.delete(user_id);
}

/** Requires `Authorization: Bearer <access token>` and sets `req.user`. */
export async function require_auth(req: Request, _res: Response, next: NextFunction) {
	const header = req.headers.authorization;
	const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
	if (!token) throw new HttpError(401, 'missing access token');
	const user = await verify_access_token(token);
	const status = user ? await user_status(user.id) : null;
	if (!user || !status) throw new HttpError(401, 'invalid or expired access token');
	req.user = user;
	req.email_verified = status.verified;
	next();
}

/** Everything outside `/auth` needs a confirmed email address. Runs after `require_auth`. */
export function require_verified(req: Request, _res: Response, next: NextFunction) {
	if (!req.email_verified) throw new HttpError(403, 'email not verified', { code: 'EMAIL_NOT_VERIFIED' });
	next();
}

/** Admin endpoints re-check the role in the database, not only the JWT claim. */
export async function require_admin(req: Request, _res: Response, next: NextFunction) {
	if (!req.user) throw new HttpError(401, 'unauthenticated');
	const [row] = await db.select({ role: users_table.role }).from(users_table).where(eq(users_table.id, req.user.id));
	if (row?.role !== 'ADMIN') throw new HttpError(403, 'admin only');
	req.user.role = 'ADMIN';
	// Admin tools work across users, so the rest of the request runs as the table owner.
	const context = current_context();
	if (context) context.privileged = true;
	next();
}
