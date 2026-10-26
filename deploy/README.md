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
- systemd timers for certificate renewal, daily encrypted `pg_dump` (`data/backups` and the bucket; 7 daily + weekly to 21 days), media copies to the bucket every 15 minutes, and image cleanup

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

### Managing `.env` from your machine

Keep the production `.env` in the repo root (git-ignored) and push it with `scripts/upload-env.sh`. It reads the
SSH target from `.secrets` (copy `.secrets.example`: `IP`, `USER`, `SSH_KEY`), validates the file, shows which keys
change (secrets masked), asks, uploads (the old file is kept as `.env.bak.<timestamp>`) and redeploys the running
images with zero downtime. `--no-apply` only uploads, and `--yes` skips the question.

Postgres only reads `POSTGRES_PASSWORD` when its data directory is created. If preinstall ran before your `.env` was
uploaded, it generated its own; either copy the VPS value into your local `.env`, or pass `--allow-db-password-change` once: the
script then changes the database user's password before the new `.env` goes live. Changing `JWT_ACCESS_SECRET` or
`ACTION_TOKEN_SECRET` invalidates tokens signed with the old values.

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

## Schema changes

Edit `src/db/schema.ts`, then run `npm run db:generate` and commit `drizzle/`. CI fails if the schema and the migrations disagree. Custom SQL (extensions, triggers) goes in `npx drizzle-kit generate --custom --name=<name>`. Locally, `npm run db:migrate` applies the migrations and `npm run db:push` still works for throwaway databases.
