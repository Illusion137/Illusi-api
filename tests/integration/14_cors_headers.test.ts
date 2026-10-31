import { describe, expect, it } from 'vitest';
import { api, create_user } from './helpers';

const preflight = (origin: string, extra: Record<string, string> = {}) => api('OPTIONS', '/sync/pull', {
	headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type', ...extra }
});

describe('CORS', () => {
	it('answers preflight for sumii.me and its subdomains', async () => {
		for (const origin of ['https://sumii.me', 'https://app.sumii.me', 'https://a.b.sumii.me']) {
			const res = await preflight(origin);
			expect(res.status, origin).toBe(204);
			expect(res.headers.get('access-control-allow-origin')).toBe(origin);
			expect(res.headers.get('access-control-allow-methods')).toContain('POST');
			expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
			expect(res.headers.get('access-control-max-age')).toBe('600');
			expect(res.headers.get('vary')).toContain('Origin');
			expect(res.headers.get('access-control-allow-credentials')).toBeNull();
		}
	});

	it('refuses every other origin', async () => {
		for (const origin of ['https://evil.com', 'https://sumii.me.evil.com', 'https://notsumii.me', 'http://app.sumii.me', 'null', 'https://evil.com/https://sumii.me']) {
			const res = await preflight(origin);
			expect(res.status, origin).toBe(403);
			expect(res.headers.get('access-control-allow-origin')).toBeNull();
		}
	});

	it('adds the allow-origin header to real responses only for allowed origins', async () => {
		const user = await create_user();
		const ok = await api('GET', '/me/exports', { token: user.access_token, headers: { origin: 'https://app.sumii.me' } });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.sumii.me');
		expect(ok.headers.get('access-control-expose-headers')).toContain('ETag');
		const denied = await api('GET', '/me/exports', { token: user.access_token, headers: { origin: 'https://evil.com' } });
		expect(denied.status).toBe(200);
		expect(denied.headers.get('access-control-allow-origin')).toBeNull();
		const health = await api('GET', '/health', { root: true, headers: { origin: 'https://sumii.me' } });
		expect(health.headers.get('access-control-allow-origin')).toBe('https://sumii.me');
	});

	it('leaves requests without an Origin alone (the mobile app)', async () => {
		const res = await api('GET', '/health', { root: true });
		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
	});
});
