import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../../db';
import { users_table } from '../../db/schema';
import { HttpError } from '../http';
import { verify_access_token } from './tokens';

/** Requires `Authorization: Bearer <access token>` and sets `req.user`. */
export async function require_auth(req: Request, _res: Response, next: NextFunction) {
	const header = req.headers.authorization;
	const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
	if (!token) throw new HttpError(401, 'missing access token');
	const user = await verify_access_token(token);
	if (!user) throw new HttpError(401, 'invalid or expired access token');
	req.user = user;
	next();
}

/** Admin endpoints re-check the role in the database, not only the JWT claim. */
export async function require_admin(req: Request, _res: Response, next: NextFunction) {
	if (!req.user) throw new HttpError(401, 'unauthenticated');
	const [row] = await db.select({ role: users_table.role }).from(users_table).where(eq(users_table.id, req.user.id));
	if (row?.role !== 'ADMIN') throw new HttpError(403, 'admin only');
	req.user.role = 'ADMIN';
	next();
}
