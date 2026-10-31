import { eq } from 'drizzle-orm';
import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { db } from '../db';
import { users_table } from '../db/schema';
import { require_auth } from '../core/auth/middleware';
import { send_verification_email, verify_email } from '../core/auth/email_verification';
import { create_session, revoke_all_for_user, revoke_family, rotate_refresh_token } from '../core/auth/sessions';
import { HttpError, json_body, parse_body, require_user } from '../core/http';
import { logger } from '../core/log';
import { RateLimiter, rate_limit_user } from '../core/rate_limit';

const log = logger('auth');

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
	send_verification_email({ id: user.id, email: body.email, username: body.username })
		.catch((err: unknown) => log.error('verification email failed', err));
	res.status(201).json({ ...await create_session(user, null), email_verified: false });
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
	res.json({ ...await create_session(user, body.device_name), email_verified: user.email_verified_at !== null });
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

auth_router.get('/me', require_auth, async (req, res) => {
	const user = require_user(req);
	const [row] = await db.select({ email: users_table.email, username: users_table.username }).from(users_table).where(eq(users_table.id, user.id));
	if (!row) throw new HttpError(401, 'invalid or expired access token');
	res.json({ id: user.id, ...row, email_verified: req.email_verified === true });
});

auth_router.post('/resend_verification', require_auth, rate_limit_user('resend_verification', 3, 60 * 60_000), async (req, res) => {
	const user = require_user(req);
	if (!req.email_verified) {
		const [row] = await db.select({ email: users_table.email, username: users_table.username }).from(users_table).where(eq(users_table.id, user.id));
		if (row) await send_verification_email({ id: user.id, ...row });
	}
	res.status(204).end();
});

const verify_page = (title: string, message: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:20vh auto;padding:0 1rem;text-align:center}</style></head><body><h1>${title}</h1><p>${message}</p></body></html>`;

/** The link in the confirmation email. */
auth_router.get('/verify_email', async (req, res) => {
	const token = typeof req.query.token === 'string' ? req.query.token : '';
	const ok = token.length > 0 && token.length <= 128 && await verify_email(token);
	res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
	if (ok) res.type('html').send(verify_page('Email confirmed', 'Thanks! You can go back to the app.'));
	else res.status(400).type('html').send(verify_page('Link expired', 'This confirmation link is invalid or has expired. Request a new one from the app.'));
});

auth_router.post('/verify_email', async (req, res) => {
	const { token } = parse_body(z.object({ token: z.string().min(1).max(128) }), req.body);
	if (!await verify_email(token)) throw new HttpError(400, 'invalid or expired token');
	res.status(204).end();
});
