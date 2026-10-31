import * as Sentry from '@sentry/node';
import { createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { current_context } from './context';

type Level = 'debug' | 'info' | 'warn' | 'error';

const HOST = hostname();
const FILE_RE = /^[a-z0-9_-]+-(\d{4}-\d{2}-\d{2})\.log$/iu;

/**
 * Daily files `LOG_DIR/<service>-<YYYY-MM-DD>.log` (UTC) of JSON lines, appended to by every process of that service.
 * Files older than LOG_RETENTION_DAYS are removed whenever a new day's file is opened. Empty LOG_DIR: console only.
 */
export class FileSink {
	private day = '';
	private stream: WriteStream | null = null;
	private broken: boolean;
	private service: string;
	private retention_days: number;

	constructor(private dir: string, service: string, retention_days: number) {
		this.broken = !dir;
		this.service = service.replace(/[^a-z0-9_-]/giu, '_');
		this.retention_days = Math.max(1, retention_days || 7);
	}

	write(line: string) {
		if (this.broken) return;
		const day = new Date().toISOString().slice(0, 10);
		if (day !== this.day) this.open(day);
		this.stream?.write(`${line}\n`);
	}

	private open(day: string) {
		this.stream?.end();
		this.stream = null;
		this.day = day;
		try {
			mkdirSync(this.dir, { recursive: true });
			this.stream = createWriteStream(path.join(this.dir, `${this.service}-${day}.log`), { flags: 'a' });
			this.stream.on('error', (err) => {
				console.error(`log file disabled: ${err.message}`);
				this.broken = true;
				this.stream = null;
			});
			this.prune(day);
		} catch (err) {
			console.error(`log file disabled: ${(err as Error).message}`);
			this.broken = true;
		}
	}

	private prune(today: string) {
		const oldest = new Date(Date.parse(today) - this.retention_days * 86_400_000).toISOString().slice(0, 10);
		for (const name of readdirSync(this.dir)) {
			const match = FILE_RE.exec(name);
			if (match && match[1] < oldest) rmSync(path.join(this.dir, name), { force: true });
		}
	}

	/** Resolves once everything written so far is on disk (tests). */
	async flush(): Promise<void> {
		const stream = this.stream;
		if (stream) await new Promise<void>(resolve => stream.write('', () => resolve()));
	}
}

// Read from the environment directly so logging works before (and without) the validated config.
const sink = new FileSink(process.env.LOG_DIR ?? '', process.env.LOG_SERVICE ?? 'app', Number(process.env.LOG_RETENTION_DAYS ?? 7));

function serialize(data: unknown): unknown {
	if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
	return data;
}

function safe_json(value: unknown): string {
	try {
		return JSON.stringify(value, (_key, v: unknown) => (v instanceof Error ? serialize(v) : typeof v === 'bigint' ? v.toString() : v));
	} catch {
		return JSON.stringify({ unserializable: String(value) });
	}
}

/** One JSON line for the log file. */
export function format_line(level: Level | 'access', scope: string, message: string | undefined, data: unknown, extra: Record<string, unknown> = {}): string {
	const context = current_context();
	return safe_json({
		time: new Date().toISOString(),
		level,
		scope,
		msg: message,
		request_id: context?.request_id,
		user_id: context?.user_id(),
		host: HOST,
		data: serialize(data),
		...extra
	});
}

function write(level: Level, scope: string, message: string, data?: unknown) {
	const context = current_context();
	const request_id = context?.request_id;
	const user_id = context?.user_id();
	const prefix = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}]${request_id ? ` (${request_id})` : ''}`;
	const out = level === 'error' || level === 'warn' ? console.error : console.log;
	if (data === undefined) out(`${prefix} ${message}`);
	else out(`${prefix} ${message}`, data);
	sink.write(format_line(level, scope, message, data));
	if (level === 'error') report(scope, message, data, request_id, user_id);
}

/** Only errors reach Sentry: each becomes an issue, plus a Sentry log for context. */
function report(scope: string, message: string, data: unknown, request_id: string | undefined, user_id: string | undefined) {
	const attributes = {
		scope,
		...(request_id ? { request_id } : {}),
		...(data instanceof Error ? { error: data.message } : data === undefined ? {} : { data: safe_json(data) })
	};
	Sentry.logger.error(`[${scope}] ${message}`, attributes);
	Sentry.withScope((sentry_scope) => {
		sentry_scope.setTag('scope', scope);
		if (request_id) sentry_scope.setTag('request_id', request_id);
		if (user_id) sentry_scope.setUser({ id: user_id });
		if (data instanceof Error) {
			sentry_scope.setExtra('message', message);
			Sentry.captureException(data);
		} else {
			if (data !== undefined) sentry_scope.setExtra('data', data);
			Sentry.captureMessage(`[${scope}] ${message}`, 'error');
		}
	});
}

/** Writes a line to the log file only (no console, no Sentry): the per-request access log. */
export function access_log(entry: Record<string, unknown>) {
	sink.write(safe_json({ time: new Date().toISOString(), level: 'info', scope: 'access', host: HOST, ...entry }));
}

export function logger(scope: string) {
	return {
		debug: (message: string, data?: unknown) => { if (process.env.DEBUG) write('debug', scope, message, data); },
		info: (message: string, data?: unknown) => write('info', scope, message, data),
		warn: (message: string, data?: unknown) => write('warn', scope, message, data),
		error: (message: string, data?: unknown) => write('error', scope, message, data)
	};
}

export type Logger = ReturnType<typeof logger>;
