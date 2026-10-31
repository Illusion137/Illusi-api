import { describe, expect, it } from 'vitest';
import { api, create_user, fresh_ip, unique, uuid } from './helpers';

const expect_error = (res: { status: number; body: any }, status: number, message?: string) => {
	expect(res.status).toBe(status);
	expect(typeof res.body.error).toBe('string');
	if (message) expect(res.body.error).toBe(message);
};

describe('auth validation', () => {
	it('rejects malformed registrations with issues', async () => {
		const ip = fresh_ip();
		const good = { username: 'u', email: `${unique('v')}@example.test`, password: 'longenough' };
		for (const bad of [
			{}, { ...good, email: 'not-an-email' }, { ...good, password: 'short' }, { ...good, username: '   ' },
			{ ...good, username: 'x'.repeat(65) }, { ...good, password: 'x'.repeat(1025) }, { ...good, email: `${'a'.repeat(250)}@example.test` },
			{ ...good, email: 123 }
		]) {
			const res = await api('POST', '/auth/register', { ip, body: bad });
			expect_error(res, 400, 'invalid body');
			expect(Array.isArray(res.body.issues)).toBe(true);
		}
	});

	it('rejects a missing, null or array register body', async () => {
		const ip = fresh_ip();
		expect_error(await api('POST', '/auth/register', { ip }), 400, 'invalid body');
		expect_error(await api('POST', '/auth/register', { ip, headers: { 'content-type': 'application/json' }, raw: 'null' }), 400);
		expect_error(await api('POST', '/auth/register', { ip, headers: { 'content-type': 'application/json' }, raw: '[]' }), 400, 'invalid body');
	});

	it('answers malformed json with a 400 error body', async () => {
		const res = await api('POST', '/auth/login', { ip: fresh_ip(), headers: { 'content-type': 'application/json' }, raw: '{"email":' });
		expect_error(res, 400);
	});

	it('answers an oversize body with 413', async () => {
		const res = await api('POST', '/auth/register', { ip: fresh_ip(), body: { username: 'big', email: 'a@example.test', password: 'x'.repeat(20_000) } });
		expect_error(res, 413);
	});

	it('lowercases emails, so a differently cased registration conflicts', async () => {
		const user = await create_user('case');
		const res = await api('POST', '/auth/register', { ip: fresh_ip(), body: { username: 'dup', email: user.email.toUpperCase(), password: 'longenough' } });
		expect_error(res, 409, 'email already registered');
		const login = await api('POST', '/auth/login', { ip: fresh_ip(), body: { email: user.email.toUpperCase(), password: user.password } });
		expect(login.status).toBe(200);
	});

	it('trims the username', async () => {
		const ip = fresh_ip();
		const res = await api('POST', '/auth/register', { ip, body: { username: '  padded  ', email: `${unique('trim')}@example.test`, password: 'longenough' } });
		expect(res.status).toBe(201);
		expect(res.body.email_verified).toBe(false);
	});

	it('rejects malformed logins and answers wrong credentials identically', async () => {
		const user = await create_user('login');
		const ip = fresh_ip();
		expect_error(await api('POST', '/auth/login', { ip, body: {} }), 400, 'invalid body');
		expect_error(await api('POST', '/auth/login', { ip, body: { email: 'nope', password: 'x' } }), 400, 'invalid body');
		expect_error(await api('POST', '/auth/login', { ip, body: { email: user.email, password: 'x'.repeat(1025) } }), 400, 'invalid body');
		expect_error(await api('POST', '/auth/login', { ip, body: { email: user.email, password: 'x', device_name: 'd'.repeat(129) } }), 400, 'invalid body');
		const wrong_pw = await api('POST', '/auth/login', { ip, body: { email: user.email, password: 'wrong-password' } });
		const unknown = await api('POST', '/auth/login', { ip, body: { email: `${unique('ghost')}@example.test`, password: 'wrong-password' } });
		expect_error(wrong_pw, 401, 'invalid email or password');
		expect(unknown.body).toEqual(wrong_pw.body);
	});

	it('accepts a device name on login', async () => {
		const user = await create_user('device');
		const res = await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password, device_name: 'Pixel' } });
		expect(res.status).toBe(200);
		expect(res.body.email_verified).toBe(true);
		expect(typeof res.body.access_token).toBe('string');
		expect(typeof res.body.refresh_token).toBe('string');
	});

	it('rejects refresh without a token, with a bad type, oversize and unknown tokens', async () => {
		const ip = fresh_ip();
		expect_error(await api('POST', '/auth/refresh', { ip, body: {} }), 400, 'invalid body');
		expect_error(await api('POST', '/auth/refresh', { ip, body: { refresh_token: 5 } }), 400, 'invalid body');
		expect_error(await api('POST', '/auth/refresh', { ip, body: { refresh_token: '' } }), 400, 'invalid body');
		expect_error(await api('POST', '/auth/refresh', { ip, body: { refresh_token: 'x'.repeat(257) } }), 400, 'invalid body');
		const unknown = await api('POST', '/auth/refresh', { ip, body: { refresh_token: 'x'.repeat(64) } });
		expect(unknown.status).toBe(401);
		expect(unknown.body.error).toMatch(/^refresh token /u);
	});

	it('requires a bearer token on logout and logout_all', async () => {
		for (const path of ['/auth/logout', '/auth/logout_all']) {
			expect_error(await api('POST', path), 401, 'missing access token');
			expect_error(await api('POST', path, { headers: { authorization: 'Basic abc' } }), 401, 'missing access token');
			expect_error(await api('POST', path, { token: 'garbage' }), 401, 'invalid or expired access token');
		}
	});

	it('logs out one session without ending the others', async () => {
		const user = await create_user('sessions');
		const second = await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password } });
		const out = await api('POST', '/auth/logout', { token: second.body.access_token });
		expect(out.status).toBe(204);
		expect(out.text).toBe('');
		expect((await api('POST', '/auth/refresh', { ip: user.ip, body: { refresh_token: second.body.refresh_token } })).status).toBe(401);
		expect((await api('POST', '/auth/refresh', { ip: user.ip, body: { refresh_token: user.refresh_token } })).status).toBe(200);
	});

	it('revokes every session on logout_all', async () => {
		const user = await create_user('logout-all');
		const second = await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password } });
		expect((await api('POST', '/auth/logout_all', { token: user.access_token })).status).toBe(204);
		for (const token of [user.refresh_token, second.body.refresh_token]) {
			expect((await api('POST', '/auth/refresh', { ip: user.ip, body: { refresh_token: token } })).status).toBe(401);
		}
	});

	it('limits attempts per ip with 429', async () => {
		const ip = fresh_ip();
		const statuses: number[] = [];
		for (let i = 0; i < 32; i++) {
			statuses.push((await api('POST', '/auth/login', { ip, body: { email: `${unique('rl')}@example.test`, password: 'whatever1' } })).status);
		}
		expect(statuses.slice(0, 30).every(s => s === 401)).toBe(true);
		expect(statuses.slice(30)).toEqual([429, 429]);
		const limited = await api('POST', '/auth/login', { ip, body: { email: `${unique('rl')}@example.test`, password: 'whatever1' } });
		expect_error(limited, 429, 'too many attempts');
		expect((await api('POST', '/auth/login', { ip: fresh_ip(), body: { email: `${unique('rl')}@example.test`, password: 'whatever1' } })).status).toBe(401);
	}, 60_000);

	it('answers unknown routes with a 404 error body', async () => {
		const res = await api('GET', '/nope', { token: (await create_user('nf')).access_token });
		expect_error(res, 404);
		expect_error(await api('GET', `/${uuid()}`, { root: true }), 404, 'not found');
	});
});
