import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { api, create_user, eventually, query, uuid } from './helpers';
import type { TestUser } from './helpers';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function issue_link(user: TestUser, opts: { expires_in_ms?: number; email?: string } = {}): Promise<string> {
	const token = randomBytes(32).toString('base64url');
	await query(
		'insert into email_verifications_table (user_id, email, token_hash, expires_at) values ($1, $2, $3, $4)',
		[user.id, opts.email ?? user.email, sha256(token), new Date(Date.now() + (opts.expires_in_ms ?? 3_600_000))]
	);
	return token;
}

describe('email verification', () => {
	it('lets an unverified user sign in but only reach /auth', async () => {
		const user = await create_user('fresh', { verified: false });
		const login = await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password } });
		expect(login.status).toBe(200);
		expect(login.body.email_verified).toBe(false);

		const me = await api('GET', '/auth/me', { token: login.body.access_token });
		expect(me.body).toMatchObject({ id: user.id, email: user.email, email_verified: false });

		const blocked = await api('GET', '/me/exports', { token: login.body.access_token });
		expect(blocked.status).toBe(403);
		expect(blocked.body).toEqual({ error: 'email not verified', code: 'EMAIL_NOT_VERIFIED' });
		expect((await api('POST', '/sync/pull', { token: login.body.access_token, body: {} })).status).toBe(403);
		expect((await api('GET', '/admin/review', { token: login.body.access_token })).status).toBe(403);
		expect((await api('POST', '/auth/logout', { token: login.body.access_token })).status).toBe(204);
	});

	it('registration stores a hashed, single-use link for the account email', async () => {
		const user = await create_user('hashed', { verified: false });
		const rows = await eventually(async () => {
			const found = await query('select email, token_hash, used_at, expires_at from email_verifications_table where user_id = $1', [user.id]);
			expect(found).toHaveLength(1);
			return found;
		});
		expect(rows[0].email).toBe(user.email);
		expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/u);
		expect(rows[0].used_at).toBeNull();
		expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
	});

	it('confirms the address from the emailed link and unblocks the next request', async () => {
		const user = await create_user('confirm', { verified: false });
		const token = await issue_link(user);
		const page = await api('GET', `/auth/verify_email?token=${token}`);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toContain('text/html');
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(page.headers.get('referrer-policy')).toBe('no-referrer');
		expect(page.text).toContain('Email confirmed');

		expect((await api('GET', '/me/exports', { token: user.access_token })).status).toBe(200);
		expect((await api('GET', '/auth/me', { token: user.access_token })).body.email_verified).toBe(true);
		expect((await query('select email_verified_at from users_table where id = $1', [user.id]))[0].email_verified_at).not.toBeNull();
	});

	it('confirms through the JSON endpoint too, and a link works once', async () => {
		const user = await create_user('json', { verified: false });
		const token = await issue_link(user);
		expect((await api('POST', '/auth/verify_email', { body: { token } })).status).toBe(204);
		const again = await api('POST', '/auth/verify_email', { body: { token } });
		expect(again.status).toBe(400);
		expect(again.body).toEqual({ error: 'invalid or expired token' });
		expect((await api('GET', `/auth/verify_email?token=${token}`)).status).toBe(400);
	});

	it('rejects unknown, expired, empty and oversized tokens', async () => {
		const user = await create_user('badlink', { verified: false });
		const expired = await issue_link(user, { expires_in_ms: -1000 });
		for (const token of [expired, randomBytes(32).toString('base64url')]) {
			const page = await api('GET', `/auth/verify_email?token=${token}`);
			expect(page.status).toBe(400);
			expect(page.text).toContain('Link expired');
		}
		expect((await api('GET', '/auth/verify_email')).status).toBe(400);
		expect((await api('GET', `/auth/verify_email?token=${'a'.repeat(129)}`)).status).toBe(400);
		expect((await api('POST', '/auth/verify_email', { body: {} })).status).toBe(400);
		expect((await query('select email_verified_at from users_table where id = $1', [user.id]))[0].email_verified_at).toBeNull();
	});

	it('does not verify an address the account no longer has', async () => {
		const user = await create_user('moved', { verified: false });
		const token = await issue_link(user, { email: `${uuid()}@example.test` });
		expect((await api('POST', '/auth/verify_email', { body: { token } })).status).toBe(400);
		expect((await query('select email_verified_at from users_table where id = $1', [user.id]))[0].email_verified_at).toBeNull();
	});

	it('resends a fresh link, replacing the pending one, and limits how often', async () => {
		const user = await create_user('resend', { verified: false });
		const [first] = await eventually(async () => {
			const found = await query('select id from email_verifications_table where user_id = $1', [user.id]);
			expect(found).toHaveLength(1);
			return found;
		});
		expect((await api('POST', '/auth/resend_verification', { token: user.access_token })).status).toBe(204);
		const rows = await query('select id from email_verifications_table where user_id = $1 and used_at is null', [user.id]);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).not.toBe(first.id);

		await api('POST', '/auth/resend_verification', { token: user.access_token });
		await api('POST', '/auth/resend_verification', { token: user.access_token });
		expect((await api('POST', '/auth/resend_verification', { token: user.access_token })).status).toBe(429);
	});

	it('resending for a verified account sends nothing', async () => {
		const user = await create_user('done');
		expect((await api('POST', '/auth/resend_verification', { token: user.access_token })).status).toBe(204);
		expect(await query('select 1 from email_verifications_table where user_id = $1', [user.id])).toHaveLength(1);
		expect((await api('POST', '/auth/resend_verification')).status).toBe(401);
		expect((await api('GET', '/auth/me')).status).toBe(401);
	});
});
