// Must be the first import of every entrypoint so Sentry can patch http/express/pg before they load.
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { config } from './config';

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
		return event;
	}
});
