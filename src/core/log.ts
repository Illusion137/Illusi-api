import * as Sentry from '@sentry/node';

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, scope: string, message: string, data?: unknown) {
	const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}`;
	const out = level === 'error' || level === 'warn' ? console.error : console.log;
	if (data === undefined) out(line);
	else out(line, data);
	report(level, scope, message, data);
}

/** Forwards to Sentry: every level above debug becomes a structured log, errors also become issues. */
function report(level: Level, scope: string, message: string, data: unknown) {
	if (level === 'debug') return;
	const attributes = { scope, ...(data instanceof Error ? { error: data.message } : data === undefined ? {} : { data: safe_json(data) }) };
	Sentry.logger[level](`[${scope}] ${message}`, attributes);
	if (level !== 'error') return;
	Sentry.withScope((scope_) => {
		scope_.setTag('scope', scope);
		if (data instanceof Error) {
			scope_.setExtra('message', message);
			Sentry.captureException(data);
		} else {
			if (data !== undefined) scope_.setExtra('data', data);
			Sentry.captureMessage(`[${scope}] ${message}`, 'error');
		}
	});
}

function safe_json(data: unknown) {
	try { return JSON.stringify(data); } catch { return String(data); }
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
