import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { hash_token, new_refresh_token, sign_access_token, verify_access_token } from './tokens';

const key = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
const user = { id: 'user-1', role: 'ADMIN', sid: 'sid-1' } as const;

describe('access tokens', () => {
	it('round-trips id, role and session', async () => {
		expect(await verify_access_token(await sign_access_token(user))).toEqual(user);
	});

	it('rejects garbage and tokens signed with another key', async () => {
		expect(await verify_access_token('nope')).toBeNull();
		const forged = await new SignJWT({ role: 'ADMIN', sid: 's' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').sign(new TextEncoder().encode('x'.repeat(40)));
		expect(await verify_access_token(forged)).toBeNull();
	});

	it('rejects expired tokens', async () => {
		const expired = await new SignJWT({ role: 'USER', sid: 's' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(key);
		expect(await verify_access_token(expired)).toBeNull();
	});

	it('rejects other algorithms', async () => {
		const hs512 = await new SignJWT({ role: 'USER', sid: 's' }).setProtectedHeader({ alg: 'HS512' }).setSubject('u').sign(key);
		expect(await verify_access_token(hs512)).toBeNull();
	});

	it('rejects tokens missing subject or session', async () => {
		const no_sub = await new SignJWT({ sid: 's' }).setProtectedHeader({ alg: 'HS256' }).sign(key);
		const no_sid = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('u').sign(key);
		expect(await verify_access_token(no_sub)).toBeNull();
		expect(await verify_access_token(no_sid)).toBeNull();
	});

	it('downgrades an unknown role claim to USER', async () => {
		const token = await new SignJWT({ role: 'ROOT', sid: 's' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').sign(key);
		expect(await verify_access_token(token)).toEqual({ id: 'u', role: 'USER', sid: 's' });
	});
});

describe('refresh tokens', () => {
	it('are unique base64url of 256 bits', () => {
		const a = new_refresh_token();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(new_refresh_token()).not.toBe(a);
	});

	it('hash deterministically to sha256 hex', () => {
		expect(hash_token('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(hash_token('abc')).toBe(hash_token('abc'));
	});
});
