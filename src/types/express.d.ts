import type { AuthUser } from '../core/auth/tokens';

declare global {
	namespace Express {
		interface Request {
			user?: AuthUser;
		}
	}
}

export {};
