import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const num = (fallback: number) => z.coerce.number().default(fallback);

const schema = z.object({
	DATABASE_URL: z.string().min(1),
	PORT: num(3000),
	NODE_ENV: z.string().default('development'),
	/** Express `trust proxy`. Behind the compose nginx-proxy the peer is a private docker address. */
	TRUST_PROXY: z.string().default('loopback'),
	/** How long a stopping container keeps finishing in-flight requests (must be below compose `stop_grace_period`). */
	SHUTDOWN_GRACE_MS: num(25_000),
	/** Git sha baked into the image, reported by /health. */
	APP_VERSION: z.string().default('dev'),
	/** Run the in-process iTunes/analyzer queues (only in the instance holding the leader lock). */
	BACKGROUND_SERVICES: z.stringbool().default(true),
	/** Sentry project DSN. Unset disables error reporting entirely. */
	SENTRY_DSN: z.string().optional(),
	/** Defaults to NODE_ENV. */
	SENTRY_ENVIRONMENT: z.string().optional(),
	SENTRY_TRACES_SAMPLE_RATE: num(0.1),

	JWT_ACCESS_SECRET: z.string().min(32),
	ACTION_TOKEN_SECRET: z.string().min(32),
	ACCESS_TOKEN_TTL_S: num(15 * 60),
	REFRESH_TOKEN_TTL_DAYS: num(60),
	ACTION_TOKEN_TTL_S: num(10 * 60),

	ITUNES_COUNTRY: z.string().default('US'),
	ITUNES_LIVE_TO_BACKFILL: z.string().default('3:1'),
	ITUNES_REQUEST_INTERVAL_MS: num(3100),
	ITUNES_ABORT_MS: num(15_000),
	ITUNES_MATCH_THRESHOLD: num(0.9),
	ITUNES_NOT_FOUND_RETRY_DAYS: num(30),
	ITUNES_ERROR_RETRY_MINUTES: num(15),

	ANALYZER_URL: z.string().default('http://127.0.0.1:8765'),
	ANALYZER_TMP_DIR: z.string().default(path.resolve('data/analyzer_tmp')),
	ANALYZER_CONCURRENCY: num(1),
	ANALYZER_JOB_TIMEOUT_MS: num(5 * 60_000),
	MEDIA_DIR: z.string().default(path.resolve('data/media')),
	MEDIA_MAX_BYTES: num(200 * 1024 * 1024),

	LYRICS_RECHECK_AFTER_DAYS: num(14),
	LYRICS_ERROR_RETRY_MINUTES: num(10),
	LYRICS_SERVICE_TIMEOUT_MS: num(8_000),
	LYRICS_DEADLINE_MS: num(12_000),
	/** Test seam: `not_found` makes every server-side lyrics service answer NOT_FOUND without a network call. */
	LYRICS_SERVERS_STUB: z.enum(['off', 'not_found']).default('off'),

	SC_TRANSCODING_STALE_AFTER_HOURS: num(24),

	NEW_RELEASES_WINDOW_DAYS: num(7),
	/** A library artist is checked again on a client service once its last check is this old. */
	NEW_RELEASES_RECHECK_HOURS: num(12),
	/** A handed-out check isn't handed out again for this long, unless it gets fulfilled. */
	NEW_RELEASES_REQUEST_COOLDOWN_MIN: num(30),
	NEW_RELEASES_MAX_ACTIONS: num(25),

	/** After a track is backpacked, only users who downloaded it are asked (UPLOAD_MEDIA) for this long, then research starts. */
	BACKPACK_UPLOAD_WINDOW_HOURS: num(48),
	/** A handed-out RESEARCH_TRACK isn't handed out again for this long, unless it gets fulfilled. */
	BACKPACK_RESEARCH_COOLDOWN_MIN: num(60),
	/** A service answered NOT_FOUND is asked again after this long. */
	BACKPACK_RESEARCH_RETRY_DAYS: num(30),

	RECONCILE_INCREMENTAL_INTERVAL_MIN: num(15),
	RECONCILE_DRY_RUN: z.stringbool().default(false),
	/** Local hour (0-23) the worker starts the nightly full pass. */
	RECONCILE_FULL_HOUR: num(3),
	/** Pairs at or above this confidence (without hard evidence) become admin review items; below are dismissed. */
	RECONCILE_REVIEW_MIN_CONFIDENCE: num(0.5),
	RECONCILE_MAX_GROUP_SIZE: num(50),
	RECONCILE_SPLIT_DURATION_GAP_MS: num(10_000),
	/** Cosine distances between feature vectors counted as "same audio" / "different audio". */
	RECONCILE_AUDIO_MATCH_DISTANCE: num(0.02),
	RECONCILE_AUDIO_CONTRADICTION_DISTANCE: num(0.25)
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.refine(c => c.NODE_ENV !== 'production' || c.LYRICS_SERVERS_STUB === 'off', {
	message: 'LYRICS_SERVERS_STUB is a test seam and must be off in production',
	path: ['LYRICS_SERVERS_STUB']
}).parse(process.env);
