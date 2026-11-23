import { eq } from 'drizzle-orm';
import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { db } from '../db';
import { users_table } from '../db/schema';
import { require_auth } from '../core/auth/middleware';
import { send_email_change_notice, send_verification_email, verify_email } from '../core/auth/email_verification';
import { abandoned_unverified_account, consume_reset_code, send_password_reset } from '../core/auth/password_reset';
import { create_session, revoke_all_for_user, revoke_by_refresh_token, revoke_family, revoke_other_sessions, rotate_refresh_token } from '../core/auth/sessions';
import { verify_access_token } from '../core/auth/tokens';
import { as_owner } from '../core/context';
import { HttpError, json_body, parse_body, require_user } from '../core/http';
import { ip_prefix } from '../core/ip';
import { logger } from '../core/log';
import { RateLimiter, rate_limit_user } from '../core/rate_limit';

const log = logger('auth');

export const auth_router = Router();
auth_router.use(json_body('16kb'));

const ip_limiter = new RateLimiter(30, 15 * 60_000);
/** Per (email, ip): someone guessing from one network can't lock the owner out from theirs. */
const email_ip_limiter = new RateLimiter(10, 15 * 60_000);
/** Per email from anywhere: a ceiling on distributed guessing, far above what one person ever needs. */
const email_limiter = new RateLimiter(100, 15 * 60_000);

/** Failed logins per email get progressively slower (capped, so a stranger's failures delay but never lock out). */
const failures = new Map<string, { count: number; last: number }>();
const FAILURE_RESET_MS = 30 * 60_000;
const MAX_TRACKED_FAILURES = 100_000;
setInterval(() => {
	const now = Date.now();
	for (const [email, f] of failures) if (now - f.last > FAILURE_RESET_MS) failures.delete(email);
}, FAILURE_RESET_MS).unref();

function failure_delay_ms(email: string): number {
	const f = failures.get(email);
	if (!f || Date.now() - f.last > FAILURE_RESET_MS) return 0;
	return Math.min(250 * 2 ** (f.count - 1), 8_000);
}

function record_failure(email: string) {
	const f = failures.get(email);
	if (!f && failures.size >= MAX_TRACKED_FAILURES) failures.delete(failures.keys().next().value!);
	failures.set(email, { count: f && Date.now() - f.last <= FAILURE_RESET_MS ? f.count + 1 : 1, last: Date.now() });
}

async function limit(ip: string | undefined, email: string) {
	const ok = await ip_limiter.hit(`auth_ip:${ip}`) && await email_ip_limiter.hit(`auth_email_ip:${email}:${ip}`) && await email_limiter.hit(`auth_email:${email}`);
	if (!ok) throw new HttpError(429, 'too many attempts');
}

const email_schema = z.email().max(256).transform(e => e.toLowerCase());
const password_schema = z.string().min(8).max(1024);

const register_schema = z.object({
	username: z.string().trim().min(1).max(64),
	email: email_schema,
	password: password_schema
});

auth_router.post('/register', async (req, res) => {
	const body = parse_body(register_schema, req.body);
	await limit(req.ip, body.email);
	const password_hash = await argon2.hash(body.password, { type: argon2.argon2id });
	const values = { username: body.username, email: body.email, password_hash, signup_ip_prefix: ip_prefix(req.ip) };
	const insert = async () => (await db.insert(users_table).values(values)
		.onConflictDoNothing({ target: users_table.email })
		.returning({ id: users_table.id, role: users_table.role }))[0];
	let user = await insert();
	if (!user) {
		// An address held by an abandoned, never-verified signup is free again.
		const abandoned = await abandoned_unverified_account(body.email);
		if (abandoned) {
			await db.delete(users_table).where(eq(users_table.id, abandoned));
			log.info('replaced an abandoned unverified account', { user_id: abandoned });
			user = await insert();
		}
	}
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
	await limit(req.ip, body.email);
	const delay = failure_delay_ms(body.email);
	if (delay > 0) await new Promise(r => setTimeout(r, delay));

	const [user] = await db.select().from(users_table).where(eq(users_table.email, body.email));
	const ok = user ? await argon2.verify(user.password_hash, body.password) : false;
	if (!user || !ok) {
		record_failure(body.email);
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

/**
 * Ends this login. With a valid access token it ends that token's login; otherwise `refresh_token` names it, so a
 * device that logged out offline (and dropped its access token) can still end the login later. Always 204.
 */
auth_router.post('/logout', async (req, res) => {
	const header = req.headers.authorization;
	const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
	const access = bearer ? await verify_access_token(bearer) : null;
	const body = parse_body(z.object({ refresh_token: z.string().min(1).max(256).optional() }), req.body ?? {});
	if (access) await revoke_family(access.sid);
	else if (body.refresh_token) await revoke_by_refresh_token(body.refresh_token);
	else throw new HttpError(401, bearer ? 'invalid or expired access token' : 'missing access token');
	res.status(204).end();
});

auth_router.post('/logout_all', require_auth, async (req, res) => {
	await revoke_all_for_user(require_user(req).id);
	res.status(204).end();
});

auth_router.get('/me', require_auth, async (req, res) => {
	const user = require_user(req);
	const [row] = await db.select({ email: users_table.email, username: users_table.username, avatar_id: users_table.avatar_id, public_imports: users_table.public_imports }).from(users_table).where(eq(users_table.id, user.id));
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

/** Emails a 6-digit reset code when the address has an account. Always 204, so it doesn't reveal which addresses do. */
auth_router.post('/forgot_password', async (req, res) => {
	const { email } = parse_body(z.object({ email: email_schema }), req.body);
	await limit(req.ip, email);
	const [user] = await db.select({ id: users_table.id, email: users_table.email, username: users_table.username }).from(users_table).where(eq(users_table.email, email));
	if (user) send_password_reset(user).catch((err: unknown) => log.error('password reset email failed', err));
	res.status(204).end();
});

const reset_schema = z.object({
	email: email_schema,
	code: z.string().trim().regex(/^\d{6}$/u),
	password: password_schema,
	device_name: z.string().max(128).optional()
});

/**
 * Sets a new password with an emailed code, ends every login, and signs this device in. The code proves the address,
 * so an unverified account becomes verified too.
 */
auth_router.post('/reset_password', async (req, res) => {
	const body = parse_body(reset_schema, req.body);
	await limit(req.ip, body.email);
	const [user] = await db.select({ id: users_table.id, role: users_table.role }).from(users_table).where(eq(users_table.email, body.email));
	if (!user || !(await consume_reset_code(user.id, body.code))) throw new HttpError(400, 'invalid or expired code', { code: 'INVALID_RESET_CODE' });
	const password_hash = await argon2.hash(body.password, { type: argon2.argon2id });
	await db.update(users_table).set({ password_hash, email_verified_at: new Date() }).where(eq(users_table.id, user.id));
	await revoke_all_for_user(user.id);
	failures.delete(body.email);
	log.info('password reset', { user_id: user.id });
	res.json({ ...await create_session(user, body.device_name), email_verified: true });
});

const change_password_schema = z.object({ current_password: z.string().max(1024), new_password: password_schema });

/** Changes the password and ends every other login; this device stays signed in. */
auth_router.post('/change_password', require_auth, rate_limit_user('change_password', 10, 15 * 60_000), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(change_password_schema, req.body);
	const [row] = await db.select({ password_hash: users_table.password_hash }).from(users_table).where(eq(users_table.id, user.id));
	if (!row) throw new HttpError(401, 'invalid or expired access token');
	if (!(await argon2.verify(row.password_hash, body.current_password))) throw new HttpError(403, 'wrong password', { code: 'WRONG_PASSWORD' });
	const password_hash = await argon2.hash(body.new_password, { type: argon2.argon2id });
	await db.update(users_table).set({ password_hash }).where(eq(users_table.id, user.id));
	await revoke_other_sessions(user.id, user.sid);
	res.status(204).end();
});

const change_email_schema = z.object({ password: z.string().max(1024), email: email_schema });

/**
 * Starts an email change: the new address gets a confirmation link and becomes the account email once it's
 * followed. Until then the old address stays (and is told about the request).
 */
auth_router.post('/change_email', require_auth, rate_limit_user('change_email', 5, 60 * 60_000), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(change_email_schema, req.body);
	const [row] = await db.select({ email: users_table.email, username: users_table.username, password_hash: users_table.password_hash }).from(users_table).where(eq(users_table.id, user.id));
	if (!row) throw new HttpError(401, 'invalid or expired access token');
	if (!(await argon2.verify(row.password_hash, body.password))) throw new HttpError(403, 'wrong password', { code: 'WRONG_PASSWORD' });
	if (body.email === row.email) throw new HttpError(409, 'that is already your email');
	// Other accounts are invisible under row-level security.
	const [taken] = await as_owner(async () => db.select({ id: users_table.id }).from(users_table).where(eq(users_table.email, body.email)));
	if (taken) throw new HttpError(409, 'email already registered', { code: 'EMAIL_TAKEN' });
	await send_verification_email({ id: user.id, email: body.email, username: row.username });
	if (req.email_verified) send_email_change_notice(row, body.email).catch((err: unknown) => log.error('email change notice failed', err));
	res.status(202).json({ pending_email: body.email });
});
