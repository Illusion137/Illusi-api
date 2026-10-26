import { eq } from 'drizzle-orm';
import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { db } from '../db';
import { users_table } from '../db/schema';
import { require_auth } from '../core/auth/middleware';
import { create_session, revoke_all_for_user, revoke_family, rotate_refresh_token } from '../core/auth/sessions';
import { HttpError, json_body, parse_body, require_user } from '../core/http';
import { RateLimiter } from '../core/rate_limit';

export const auth_router = Router();
auth_router.use(json_body('16kb'));

const ip_limiter = new RateLimiter(30, 15 * 60_000);
const email_limiter = new RateLimiter(10, 15 * 60_000);

/** Failed logins per email get progressively slower. */
const failures = new Map<string, { count: number; last: number }>();
const FAILURE_RESET_MS = 30 * 60_000;

function failure_delay_ms(email: string): number {
	const f = failures.get(email);
	if (!f || Date.now() - f.last > FAILURE_RESET_MS) return 0;
	return Math.min(250 * 2 ** (f.count - 1), 8_000);
}

function limit(ip: string | undefined, email: string) {
	if (!ip_limiter.hit(`ip:${ip}`) || !email_limiter.hit(`email:${email}`)) throw new HttpError(429, 'too many attempts');
}

const register_schema = z.object({
	username: z.string().trim().min(1).max(64),
	email: z.email().max(256).transform(e => e.toLowerCase()),
	password: z.string().min(8).max(1024)
});

auth_router.post('/register', async (req, res) => {
	const body = parse_body(register_schema, req.body);
	limit(req.ip, body.email);
	const password_hash = await argon2.hash(body.password, { type: argon2.argon2id });
	const [user] = await db.insert(users_table).values({ username: body.username, email: body.email, password_hash })
		.onConflictDoNothing({ target: users_table.email })
		.returning({ id: users_table.id, role: users_table.role });
	if (!user) throw new HttpError(409, 'email already registered');
	res.status(201).json(await create_session(user, null));
});

const login_schema = z.object({
	email: z.email().transform(e => e.toLowerCase()),
	password: z.string().max(1024),
	device_name: z.string().max(128).optional()
});

auth_router.post('/login', async (req, res) => {
	const body = parse_body(login_schema, req.body);
	limit(req.ip, body.email);
	const delay = failure_delay_ms(body.email);
	if (delay > 0) await new Promise(r => setTimeout(r, delay));

	const [user] = await db.select().from(users_table).where(eq(users_table.email, body.email));
	const ok = user ? await argon2.verify(user.password_hash, body.password) : false;
	if (!user || !ok) {
		const f = failures.get(body.email);
		failures.set(body.email, { count: f && Date.now() - f.last <= FAILURE_RESET_MS ? f.count + 1 : 1, last: Date.now() });
		throw new HttpError(401, 'invalid email or password');
	}
	failures.delete(body.email);
	res.json(await create_session(user, body.device_name));
});

auth_router.post('/refresh', async (req, res) => {
	const { refresh_token } = parse_body(z.object({ refresh_token: z.string().min(1).max(256) }), req.body);
	const result = await rotate_refresh_token(refresh_token);
	if (!result.ok) throw new HttpError(401, `refresh token ${result.reason}`);
	res.json(result.tokens);
});

auth_router.post('/logout', require_auth, async (req, res) => {
	await revoke_family(require_user(req).sid);
	res.status(204).end();
});

auth_router.post('/logout_all', require_auth, async (req, res) => {
	await revoke_all_for_user(require_user(req).id);
	res.status(204).end();
});
