import type { NextFunction, Request, Response } from 'express';

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, If-None-Match, Range, X-Request-Id';
const EXPOSED_HEADERS = 'ETag, Content-Range, Content-Length, Retry-After, X-Request-Id';
const PREFLIGHT_MAX_AGE_S = '600';

/** `https://<domain>` and `https://<anything>.<domain>`. */
export function is_allowed_origin(origin: string, domain: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:' || url.origin !== origin) return false;
	return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
}

/**
 * Browsers may call the API only from `domain` and its subdomains. Requests without an Origin (the mobile app, curl)
 * are untouched; other origins get no CORS headers, so the browser blocks the response and preflight.
 */
export function cors(domain: string) {
	return (req: Request, res: Response, next: NextFunction) => {
		res.vary('Origin');
		const origin = req.headers.origin;
		if (origin && is_allowed_origin(origin, domain)) {
			res.setHeader('Access-Control-Allow-Origin', origin);
			res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
			if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
				res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
				res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
				res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_S);
				res.status(204).end();
				return;
			}
		} else if (origin && req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
			res.status(403).json({ error: 'origin not allowed' });
			return;
		}
		next();
	};
}
