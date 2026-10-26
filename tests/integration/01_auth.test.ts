import { describe, expect, it } from 'vitest';
import { api, create_user, fresh_ip, query, unique } from './helpers';

describe('health', () => {
	it('reports ready with a live database', async () => {
		const res = await api('GET', '/health', { root: true });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, status: 'ok', checks: { database: { ok: true } } });
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect((await api('GET', '/health/live', { root: true })).body).toEqual({ ok: true });
	});

	it('protects everything else and 404s unknown routes', async () => {
		expect((await api('POST', '/sync/pull', { body: {} })).status).toBe(401);
		expect((await api('GET', '/new-releases', { token: 'not-a-jwt' })).status).toBe(401);
		const user = await create_user();
		expect((await api('GET', '/no-such-route', { token: user.access_token })).status).toBe(404);
		// The old unversioned paths are gone, and nothing outside the prefix needs a token to 404.
		expect((await api('POST', '/sync/pull', { root: true, token: user.access_token, body: {} })).status).toBe(404);
		expect((await api('GET', '/api/v2/new-releases', { root: true, token: user.access_token })).status).toBe(404);
	});
});

describe('auth (§12)', () => {
	it('registers, rejects duplicate emails (case-insensitively) and bad input', async () => {
		const user = await create_user('alice');
		const dup = await api('POST', '/auth/register', { ip: fresh_ip(), body: { username: 'x', email: user.email.toUpperCase(), password: 'longenough' } });
		expect(dup.status).toBe(409);
		const short = await api('POST', '/auth/register', { ip: fresh_ip(), body: { username: 'x', email: `${unique('y')}@example.test`, password: 'short' } });
		expect(short.status).toBe(400);
		const bad_email = await api('POST', '/auth/register', { ip: fresh_ip(), body: { username: 'x', email: 'nope', password: 'longenough' } });
		expect(bad_email.status).toBe(400);
	});

	it('logs in, and rejects a wrong password', async () => {
		const user = await create_user('bob');
		const ok = await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password, device_name: 'phone' } });
		expect(ok.status).toBe(200);
		expect(ok.body).toEqual({ access_token: expect.any(String), refresh_token: expect.any(String) });
		const wrong = await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: 'wrong-password' } });
		expect(wrong.status).toBe(401);
		const unknown = await api('POST', '/auth/login', { ip: user.ip, body: { email: `${unique('ghost')}@example.test`, password: 'whatever1' } });
		expect(unknown.status).toBe(401);
	});

	it('rotates refresh tokens and revokes the family when an old one is reused', async () => {
		const user = await create_user('carol');
		const first = await api('POST', '/auth/refresh', { body: { refresh_token: user.refresh_token } });
		expect(first.status).toBe(200);
		expect(first.body.refresh_token).not.toBe(user.refresh_token);

		// Reusing the rotated-out token is theft detection: the whole family dies, including the new token.
		const reuse = await api('POST', '/auth/refresh', { body: { refresh_token: user.refresh_token } });
		expect(reuse.status).toBe(401);
		const after = await api('POST', '/auth/refresh', { body: { refresh_token: first.body.refresh_token } });
		expect(after.status).toBe(401);
	});

	// Access tokens are stateless ~15 min JWTs: logout revokes the refresh side of a session, and
	// every action token bound to it (sid), but an already-issued access token lives until it expires.
	it('logout revokes one session, logout_all revokes every session', async () => {
		const user = await create_user('dave');
		const second = (await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password } })).body;
		const third = (await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password } })).body;

		expect((await api('POST', '/auth/logout', { token: user.access_token })).status).toBe(204);
		expect((await api('POST', '/auth/refresh', { body: { refresh_token: user.refresh_token } })).status).toBe(401);
		expect((await api('POST', '/auth/refresh', { body: { refresh_token: second.refresh_token } })).status).toBe(200);

		expect((await api('POST', '/auth/logout_all', { token: third.access_token })).status).toBe(204);
		expect((await api('POST', '/auth/refresh', { body: { refresh_token: third.refresh_token } })).status).toBe(401);
		const sessions = await query(`select count(*)::int as live from sessions_table where user_id = $1 and revoked_at is null`, [user.id]);
		expect(sessions[0].live).toBe(0);
	});

	it('rate limits auth attempts per client address', async () => {
		const ip = fresh_ip();
		const statuses: number[] = [];
		for (let i = 0; i < 32; i++) {
			const res = await api('POST', '/auth/login', { ip, body: { email: `${unique('rl')}@example.test`, password: 'whatever1' } });
			statuses.push(res.status);
		}
		expect(statuses.slice(0, 30).every(s => s === 401)).toBe(true);
		expect(statuses.slice(30)).toEqual([429, 429]);
		// Another address is unaffected.
		const other = await api('POST', '/auth/login', { ip: fresh_ip(), body: { email: `${unique('rl')}@example.test`, password: 'whatever1' } });
		expect(other.status).toBe(401);
	});
});
