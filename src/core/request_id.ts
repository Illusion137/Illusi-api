import * as Sentry from '@sentry/node';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { run_in_context } from './context';
import { access_log } from './log';

/** nginx `$request_id` is 32 hex chars; anything else reasonable from a trusted proxy or a client is kept too. */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/u;

/**
 * First middleware: gives every request an id (the incoming `X-Request-Id` when well formed, otherwise a new one),
 * returns it as `X-Request-Id`, makes it visible to every log line and Sentry event of the request, and writes one
 * access-log line when the response finishes or the client goes away.
 */
export function request_context(req: Request, res: Response, next: NextFunction) {
	const incoming = req.headers['x-request-id'];
	const request_id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID().replaceAll('-', '');
	req.request_id = request_id;
	res.setHeader('X-Request-Id', request_id);
	// Sentry's HTTP instrumentation, express and this access log already hold ~7 `close` listeners on every response,
	// and `pipeline(file, res)` adds 4 more when a file is streamed: per response and released with it, not a leak,
	// but past Node's default warning threshold of 10.
	res.setMaxListeners(32);
	Sentry.getIsolationScope().setTag('request_id', request_id);

	const start = performance.now();
	let logged = false;
	const done = () => {
		if (logged) return;
		logged = true;
		// Container healthchecks hit /health every few seconds; only failures are worth a line.
		if (req.path.startsWith('/health') && res.statusCode < 400) return;
		access_log({
			request_id,
			method: req.method,
			route: req.route ? `${req.baseUrl}${String((req.route as { path: unknown }).path)}` : null,
			path: req.originalUrl.split('?')[0],
			status: res.statusCode,
			aborted: !res.writableFinished,
			duration_ms: Math.round(performance.now() - start),
			bytes: Number(res.getHeader('content-length')) || undefined,
			user_id: req.user?.id,
			ip: req.ip
		});
	};
	res.on('finish', done);
	res.on('close', done);
	run_in_context({ request_id, user_id: () => req.user?.id }, next);
}
