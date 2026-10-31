import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('./log', () => ({ logger: () => log }));

import { send_email } from './email';

const mail = { to: 'a@b.c', subject: 'Hi', text: 'text', html: '<p>html</p>' };
const original = { key: config.RESEND_API_KEY, env: config.NODE_ENV };
const fetch_mock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('fetch', fetch_mock);
});
afterEach(() => {
	config.RESEND_API_KEY = original.key;
	config.NODE_ENV = original.env;
	vi.unstubAllGlobals();
});

describe('send_email without an api key', () => {
	beforeEach(() => { config.RESEND_API_KEY = undefined; });

	it('logs the email in development', async () => {
		config.NODE_ENV = 'development';
		await send_email(mail);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining('a@b.c'));
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('only warns in production, without leaking the body', async () => {
		config.NODE_ENV = 'production';
		await send_email(mail);
		expect(log.warn).toHaveBeenCalledWith(expect.not.stringContaining('text'));
		expect(log.info).not.toHaveBeenCalled();
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});

describe('send_email with an api key', () => {
	beforeEach(() => { config.RESEND_API_KEY = 're_key'; });

	it('posts to resend', async () => {
		fetch_mock.mockResolvedValue({ ok: true });
		await send_email(mail);
		const [url, init] = fetch_mock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.resend.com/emails');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_key');
		expect(JSON.parse(init.body as string)).toEqual({ from: config.EMAIL_FROM, to: ['a@b.c'], subject: 'Hi', text: 'text', html: '<p>html</p>' });
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('throws with a truncated response on failure', async () => {
		fetch_mock.mockResolvedValue({ ok: false, status: 422, text: async () => 'x'.repeat(1000) });
		await expect(send_email(mail)).rejects.toThrow(/^resend responded 422: x{300}$/u);
	});
});
