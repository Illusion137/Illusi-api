// Must be the first import of every entrypoint so Sentry can patch http/express/pg before they load.
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { config } from './config';

/** Attribute or extra keys whose values never leave the process. */
const SECRET_KEY_RE = /pass(word)?|secret|token|authorization|cookie|api[_-]?key/iu;
const SEND_LOG_LEVELS = new Set(['error', 'fatal', 'critical']);

function scrub(values: Record<string, unknown> | undefined) {
	if (!values) return;
	for (const key of Object.keys(values)) if (SECRET_KEY_RE.test(key)) values[key] = '[redacted]';
}

Sentry.init({
	dsn: config.SENTRY_DSN,
	integrations: [nodeProfilingIntegration()],
	enabled: !!config.SENTRY_DSN,
	environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
	release: config.APP_VERSION,
	tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
	beforeSend(event) {
		// Never ship credentials that rode along on a request.
		if (event.request?.headers) {
			delete event.request.headers.authorization;
			delete event.request.headers.cookie;
		}
		scrub(event.extra);
		return event;
	},
	// Sentry only gets errors; everything quieter stays in the log files on the VPS.
	beforeSendLog(log) {
		if (!SEND_LOG_LEVELS.has(log.level)) return null;
		scrub(log.attributes);
		return log;
	}
});
