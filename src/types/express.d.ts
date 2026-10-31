import type { AuthUser } from '../core/auth/tokens';

declare global {
	namespace Express {
		interface Request {
			user?: AuthUser;
			/** Set by `require_auth`. */
			email_verified?: boolean;
			/** Set by the first middleware; also returned as `X-Request-Id`. */
			request_id?: string;
		}
	}
}

export {};
