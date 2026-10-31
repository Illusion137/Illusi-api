import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from './auth/tokens';
import { logger } from './log';

const log = logger('http');

export class HttpError extends Error {
	constructor(public status: number, message: string, public body?: Record<string, unknown>) {
		super(message);
	}
}

/** Per-router JSON parser. There is no global one so each router can pick its own size limit. */
export function json_body(limit = '1mb') {
	return express.json({ limit });
}

export function parse_body<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
	const result = schema.safeParse(body);
	if (!result.success) throw new HttpError(400, 'invalid body', { issues: result.error.issues });
	return result.data;
}

export function require_user(req: Request): AuthUser {
	if (!req.user) throw new HttpError(401, 'unauthenticated');
	return req.user;
}

export function error_handler(err: unknown, req: Request, res: Response, _next: NextFunction) {
	if (err instanceof HttpError) {
		if (err.status >= 500) log.error(err.message, err);
		res.status(err.status).json({ error: err.message, ...err.body });
		return;
	}
	const status = (err as { status?: number; type?: string }).status;
	if (typeof status === 'number' && status >= 400 && status < 500) {
		res.status(status).json({ error: (err as Error).message });
		return;
	}
	log.error('unhandled error', err);
	res.status(500).json({ error: 'internal error', request_id: req.request_id });
}

export const uuid_schema = z.uuid();
