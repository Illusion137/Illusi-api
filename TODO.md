# TODO

## Observability

- [x] Every request gets a request id: nginx generates `$request_id`, the API accepts `X-Request-Id` (or makes one), returns it on every response (errors included), and attaches it to every log line and Sentry event.
- [x] One access-log line per request: method, route, status, duration, user id, request id.
- [x] Logs go to a file on the VPS (`DATA_DIR/logs`, one file per service per day), kept for 7 days.
- [x] Sentry only receives uncaught exceptions and `error`-level (major) errors; `debug`/`info`/`warn` stay in the log file.
- [x] `beforeSendLog` in the Sentry config (scrub credentials, drop anything below `error`).
- [x] Analyzer failures are reported to Sentry from the Node side, with the source path.
- [x] Sentry Cron Monitors for every scheduled job (database backup, media backup, certificate renewal, image cleanup, restore test, reconcile worker): a failed or missed run alerts.
- [x] Sentry Uptime monitor on `https://<domain>/health`, every 10 minutes (setup documented/scripted).
- [x] Disk space: Sentry alert when free space drops below `DISK_WARN_FREE_GB` (10 GB, i.e. 5 GB before the hard stop).
- [x] Disk space: below `DISK_MIN_FREE_GB` (5 GB) free, refuse every file upload (media, artwork) with `507`; database writes keep working. The artwork upload route must use `require_disk_space` (`src/core/disk.ts`).
- [x] Monthly restore test: restore the newest dump into a throwaway Postgres, sanity-check row counts, report through its cron monitor.

## Staging

- [x] `scripts/pull-sample.sh`: pull a sample of the production database (full catalog, a few users' personal data, anonymized) into a local Postgres for testing.

## Performance

- [x] gzip JSON responses in nginx.
- [x] nginx serves media files (`X-Accel-Redirect` after the API's access check).
- [x] ffmpeg runs at lower CPU priority (`nice`).
- [x] `UV_THREADPOOL_SIZE` set for the API.
- [x] Rate limit: 120 requests per minute per IP (nginx `limit_req`, shared across replicas).

## Database

- [x] Composite indexes on `track_plays_table`: `(user_id, track_id)` and `(user_id, created_at desc, id desc)`.
- [x] Stored play totals per track (no per-request `count(*)` over every play), used by artist `popular` sort and search ties.
- [x] Postgres tuned for the VPS (`shared_buffers`, `effective_cache_size`, `work_mem`, ...) and `pg_stat_statements` enabled.
- [x] API connection pool configured explicitly, with a `statement_timeout`.
- [x] Catalog reads answer `304` from a cheap version check before building the response, with `Cache-Control: private, max-age=60`.
- [x] Cross-process cache invalidation (Postgres `LISTEN/NOTIFY`): reconcile merges and other replicas invalidate the playlist resolution cache.

## Account

- [x] Data export: `POST /me/export` returns a job id, `GET /me/export/:id` reports its status, the file downloads once ready; exports expire.
- [x] Account deletion: `DELETE /me`, requires the password again even with a valid session.

## Playlist artwork

Custom playlist artwork used to live in Supabase storage and is still on users' devices (`artwork_path` in the local DB).

- [x] Upload endpoint (`PUT /playlists/:id/artwork`, owner only, image validation and size limit, stored next to media, behind the disk-space guard) and removal.
- [x] Artwork resource id on `playlists_table`, returned by sync pull and the read API, plus a download route.
- [x] Illusive uploads artwork when it changes, and uploads existing local artwork once after the database migration.

## Search

- [x] `GET /search/suggestions?q=`: close tracks, artists, albums and text completions, fast enough to call per keystroke.

## Illusive

- [x] Remove Supabase completely (`db/supabase.ts`, its session reads in `get_user_playlist.ts`, `search.ts`, `explore.ts`, `suggestions.ts`, `get_playlist.ts`, `new_releases.ts`, the `disable_supabase` pref, the dependency).
- [x] Every Illusi-backed feature calls the new `Illusi` client (`origin/src/illusi`).
- [x] Illusive calls the endpoints that update backend data wherever it changes that data locally (reports, ingests, contributions, uploads, ...).
- [x] Client methods and app calls for the new endpoints: search suggestions, artwork upload/removal, data export, account deletion.

## Admin dashboard

- [x] Static dashboard at `/admin/` (no build step), signed in with the existing login and the `ADMIN` role.
- [x] Live status: database, analyzer, disk, leader roles, connections per process, queue sizes, log activity per service.
- [x] Log viewer over `LOG_DIR`: per service and day, level/scope/request/user/text filters, paging and live tail.
- [x] Review queue UI for field conflicts, service id conflict plans and automatic merges/splits.
- [x] Media removal, backpack overview (most-reported and stuck tracks), track lookup with service id edits.
- [x] User management (role, verification, sign out everywhere, deletion) and an audit log viewer.
- [x] When an admin gives a backpacked track a `youtube_id`/`soundcloud_permalink`/`bandlab_id`/`audiomack_id` (a resolved
  conflict or a direct edit), `backpacked` is cleared.

## Vocal detection

- [x] Analyzer `POST /vocals` (Essentia Discogs-EffNet + voice/instrumental, ONNX), run on full media files only.
- [x] `track_vocals_table`, vocals jobs on media insert and in the startup backlog, `GET /tracks/:id/vocals`.
- [x] Ask for media of downloaded tracks whose only lyrics are unsynced.
- [ ] Line-by-line lyric syncing from the voice probabilities (in progress separately).

## Recommendations

To discuss: how to build recommendations (mixes and radio from a track, an artist or the whole library) on top of
`track_vectors_table`, play history and similar artists.
