import './load_env';
import path from 'node:path';
import { z } from 'zod';

const num = (fallback: number) => z.coerce.number().default(fallback);

const schema = z.object({
	/** Role used for authenticated requests; row-level security applies to it. */
	DATABASE_URL: z.string().min(1),
	/** Table owner (bypasses RLS): migrations, background jobs and pre-authentication requests. Falls back to DATABASE_URL. */
	MIGRATE_DATABASE_URL: z.string().optional(),
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
	/** Sentry Cron Monitor check-ins from the reconcile worker and scripts/cron.sh. Off: the jobs still run, unmonitored. */
	SENTRY_CRONS: z.stringbool().default(false),

	JWT_ACCESS_SECRET: z.string().min(32),
	ACTION_TOKEN_SECRET: z.string().min(32),
	ACCESS_TOKEN_TTL_S: num(15 * 60),
	REFRESH_TOKEN_TTL_DAYS: num(60),
	ACTION_TOKEN_TTL_S: num(10 * 60),

	/** Resend API key. Unset logs the verification link instead of sending it (development and CI). */
	RESEND_API_KEY: z.string().optional(),
	/** Verified Resend sender, e.g. `Illusi <no-reply@mail.sumii.me>`. */
	EMAIL_FROM: z.string().default('Illusi <no-reply@sumii.me>'),
	/** Public base URL of this API, used in the confirmation link. */
	PUBLIC_API_URL: z.string().default('http://localhost:3000'),
	EMAIL_VERIFICATION_TTL_HOURS: num(24),
	/** Browsers may call the API from this domain and its subdomains (https only). */
	CORS_ALLOWED_DOMAIN: z.string().default('sumii.me'),

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
	/** `/alignment` separates the stems first: minutes of CPU per track. */
	ANALYZER_ALIGNMENT_TIMEOUT_MS: num(20 * 60_000),
	MEDIA_DIR: z.string().default(path.resolve('data/media')),
	MEDIA_MAX_BYTES: num(200 * 1024 * 1024),
	/** Behind nginx: `GET /media/:id` answers with `X-Accel-Redirect: <prefix><resource_id>` and nginx serves the file. Empty streams it from Node. */
	MEDIA_ACCEL_PREFIX: z.string().regex(/^(\/[a-z_]+\/)?$/u).default(''),
	/**
	 * Public base URL of the media bucket, which scripts/backup-media.sh moves files into. A media or artwork file no
	 * longer under MEDIA_DIR is answered with a redirect to `<url>/<path under MEDIA_DIR>`. Empty: media stays on disk.
	 */
	MEDIA_PUBLIC_URL: z.string().trim().regex(/^(https?:\/\/\S+)?$/u).default('').transform(url => url.replace(/\/+$/u, '')),
	/** The media bucket's S3 API (scheme and host only, e.g. https://eu2.contabostorage.com), used to delete removed files from it. Empty: removed files stay in the bucket. */
	MEDIA_S3_ENDPOINT: z.string().trim().regex(/^(https?:\/\/[^/\s]+\/?)?$/u, 'scheme and host only, without the bucket').default('').transform(url => url.replace(/\/+$/u, '')),
	MEDIA_S3_BUCKET: z.string().default(''),
	MEDIA_S3_ACCESS_KEY: z.string().default(''),
	MEDIA_S3_SECRET_KEY: z.string().default(''),
	MEDIA_S3_REGION: z.string().default('us-east-1'),
	/** Uploads are stored as AAC `.m4a`; non-AAC input is encoded at this bitrate (ffmpeg `-b:a`). */
	MEDIA_AAC_BITRATE: z.string().regex(/^\d+k$/u).default('256k'),
	MEDIA_TRANSCODE_CONCURRENCY: num(2),
	MEDIA_TRANSCODE_TIMEOUT_MS: num(10 * 60_000),
	/** Below this much free disk space an error goes to Sentry (time to upgrade storage). */
	DISK_WARN_FREE_GB: num(10),
	/** Below this much free disk space every file upload is refused with 507; database writes continue. */
	DISK_MIN_FREE_GB: num(5),

	/** Playlist artwork uploads: largest accepted file, and the longest side it is scaled down to (stored as JPEG). */
	ARTWORK_MAX_BYTES: num(10 * 1024 * 1024),
	ARTWORK_MAX_PX: num(1024),

	/** Data exports are kept this long after they're ready, and a user can request one per cooldown. */
	EXPORT_TTL_DAYS: num(7),
	EXPORT_COOLDOWN_HOURS: num(24),

	/** Log files: `LOG_DIR/<LOG_SERVICE>-<day>.log`, kept LOG_RETENTION_DAYS. Empty LOG_DIR logs to the console only. Read by core/log.ts. */
	LOG_DIR: z.string().default(''),
	LOG_SERVICE: z.string().default('app'),
	LOG_RETENTION_DAYS: num(7),

	LYRICS_RECHECK_AFTER_DAYS: num(14),
	LYRICS_ERROR_RETRY_MINUTES: num(10),
	LYRICS_SERVICE_TIMEOUT_MS: num(8_000),
	LYRICS_DEADLINE_MS: num(12_000),
	/** LRCLib app credentials, sent as `Lrclib-App-Id` / `Lrclib-Api-Key`. Unset queries LRCLib anonymously. */
	LRCLIB_APP_ID: z.string().optional(),
	LRCLIB_API_KEY: z.string().optional(),
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

	/** Users whose measured durations agree (within 3 s) needed to replace a stored duration they all disagree with. */
	DURATION_CONSENSUS_REPORTS: num(3),

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
