# Deploying Illusi

One VPS runs everything with Docker Compose (`compose.yaml`):

| Service | Role |
| --- | --- |
| `nginx-proxy` | Ports 80 and 443. TLS, plus routing to every `api` replica |
| `certbot` | One-shot; issues and renews certificates |
| `db` | Postgres 17 with pgvector |
| `api` | Rolled with zero downtime |
| `worker` | Reconciliation job |
| `analyzer` | Analyzer service |
| `migrate` | One-shot; runs before each rollout |

## First install

On a fresh Debian or Ubuntu VPS. First, from your machine, fill in `.env` and `.secrets` (with `USER=root`) and send
the `.env` over, so the database is created with your `POSTGRES_PASSWORD`:

```sh
scripts/upload-env.sh
```

Then on the VPS, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/Illusion137/Illusi-api/main/scripts/preinstall.sh -o preinstall.sh
DEPLOY_SSH_PUBKEY="$(cat deploy_key.pub)" GHCR_USER=Illusion137 GHCR_TOKEN=<read:packages PAT> \
bash preinstall.sh
```

preinstall keeps every value already in `.env` and generates only the secrets that are missing. Without an uploaded
`.env` it starts from `deploy/.env.production.example` and also needs `DOMAIN=... LETSENCRYPT_EMAIL=...`.

Point the domain's DNS at the VPS first: the certificate is issued over HTTP-01.

The script is safe to re-run. It installs:
- Docker, compose and the docker-rollout plugin
- ufw (22, 80 and 443 only), fail2ban, unattended upgrades, and swap on small machines
- the `illusi` deploy user and `/opt/illusi`, with random secrets for anything `.env` lacks
- systemd timers for certificate renewal, daily encrypted `pg_dump` (`data/backups` and the bucket; 7 daily + weekly to 21 days), media copies to the bucket every 15 minutes, a monthly restore test, and image cleanup. Each runs through `scripts/cron.sh`, which reports it to a Sentry Cron Monitor (see Monitoring)

It then deploys and issues the certificate.

### Backups

**Database.** `scripts/backup.sh` runs daily at 02:30. It writes a `pg_dump` to `data/backups`, encrypts it with
`BACKUP_ENCRYPTION_KEY` (gpg, AES-256), checks that the result decrypts to a readable dump, and copies it to the
bucket under `db/`. It keeps every dump from the last 7 days, plus the first dump of each week for 7 to 21 days,
so a dump between 14 and 20 days old always exists. The same rule prunes the bucket, based on the bucket's own
listing, so a freshly rebuilt VPS never deletes older copies. Keep the key outside the VPS (a password manager):
the dumps can't be restored without it. Without a key, dumps stay unencrypted and are never uploaded.

**Media.** `scripts/backup-media.sh` copies new media files to the bucket under `media/` every 15 minutes. It only
adds: nothing in the bucket is ever deleted or overwritten, so a file removed or corrupted on the VPS keeps its copy.
Playlist artwork (`data/media/artwork/`) is included. Data exports (`data/media/.exports/`) are short-lived copies of
a user's personal data and are never uploaded.

**Setup.** In the Contabo panel, create a bucket and S3 credentials, then set `BACKUP_S3_ENDPOINT` (your region's
endpoint, e.g. `https://eu2.contabostorage.com`), `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY` and
`BACKUP_S3_SECRET_KEY` in `.env`.

**Restoring after losing the VPS.** Run preinstall on the new VPS with the same `.env`, then:

```sh
scripts/backup.sh fetch                     # encrypted dumps from the bucket into data/backups
scripts/backup.sh decrypt data/backups/<newest>.dump.gpg |
  scripts/compose.sh exec -T db pg_restore --clean --if-exists -U illusi -d illusi
scripts/backup-media.sh restore             # media files back into data/media
```

**Restore test.** On the 1st of every month at 04:00, `scripts/restore-test.sh` takes the newest dump from the
bucket (or the newest local one without off-site copies), fails if it is more than 48 h old, restores it with
`pg_restore --exit-on-error` into a throwaway Postgres container, and checks that every live table exists in the
restore with at least half its rows. The live database is only read. Run it by hand any time; `--local` uses the
newest local dump.

### Managing `.env` from your machine

Keep the production `.env` in the repo root (git-ignored) and push it with `scripts/upload-env.sh`. It reads the
SSH target from `.secrets` (copy `.secrets.example`: `IP`, `USER`, `SSH_KEY`), validates the file, shows which keys
change (secrets masked), asks, uploads (the old file is kept as `.env.bak.<timestamp>`) and redeploys the running
images with zero downtime. `--no-apply` only uploads, and `--yes` skips the question.

Postgres only reads `POSTGRES_PASSWORD` when its data directory is created. If preinstall ran before your `.env` was
uploaded, it generated its own; either copy the VPS value into your local `.env`, or pass `--allow-db-password-change` once: the
script then changes the database user's password before the new `.env` goes live. Changing `JWT_ACCESS_SECRET` or
`ACTION_TOKEN_SECRET` invalidates tokens signed with the old values.

## Security

**Row-level security.** `DATABASE_URL` is the restricted role `POSTGRES_APP_USER` (default `illusi_app`): no superuser, no `BYPASSRLS`,
only select/insert/update/delete. Every authenticated request runs on it with `app.user_id` set to the caller, and the policies
(`drizzle/*_row_level_security`) limit user-owned tables to that user's rows (public playlists are readable by everyone).
`MIGRATE_DATABASE_URL` is the table owner, used by `migrate`, background jobs, registration/login and admin requests.
`migrate` creates the restricted role from `POSTGRES_APP_PASSWORD` and grants it access on every deploy.
An existing VPS needs `POSTGRES_APP_PASSWORD` (hex) in `.env` before the next deploy; re-running `scripts/preinstall.sh` fills it in.

**Rate limits.** nginx allows 120 requests/min per IP everywhere and 10/min per IP on `/api/v1/auth/` (`deploy/nginx`).
The API adds per-user and per-email limits on top.

**CORS.** Browsers may call the API only from `https://<CORS_ALLOWED_DOMAIN>` and its subdomains (default `sumii.me`).
Requests without an `Origin` header (the mobile app) are unaffected.

**Email confirmation.** Registration emails a link through [Resend](https://resend.com) (`RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_API_URL`).
Unverified users can sign in and call `/api/v1/auth/*` (including `POST /auth/resend_verification`), and everything else answers
`403 {"code":"EMAIL_NOT_VERIFIED"}` until they follow the link. Users created before this feature are unverified too; to grandfather
them: `update users_table set email_verified_at = now() where email_verified_at is null;`.

## Monitoring

**Logs.** The `api`, `worker` and `migrate` containers write JSON lines to `data/logs/<service>-<YYYY-MM-DD>.log`
(UTC days), kept for `LOG_RETENTION_DAYS` (7). Every line carries the request id and user id when it belongs to a
request, and every request also gets an access line (`"scope":"access"`: method, route, status, duration, user,
IP). `docker logs` still has a short console copy.

```sh
tail -f data/logs/api-$(date -u +%F).log | jq -c 'select(.level != "info")'
grep '"request_id":"<id>"' data/logs/*.log            # everything one request did
```

**Request ids.** nginx gives every request an id (`$request_id`, also in nginx-proxy's access log), the API returns
it as `X-Request-Id` (and as `request_id` in a 500 body), logs it, and tags Sentry events with it. Ask for it in bug
reports.

**Sentry** (`SENTRY_DSN`) only receives:
- uncaught exceptions and `error`-level log events (`beforeSendLog` drops anything quieter and redacts secrets),
  such as 5xx responses, analyzer failures (with the file path), and disk-space alerts;
- cron check-ins: `db-backup`, `media-backup`, `certs-renew`, `docker-prune` and `restore-test` from the systemd
  jobs (`scripts/cron.sh`, schedules kept next to the timers), and `reconcile-full` / `reconcile-incremental` from
  the worker. The first check-in creates each monitor; a failed, hung or missed run opens an issue.

Setup, once, in sentry.io:
1. Create a Node.js project and put its DSN in `.env` as `SENTRY_DSN` (`scripts/upload-env.sh`).
2. **Uptime:** Monitors -> Create -> Uptime Monitor: `GET https://<DOMAIN>/health`, interval **10 minutes**,
   timeout 10 s, environment `production`. `/health` answers 503 when the database is unreachable.
3. **Alerts:** make sure an issue alert rule notifies you (email or push) for new issues, including cron monitor
   and uptime issues (Alerts -> Create Alert -> Issues, "A new issue is created").

**Disk space.** Media, artwork, logs and Postgres share the disk. The API checks free space every 5 minutes: below
`DISK_WARN_FREE_GB` (10) it sends an error to Sentry (at most every 6 hours) so there is time to upgrade storage.
Below `DISK_MIN_FREE_GB` (5) every file upload is refused with `507` before its body is read, while requests that
only write to the database keep working.

## CI (`.github/workflows/cicd.yml`)

Every push and PR runs these checks against lib-origin `main` (`scripts/fetch-lib-origin.sh`):
- typecheck, lint and tests
- migration drift
- shellcheck
- the analyzer compile check
- `compose config`

A push to `main` also builds `ghcr.io/illusion137/illusi-api` and `illusi-analyzer`, tagged `:<sha>` and `:latest`. It then runs `scripts/deploy.sh <sha>` on the VPS over SSH.

Set these secrets in the `production` environment:
- `DEPLOY_HOST`
- `DEPLOY_USER` (`illusi`)
- `DEPLOY_SSH_KEY`
- `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`)

## How a deploy stays up

1. `migrate` runs while the old API is still serving. **Migrations must be backward compatible**: add columns and tables, backfill, and drop only in a later release.
2. `docker rollout api` starts a new replica beside the old one. nginx-proxy load-balances across both.
3. After the new replica is healthy (`GET /health`: DB reachable, not draining), it waits 15s, longer than nginx's `fail_timeout`. Then it stops the old replica.
4. On SIGTERM the old replica:
   - reports `draining`
   - stops accepting connections (nginx retries those on the new replica)
   - finishes in-flight requests for up to `SHUTDOWN_GRACE_MS`
5. The iTunes and analyzer queues run only in the replica holding a Postgres advisory lock. The new replica takes over when the old one exits.

`worker` and `analyzer` are recreated, not rolled: they serve no client traffic.

## Performance

**nginx** (`deploy/nginx/conf.d/illusi.conf` at `http` level, `deploy/nginx/vhost.d/default` inside the vhost):
- **gzip** for JSON responses over 1 KB. Audio is never compressed.
- **Rate limit**: 120 requests per minute per client IP, with a burst of 60 so an app start can send its batch at
  once. It's shared by every API replica; over it, clients get a JSON `429` with `Retry-After: 60`. Container
  health checks don't go through nginx. Clients behind one NAT share a budget.
- **Media**: `GET /media/:id` checks access in the API, which answers with `X-Accel-Redirect: /_internal_media/<id>`
  (`MEDIA_ACCEL_PREFIX`). nginx then serves the file from a read-only mount of `data/media` with sendfile, handling
  `Range` and `If-Range` against the API's ETag. `/_internal_media/` itself is not reachable from outside. Without
  the prefix (dev, tests), Node streams the file.

**API**: `UV_THREADPOOL_SIZE=16` so argon2 hashing doesn't stall file I/O; ffmpeg/ffprobe run under `nice -n 10`.

**Database**:
- Postgres memory settings come from `PG_*` in `.env` (defaults fit a ~4 GB VPS). `pg_stat_statements` is on;
  find the expensive queries with:
  ```sh
  scripts/compose.sh exec db psql -U illusi -d illusi -c "select calls, round(total_exec_time) as total_ms,
    round(mean_exec_time::numeric, 2) as mean_ms, left(query, 120) from pg_stat_statements order by total_exec_time desc limit 20"
  ```
  Statements slower than `PG_LOG_SLOW_MS` are also logged by the `db` container.
- The API pool cancels statements after `DB_STATEMENT_TIMEOUT_MS` (15s) and kills transactions idle for 60s; the
  worker allows 10 minutes and migrations have no limit.
- Play totals per track live in `track_play_counts_table`, kept by triggers on `track_plays_table` (inserts,
  deletes, and the UPDATE a merge does). Artist `popular` order and search tie-breaks read them.
- Catalog reads (`/tracks/:id`, `/albums/:id`, `/artists/:id`, `/artists/:id/albums`, `/artists/:id/tracks`) send
  `Cache-Control: private, max-age=60` and an ETag built from change counters (`read_versions_table`,
  `user_read_versions_table`, bumped by triggers). A matching `If-None-Match` gets a `304` after one small query,
  before the response is built. The catalog counter moves on any catalog write, so a busy catalog means fewer 304s,
  never stale ones.
- The resolved-playlist cache is per process. Merges (any change to `illusi_id_redirects_table`) and library changes
  reach every API process through Postgres `NOTIFY` on the `illusi_events` channel.

## Day to day

| Command | What it does |
| --- | --- |
| `scripts/compose.sh ps` | Container status; also `logs -f api` |
| `scripts/deploy.sh <sha>` | Redeploy or roll back to an earlier CI build |
| `scripts/force-deploy.sh [ref]` | Build on the VPS and deploy, without CI. From your machine it SSHes in using `.secrets` |
| `scripts/backup.sh [list\|fetch\|decrypt <file>]` | Back up the database now; `list` shows local and bucket dumps; see Backups for restoring |
| `scripts/upload-env.sh` | From your machine: push the local `.env` to the VPS and apply it |
| `scripts/backup-media.sh [check\|restore]` | Copy new media to object storage now; `check` lists files missing from the bucket; `restore` downloads them all into `data/media` |
| `scripts/ssl.sh renew` | Renew the certificate and reload nginx |
| `scripts/restore-test.sh [--local]` | Restore the newest dump into a throwaway Postgres and compare row counts |
| `scripts/cron.sh <monitor> -- <command>` | Run a command as one of the scheduled jobs, reporting to its Sentry Cron Monitor |

## Schema changes

Edit `src/db/schema.ts`, then run `npm run db:generate` and commit `drizzle/`. CI fails if the schema and the migrations disagree. Custom SQL (extensions, triggers) goes in `npx drizzle-kit generate --custom --name=<name>`. Locally, `npm run db:migrate` applies the migrations and `npm run db:push` still works for throwaway databases.

## Staging

`scripts/pull-sample.sh` copies a sample of the production database into a local Postgres, to test against real
data. The VPS is only read: the sample comes from one read-only snapshot inside the db container, and is streamed
back over SSH (settings from `.secrets`).

```sh
scripts/pull-sample.sh                          # 5 users with the largest libraries, into the container illusi-staging-pg
scripts/pull-sample.sh --users 20 --random      # 20 random users
scripts/pull-sample.sh --user me@example.com    # exactly these users (id or email, repeatable)
scripts/pull-sample.sh --with-media 50          # also download up to 50 of their media files into data/media
scripts/pull-sample.sh --save sample.sql.gz     # keep the download; reload it later with --from sample.sql.gz
```

What comes across:
- **The whole catalog**: artists, albums, tracks, service ids, lyrics, vectors and so on.
- **Personal data of the sampled users only**: library, playlists, plays, reports, contributions. A table counts as
  personal when it has a required foreign key to `users_table` (directly or through a personal table such as
  `playlists_table`), so new tables are classified without touching the script.
- **Anonymized**: emails become `user-<id8>@staging.invalid`, usernames `user_<id8>`, and every password is
  `illusi-staging`. Sessions, action token uses and sync push replays are never copied. Other users' ids in optional
  foreign keys (e.g. `review_items_table.resolved_by`) are set to null.

By default the database is the Docker container `illusi-staging-pg` on `127.0.0.1:55440`, recreated on every run,
so point the API at `DATABASE_URL=postgres://illusi:illusi@127.0.0.1:55440/illusi`. `--local-url` loads into
another database instead, after emptying every table in it. Either way, local migrations are applied first and the
whole load is one transaction that fails if any foreign key is broken.

Media rows are copied for every track, but the files only with `--with-media`. Without them, those tracks have no
audio locally.
