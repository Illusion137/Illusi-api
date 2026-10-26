import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../../config';
import { USER_ROLES } from '../../db/schema';

export type UserRole = typeof USER_ROLES[number];

export interface AuthUser {
	id: string;
	role: UserRole;
	/** Session family id; survives refresh-token rotation. */
	sid: string;
}

const access_key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);

export async function sign_access_token(user: AuthUser): Promise<string> {
	return new SignJWT({ role: user.role, sid: user.sid })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(user.id)
		.setIssuedAt()
		.setExpirationTime(`${config.ACCESS_TOKEN_TTL_S}s`)
		.sign(access_key);
}

export async function verify_access_token(token: string): Promise<AuthUser | null> {
	try {
		const { payload } = await jwtVerify(token, access_key, { algorithms: ['HS256'] });
		if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
		const role = (USER_ROLES as readonly string[]).includes(payload.role as string) ? payload.role as UserRole : 'USER';
		return { id: payload.sub, role, sid: payload.sid };
	} catch {
		return null;
	}
}

/** 256 random bits, base64url. Only its hash is stored. */
export function new_refresh_token(): string {
	return randomBytes(32).toString('base64url');
}

export function hash_token(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}
