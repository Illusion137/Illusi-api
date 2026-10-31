# Integration tests

End-to-end tests over HTTP (`/api/v1`, plus `/health` at the root) against a running API and a real Postgres (pgvector, all migrations applied).
Each test creates its own users and mock catalogue data (artists, albums, tracks with valid-looking Spotify
ids and ISRCs, tiny WAV files), so tests don't depend on each other and the suite can run repeatedly
against the same database.

| File | Covers |
| --- | --- |
| `01_auth` | health, register/login, refresh rotation and reuse detection, logout / logout-all, rate limits |
| `02_contribute` | contribution graphs, idempotency, matching by service id and normalized metadata, first-write-wins + review items, service id conflicts, partial rejection, `/resolve` |
| `03_sync` | first import with temp ids, pull cursors, push replay, last-write-wins and clock clamping, playlist inheritance rules, ownership |
| `04_lyrics_soundcloud` | lyric lookups (servers stubbed to NOT_FOUND), client lyric actions and token attestation, Genius validation, SoundCloud ingest |
| `05_media_playlists_admin` | media upload actions (imported, backpacked, unsynced lyrics), dedupe, range streaming, access rules; stored vocals; playlist copy; admin review |
| `06_releases_reconcile_concurrency` | new releases (global, per user, FETCH_NEW_RELEASES actions), reconcile worker merges, concurrent contributors and devices |
| `07_read_api` | profile, library sort/filter and overlay, plays/searches/linked playlists; playlist visibility and resolution; tracks (merges, batch), albums, artists (albums, tracks, similar); search (artist + title, accents, links, ISRCs, library scope, paging) |
| `08_backpack` | unavailable reports, backpacked uploads first, research actions per service with cooldowns, found ids and conflicts, clearing on upload |
| `09_read_performance` | stored play totals through inserts, deletes and merges; popular order; catalog ETags and 304s; one version bump per transaction |
| `10_search_suggestions` | suggestions for tracks, artists, albums and text; accents, `artist title`, library boost, recent searches; ETags and 304s; validation |
| `11_account_artwork` | playlist artwork upload, normalization, access, sync and last-write-wins; data export jobs, download, cooldown; account deletion with password, anonymized catalog, immediate token revocation |
| `12_email_verification` | unverified users can sign in but only reach `/auth`, hashed single-use links, expiry, changed address, resend limits, HTML and JSON confirmation |
| `13_row_level_security` | the API role has no BYPASSRLS, per-user isolation, public playlists, cross-user writes refused, no schema changes |
| `14_cors_headers` | preflight and response headers for `sumii.me` and subdomains, every other origin refused, no-Origin requests untouched |
| `15_admin_dashboard` | dashboard page, admin-only data routes, status snapshot, log search by request id, user role/verification/sign-out/deletion with audit, backpack overview, track lookup, media removal, backpacked cleared by an admin-assigned playable id |

Run everything locally without act (throwaway Postgres, restricted API role) with `scripts/test-integration.sh`; add `--coverage` for the API's own code coverage.

## Running with act (same as CI)

The `integration` job in `.github/workflows/cicd.yml` starts Postgres as a service, migrates twice, boots the
API and runs `npm run test:integration`. To run it locally with [act](https://github.com/nektos/act):

```sh
act -j integration -P ubuntu-latest=catthehacker/ubuntu:act-latest
```

That fetches lib-origin `main` like CI does. To test against your local `./lib-origin` instead (e.g. unpushed
changes), skip the fetch and stop act from dropping git-ignored files:

```sh
act -j integration --use-gitignore=false --env LIB_ORIGIN_SOURCE=workspace -P ubuntu-latest=catthehacker/ubuntu:act-latest
```

act copies the working directory into the container, including `node_modules`. Run it from a copy without
`node_modules` (or delete them first) if the host is not linux. On Apple silicon, add
`--container-architecture linux/arm64`.

## Running against your own Postgres

```sh
docker run -d --name illusi-it-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=illusi -e POSTGRES_PASSWORD=illusi -e POSTGRES_DB=illusi pgvector/pgvector:0.8.7-pg17-bookworm
export NODE_ENV=test DATABASE_URL=postgres://illusi:illusi@127.0.0.1:55432/illusi \
  JWT_ACCESS_SECRET=integration-access-secret-0000000000000000 \
  ACTION_TOKEN_SECRET=integration-action-secret-0000000000000000 \
  BACKGROUND_SERVICES=false LYRICS_SERVERS_STUB=not_found \
  MEDIA_DIR=/tmp/illusi-it/media ANALYZER_TMP_DIR=/tmp/illusi-it/analyzer_tmp \
  PORT=3901 API_URL=http://127.0.0.1:3901
npm run db:migrate
node --import tsx src/index.ts &   # the API under test
npm run test:integration
```

`LYRICS_SERVERS_STUB=not_found` makes the lyric servers answer NOT_FOUND without touching the network, so the
lyric tests are deterministic. Config refuses it in production. The API needs `ffmpeg` and `ffprobe` on its PATH:
media uploads are converted to `.m4a`. `BACKGROUND_SERVICES=false` keeps the iTunes
and analyzer queues off. The reconcile worker is run directly by the tests.
