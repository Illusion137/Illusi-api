# Illusi API — Requirements

Express 5 + Drizzle (Postgres) API. Schema lives in `src/db/schema.ts`.
External service clients come from `lib-origin` (`~/dev/Illusi/lib-origin`).

---

## 0. Conventions

### 0.0 Paths and versioning

- Every client-facing endpoint lives under **`/api/v1`**. Paths in this document are written without the prefix: `POST /sync/push` means `POST /api/v1/sync/push`.
- `GET /health` and `GET /health/live` stay at the root. They are for infrastructure (Docker healthchecks, deploys, nginx), not a client contract.
- A breaking change to a request or response shape ships as `/api/v2` next to `/api/v1`. Old app builds keep working until they age out. Additive changes (new optional fields, new action types) stay in `v1`.
- Unknown paths return `404` JSON. The rest of the host is free for a future web frontend.

### 0.1 Client actions (polite data requests)

Sometimes the server asks the client to fetch data the server can't or won't
fetch itself. It does this with an `actions` array in the response body:

```ts
interface ActionResponse { actions: ActionType[] }

type ActionType = { token: string } & (
	| { type: 'CHECK_GENIUS'; track_id: string; query: string }
	| { type: 'CHECK_YOUTUBE_MUSIC'; track_id: string; query: string; youtube_id?: string }
	| { type: 'UPLOAD_MEDIA'; track_id: string }
	| { type: 'FETCH_NEW_RELEASES'; artist_id: string; service: string; service_artist_id: string; since: string }
	| { type: 'RESEARCH_TRACK'; track_id: string; service: string; query: string; title: string; artists: string[]; duration_ms: number | null }
	// more action types get added as services need them
);
```

- `actions` can appear on **any** response, next to that response's normal data. It never replaces the data.
- Actions are **requests, not requirements**. The client may ignore any of them, and the server must work correctly if it does. Nothing waits on an action being completed.
- Each action type is a discriminated union member, keyed by `type`. It carries everything the client needs (IDs, a search query) and names the matching ingest endpoint it should submit to.
- An action is only included when it's actually needed. Don't ask for data that is already stored.
- Unknown `type` values must be ignored by clients, so new actions can be added without breaking older clients.

| `type` | Asks the client to | Submits to |
| --- | --- | --- |
| `CHECK_GENIUS` | Search Genius for the track and fetch its page state | `POST /ingest/genius` (§6) |
| `CHECK_YOUTUBE_MUSIC` | Fetch YouTube Music lyrics for the track | `POST /ingest/youtube_music_lyrics` (§7) |
| `UPLOAD_MEDIA` | Upload the audio file the user already downloaded for the track | `POST /tracks/:id/media` (§13) |
| `FETCH_NEW_RELEASES` | Fetch an artist's recent releases from a service the user is logged into | `POST /ingest/new_releases` (§15) |
| `RESEARCH_TRACK` | Look for an unavailable track on a download service | `POST /ingest/track_research` (§17) |

### 0.2 Action attestation

Only real, logged-in users can fulfil actions. Each fulfilment is accepted
only for the exact thing the server asked for.

- **Every action carries a server-issued `token`.** It's signed (HMAC/JWT, for example) and binds together:
  - `user_id`: the logged-in user the action was issued to
  - `type`: the action type
  - `target`: for example, the `track_id`
  - `iat`, `exp`: issue time and a short expiry (minutes)
  - `jti`: a unique ID
- **Ingest endpoints that fulfil an action** must check every one of these:
  1. The request is authenticated with a valid access token (§12), and the user matches the token's `user_id`.
  2. The signature is valid and the token hasn't expired.
  3. The token's `type` matches the endpoint.
  4. The token hasn't been used. `jti` is single-use, so record it as used until `exp`.
  5. The payload is **only** about the token's `target`. Data about anything else in the payload isn't attached to that target.
- Reject with `401`/`403` and store nothing if any check fails.
- Record which user and which token produced each row (or at least log it), so bad data can be traced back and removed.
- Unsolicited submissions, like SoundCloud browsing data (§5) and global data contributions (§9), have no action token. They still require a logged-in user, per-user rate limits, and a provenance record of who sent what (§9.5).

---

## 1. iTunes Service

Resolves artists, albums, and tracks against the iTunes Search/Lookup API and
persists the results into `itunes_artists_table`, `itunes_collections_table`,
and `itunes_tracks_table`.

Uses `ITunes.search` / `ITunes.lookup` from `@origin/itunes/itunes`
(`lib-origin/origin/src/itunes/itunes.ts`).

### 1.1 Lookup request types

| Type     | Fields                                                              |
| -------- | ------------------------------------------------------------------- |
| `artist` | `artist_name`                                                       |
| `album`  | `artist_name`, `album_name`                                         |
| `track`  | `artist_name`, `album_name?`, `track_name`, `duration_ms?`          |

### 1.2 Resolution pipelines

Explicit tracks don't reliably show up in iTunes search (`explicit=Yes` still
leaves them out), so tracks are found by walking down from the artist instead
of searching for them directly.

- **Artist**: `search` (`media=music`, `entity=musicArtist`, `term=artist_name`) → choose the best artist match.
- **Album**: artist search → `lookup` (`id=<artistId>`, `entity=album`, `limit=200`) → match `album_name` against `collectionName` / `collectionCensoredName`.
- **Track**: artist search → albums lookup (as above) → album tracks lookup (`id=<collectionId>[,...]`, `entity=song`, `limit=200`) → match `track_name`.
  - If `album_name` is given, look up only the matching album(s). Otherwise look up all of the artist's albums.
  - If `duration_ms` is given, use it to break ties (compare against `trackTimeMillis` within a tolerance).
  - When an explicit and a cleaned version both match, prefer `trackExplicitness = 'explicit'`.
- **Artist used for the search**: only the track's **primary** (first-listed) artist. Featured artists aren't searched.
- **Matching names** (artist, album, track):
  1. Normalize both sides: lowercase, Unicode NFKC, strip punctuation, and strip `feat.`/`ft.` parts and version suffixes such as `(Deluxe)`, `(Remastered)`, and `- Single`.
  2. Require string similarity **≥ 0.9** (configurable).
  3. `duration_ms` within **±3 s** breaks ties between candidates.
- **Storefront**: `country` = `ITUNES_COUNTRY` env var (default `US`), one storefront for the whole server.

### 1.3 Batching album-track lookups

- `lookup` accepts comma-separated `id`s. The 200 limit applies to the **total results**, not to each collection.
- Group collection IDs into one lookup only while the sum of their `trackCount` (known from the albums lookup) plus one collection row per album stays ≤ 200. That way no album's tracks get cut off.
- A single album with more than 200 tracks gets its own lookup.
- If several queued track requests need the same artist or album, the work should be shared (see 1.5).

### 1.4 Queue

- One queue for the whole process. It runs **one HTTP request at a time**.
- **Two lanes, interleaved**:
  - **Live lane**: new inserts and fast-path ID lookups.
  - **Backfill lane**: the startup scan.
  - The queue alternates between them at a configurable ratio (`ITUNES_LIVE_TO_BACKFILL`, default 3 live : 1 backfill). New tracks are never stuck behind a large backfill, and the backfill always makes progress.
  - If one lane is empty, the other one gets every turn.
- **The local item comes first.** Only a track, album, or artist that already exists locally can be queued, and it must already have a `service_ids_table` row. Each queue item carries that row's `illusi_id`. The iTunes service never creates Illusi entities. It only adds iTunes data to existing ones.
- **Imported tracks are never queued.** This applies to `tracks_table.imported = true`, both at startup and at runtime.
- **On server startup** (backfill lane): queue a `track` request for every track that meets all of these:
  - `imported = false`;
  - there's no `itunes_tracks_table` row linked through `service_ids_table.applemusic_id`;
  - its `itunes_lookups_table` row (1.8) has no `retry_after` in the future.

  Get the names by joining `albums_table`, `tracks_artists_table`, and `artists_table`. Albums and artists with no linked iTunes row are queued the same way.
- **Fast path for known IDs** (live lane): another service (Genius, for example; see §4) may have already filled in `applemusic_id`. In that case, skip the search pipeline and do a plain `lookup?id=...`. Up to 200 known IDs can go into one lookup request.
- **At runtime** (live lane): after a local track, album, or artist has been inserted along with its `service_ids_table` row, add it to the **back** of the live lane (unless it's an imported track).
- Don't queue a request that is already waiting in the queue (key = type + normalized fields).
- The queue doesn't block startup or request handling. It drains in the background.

### 1.5 Caching / reuse

- Keep artist search results and artist→albums lookups in memory for a short TTL. Then a burst of tracks by the same artist costs one search and one albums lookup.
- Before calling the API, check whether the entity already exists in the `itunes_*` tables.

### 1.6 Rate limiting & backoff

- iTunes allows about 20 requests per minute and signals rate limiting with **HTTP 403** (sometimes 429).
- Space requests at a baseline interval that can be configured.
- On 403 or 429: exponential backoff with jitter (for example 30s → 60s → 120s …, capped). Honor `Retry-After` if it is present. Retry the **same** request, and keep the queue paused until it succeeds.
- On 5xx or network errors or timeouts (`abort_ms`): retry with backoff, up to N attempts. After that, drop the item and log it.
- On 4xx other than 403/429: don't retry. Log and drop.
- After a run of successful requests, reset the backoff.
- `rozfetch` returns a `ResponseError` for any non-OK status, so the service has to read the status code out of that error to choose a path.

### 1.7 Persistence

- Upsert by iTunes ID (`artistId` → `itunes_artists_table.id`, `collectionId` → `itunes_collections_table.id`, `trackId` → `itunes_tracks_table.id`).
- Field mapping uses camelCase → snake_case (for example `trackTimeMillis` → `track_time_millis`, `collectionExplicitness` → `explicitness`, `artworkUrl100` → `artwork_url_100`).
- Write the artist first, then the collection, then the track, so the foreign keys are satisfied.
- In the same transaction, set `service_ids_table.applemusic_id` on the queue item's `illusi_id`: the `trackId`, `collectionId`, or `artistId`. This is the only link from an Illusi entity to its iTunes row. It follows the shared rules in §4 (only fill empty columns, log conflicts).
- **Schema change needed**: `tracks_table.id` has to reference `service_ids_table.illusi_id`, like `artists_table` and `albums_table` already do. Today it's a standalone `defaultRandom()`. Inserting a local track then means inserting the `service_ids_table` row first and using its `illusi_id` as the track's `id`.

### 1.8 Lookup records

Every attempt is recorded, so items that never match aren't searched again on every startup. This is the same pattern as the lyrics lookups (§7.3).

`itunes_lookups_table`

| Column | Notes |
| --- | --- |
| `illusi_id` | Primary key. Foreign key to `service_ids_table`, on delete cascade |
| `entity_type` | `track` / `album` / `artist` |
| `status` | `FOUND` / `NOT_FOUND` / `ERROR` |
| `attempts` | |
| `attempted_at` | |
| `retry_after` | When this entity may be queued again |

How long before an entity may be queued again (configurable):

- `FOUND`: never re-queued.
- `NOT_FOUND`: after about 30 days.
- `ERROR`: after minutes, with backoff.

A newly filled `applemusic_id` (fast path) ignores `retry_after`.

---

## 2. Music Analyzer Service

Analyzes a track's audio and saves the features to `track_sample_data_table`.
Only iTunes preview downloads are temporary and get deleted afterwards. Files
referenced by `media_table` are **never** deleted, moved, or modified.

### 2.1 Components

- **Analyzer (Python, local HTTP API).** A separate process that wraps
  [Mood-Detector](https://github.com/usr-wwelsh/Mood-Detector) and
  [VibeNet](https://github.com/jaeheonshim/vibenet).
  - It has no database access. It takes a file path and returns combined JSON.
  - Load both models once at startup, not once per request.
- **Analyzer queue (Express side).** Handles downloading, calling the analyzer, saving results, and cleaning up temp files.

### 2.2 Analyzer API contract

- `GET /health` returns `200` once the models are loaded.
- `POST /analyze` with body `{ "path": "/abs/path/to/file" }` returns:

```json
{
  "mood": "string",
  "tempo": 0.0, "brightness": 0.0, "key": "C#m",
  "arousal": 0.0, "valence": 0.0,
  "acousticness": 0.0, "instrumentalness": 0.0, "liveness": 0.0,
  "danceability": 0.0, "speechiness": 0.0
}
```

- Field sources:
  - **Mood-Detector**: `mood`, `tempo`, `brightness`, `key`.
  - **VibeNet** (all values 0–1): `acousticness`, `instrumentalness`, `liveness`, `danceability`, `speechiness`, `valence`, and `energy`, which is stored as `arousal`.
  - Any other values Mood-Detector returns are ignored.
- Errors:
  - `400`: the path is missing or unreadable.
  - `422`: the file can't be decoded.
  - `500`: the model failed.
  - The analyzer never deletes the input file. Express owns it.
- Listens on localhost only. Host and port are set by env var (`ANALYZER_URL`).

### 2.3 Triggers

A job is keyed by `tracks_table.id`, because `track_sample_data_table.id` is that ID.

- **iTunes insert**: when the iTunes service (§1) inserts an `itunes_tracks_table` row that has a `preview_url`, queue an analysis job for the queue item's `illusi_id`. This works because a track's `illusi_id` is its `tracks_table.id` (see 1.7). The source is the preview URL, a roughly 30s `.m4a` file.
  - Imported tracks never go through iTunes, so they're only analyzed through the media trigger.
- **Media insert**: when a `media_table` row is inserted (by a client upload, §13), queue an analysis job. The source is `MEDIA_DIR/<resource_id>`, a UUID file name. The file is analyzed where it is and is **never deleted**, whatever happens with the job.
- **First sample wins.** If a `track_sample_data_table` row already exists, skip the job. A media insert after a preview-based sample does not re-analyze the track.
- Don't queue a job whose `track_id` is already queued.

### 2.4 Job lifecycle

1. Get a local path for the source:
   - **iTunes preview**: download it into `ANALYZER_TMP_DIR`, named `<track_id>.<uuid>.<ext>`.
   - **Media file**: use its path as is. Never copy it into the temp directory.
2. Call `POST /analyze` with the absolute path.
3. Insert into `track_sample_data_table` (`id = track_id`, on conflict do nothing).
4. **iTunes preview only**: delete the downloaded file in a `finally` block, whether the job succeeded or failed. Media jobs skip this step completely.

- Each job records its source type (`itunes_preview` or `media`). Deletion depends **only** on that type, never on what the path looks like.
- As an extra safeguard, the delete call refuses any path outside `ANALYZER_TMP_DIR`.

- Jobs run one at a time, because analysis uses a lot of CPU. The number of jobs at once can be configured. Downloading the next job while the current one is analyzing is allowed.

### 2.5 Restarts and the initial queue

The database is the source of truth, so no separate queue table is needed. On startup:

1. **Delete all temp files.** Empty `ANALYZER_TMP_DIR`, because a crash or restart can leave orphaned preview downloads behind.
   - `ANALYZER_TMP_DIR` must be its own directory, and must not be the media directory or inside it. Refuse to start if it is.
2. **Wait for the analyzer.** Poll `GET /health` with backoff. Don't process jobs until it reports ready.
3. **Queue the backlog.** Query every track that has an analyzable source, no `track_sample_data_table` row, and no `track_sample_lookups_table` row (2.8) with a `retry_after` in the future. Queue them. Sources are:
   - a `media_table` row, or
   - an `itunes_tracks_table` row with a `preview_url`, found through `service_ids_table.applemusic_id = itunes_tracks_table.id`.
4. Jobs triggered live are added to the back of the same queue, with duplicates skipped.

- A job interrupted mid-run (by a crash, `SIGTERM`, or a deploy) has no row written yet. The startup query picks it up again automatically.
- **Graceful shutdown**: on `SIGTERM`/`SIGINT`, stop pulling new jobs, let the current job finish or time out, delete temp files, then exit.

### 2.6 Failure handling

- **Analyzer unreachable or `5xx`**: pause the queue, check `/health` with backoff, and resume once it is ready. Retry the same job.
- **Download fails**:
  - Network errors or `5xx`: retry with backoff, up to N attempts.
  - `404` or a gone resource: give up on the job.
- **`400`/`422` from the analyzer**: the file is bad, so give up on the job.
- **Per-job timeout**: the timeout covers both the download and the analysis.
- Every job that ends, whether it succeeded or was given up, writes a lookup record (2.8), so startup doesn't retry it forever.

### 2.7 Configuration

| Env var | Purpose |
| --- | --- |
| `ANALYZER_URL` | Base URL of the Python analyzer |
| `ANALYZER_TMP_DIR` | Directory for temporary downloads (cleared on startup) |
| `ANALYZER_CONCURRENCY` | Number of jobs running at once (default 1) |
| `ANALYZER_JOB_TIMEOUT_MS` | Per-job timeout |
| `MEDIA_DIR` | Directory holding uploaded media (`<resource_id>` files). Never written to or deleted from by the analyzer. |

### 2.8 Lookup records

`track_sample_lookups_table`

| Column | Notes |
| --- | --- |
| `track_id` | Foreign key to `tracks_table`, on delete cascade |
| `source` | `itunes_preview` / `media` |
| `status` | `DONE` / `BAD_FILE` / `NOT_FOUND` / `ERROR` |
| `attempts` | |
| `attempted_at` | |
| `retry_after` | When this source may be tried again |

- Primary key is `(track_id, source)`.
- How long before a source may be tried again:
  - `BAD_FILE` (`400`/`422` from the analyzer) and `NOT_FOUND` (download `404`): not until that source changes. A new `preview_url`, or a new `media_table` row, resets it.
  - `ERROR`: after minutes, with backoff.

### 2.9 Decided

- The analyzer runs as a **separate process** (docker-compose or systemd, for example). Express never spawns it. It only checks `/health`.
- First sample wins. There's no re-analysis.
- VibeNet `energy` is stored as `arousal`, and VibeNet `valence` is stored as `valence`.
- `media_table.resource_id` is a UUID file name inside `MEDIA_DIR`, created by client uploads (§13).

### 2.10 Task before implementation

- **Check Mood-Detector's actual output** against its repo: field names, units, the format of `key`, and whether `mood` is one label or a set of per-mood scores. Then update the contract in 2.2 and the mood encoding in §3.2.

### 2.11 Vocal detection

Finds where a track has a voice (singing or talking) and where it's instrumental, for line-syncing unsynced lyrics.

- **Model**: Essentia's Discogs-EffNet embeddings and its voice/instrumental head, both as ONNX, run by the analyzer.
  The models are CC BY-NC-SA 4.0 (non-commercial).
- **Full media files only.** Only `media_table` files are analyzed, never iTunes previews (they're 30 s excerpts).
- **Analyzer API**: `POST /vocals` with `{ "path": "/abs/path" }`, same errors as `/analyze`. It returns
  `{ model, hop_ms, window_ms, duration_ms, voice: number[], segments: [{ start_ms, end_ms }] }`:
  - `voice[i]` is the voice probability (0–1) of the window `[i * hop_ms, i * hop_ms + window_ms)`
    (2048 ms windows, one every 256 ms by default);
  - `segments` are the voiced spans derived from it, accurate to about half a second.
- **Trigger**: every media insert queues a vocals job next to the sample job, and the startup backlog queues tracks
  whose newest media file has no result. Failures follow the lookup rules of 2.8, keyed by the media `resource_id`.
  A newer upload is analyzed again.
- **Storage**: `track_vocals_table`, one row per track holding both the lookup state and the result.
- **Read API**: `GET /tracks/:id/vocals` returns the stored result for the track, or `404`.

---

## 3. Track Feature Vectors (for recommendations)

Every analyzed track gets a vector of its audio features. Similarity search over
those vectors will power recommendations later.

### 3.1 Storage

- Use **pgvector** in the existing Postgres database, not a separate vector database.
  - Embeddings come from `track_sample_data_table`, so they can be written in the same transaction and joined with users, playlists, and plays in plain SQL.
  - It's one less service to run, back up, and keep in sync.
- Requires `CREATE EXTENSION vector` (pgvector). Drizzle supports it through `vector({ dimensions })` in `drizzle-orm/pg-core`.
- New table `track_vectors_table`:
  - `track_id`: `uuid`, primary key, references `tracks_table.id`, on delete cascade.
  - `embedding`: `vector(N)`.
  - `version`: `integer`, the version of the feature encoding.
  - timestamps.
- Index: HNSW on `embedding` with `vector_cosine_ops`.

### 3.2 Vector encoding

The vector is built from one `track_sample_data_table` row. Every dimension is scaled to roughly [0, 1] so that no single feature dominates.

| Source | Dimensions | Encoding |
| --- | --- | --- |
| `acousticness`, `instrumentalness`, `liveness`, `danceability`, `speechiness`, `valence`, `arousal` | 7 | Used as is (already 0–1) |
| `tempo` | 1 | Clamp to about 60–200 BPM, then min-max scale. Half and double tempo should land close together, for example by folding into one octave first. |
| `brightness` | 1 | Min-max scale using the observed range (depends on Mood-Detector's units) |
| `key` | 3 | Pitch class placed on the circle of fifths as `sin`/`cos`, plus a 0/1 flag for major or minor. Musically close keys end up close together. |
| `mood` | K | Depends on Mood-Detector's output (task in §2.10). Per-mood scores → a dense sub-vector of those scores. A single label → one-hot over the known labels. |

- Each feature group can be given a weight. Weights are applied when the vector is built. **Every weight starts at 1.0**, to be tuned once recommendation quality can be judged.
- The encoding is in one versioned function. Changing the encoding or weights bumps `version`.

### 3.3 Write path

- When the analyzer saves a `track_sample_data_table` row (§2.4 step 3), insert the vector **in the same transaction**.
- **On startup**: rebuild vectors for every sample row that either has no vector or has `version < CURRENT_VERSION`. The vectors come only from Postgres data, so no audio has to be re-analyzed.

### 3.4 Query capabilities (for later recommendation endpoints)

- **Similar tracks**: the k nearest neighbors of a track's vector (`ORDER BY embedding <=> $1 LIMIT k`). Exclude the track itself and the user's deleted tracks.
- **Taste vector**: the mean of the vectors of a set of tracks, such as a playlist, a user's recent `track_plays_table` entries, or their `user_tracks_table` library. Search with that mean vector.
- Results can be filtered in SQL with any relational condition (explicit, artist, already in the library).

### 3.5 Future: non-audio signals

- `embedding` stays **audio only**.
- Later, a second vector column (for example `behavior_embedding`) can hold genre plus listening behavior learned from plays and libraries.
- Recommendation queries then blend the two distances at query time with configurable weights. Neither vector is ever mixed into the other.

---

## 4. Service ID Enrichment (applies to every service)

**Goal:** fill in as many `service_ids_table` columns as possible for every
Illusi entity. Every service integration (iTunes, SoundCloud, Genius, and any
added later) has to pull out every cross-service ID it sees and pass it
through the shared helper `enrich_service_ids(illusi_id, ids)`.

### 4.1 Where IDs come from

| Source | IDs it provides |
| --- | --- |
| iTunes (§1) | `applemusic_id` (`trackId` / `collectionId` / `artistId`) |
| SoundCloud ingest (§5) | `soundcloud_id`, `soundcloud_permalink`, `isrc` (`publisher_metadata.isrc`) |
| Genius song (§6) | `genius_id` (song `id`), `applemusic_id` (`appleMusicId`, when Genius has it), `spotify_id` (`spotifyUuid`), `youtube_id` (parsed from `youtubeUrl`), `soundcloud_permalink` (parsed from `soundcloudUrl`), plus every `media[]` entry by `provider` (youtube, spotify, soundcloud) |
| Genius artist (§6) | `genius_id` (artist `id`), for Illusi artists |

- **Schema changes (decided)** to `service_ids_table`:
  - Add `genius_id bigint unique`.
  - Add `isrc varchar(12)`, indexed but **not unique**. An ISRC (International Standard Recording Code) identifies one recording, and that recording can appear on several releases (single, album, compilation).
    - Normalize to uppercase with no hyphens.
    - Sources: SoundCloud `publisher_metadata.isrc`, plus any later service that provides it (Spotify, Deezer). iTunes Search doesn't return it.
    - Two different Illusi IDs with the same ISRC is **not** a conflict at ingest. It's a strong input to the reconciliation job (4.5).

### 4.2 How an ID gets attached to an Illusi entity

An external ID is only attached once we know which `illusi_id` it belongs to. That happens in one of two ways:

1. **From the request**: for example, the client says "these Genius lyrics are for track X", or the iTunes queue item carries its `illusi_id`.
2. **From an ID we already have**: the payload contains an ID that is already in `service_ids_table`. For example, a SoundCloud track whose `soundcloud_id` is already linked lets us add its `soundcloud_permalink` to the same row.

- External data that matches no Illusi entity is still stored in its service's own tables. It just isn't linked yet. Enrichment never creates Illusi entities. The local item always comes first, same as §1.4.

### 4.3 Rules

- **Normalize before writing**:
  - `youtube_id`: the bare 11-character video ID.
  - `soundcloud_permalink`: the `user/track` path, lowercase, with no domain or query string.
  - `applemusic_id`: a numeric string.
  - `spotify_id`: the base62 ID.
- **Only fill empty columns.** Never overwrite an existing value during ingest.
- **Conflicts aren't resolved inline.** They're recorded in `service_id_conflicts_table` and handled by the reconciliation job (4.5). There are two kinds:
  - **Different value**: the row already has another value for that column.
  - **Taken by another entity**: a different `illusi_id` already holds the incoming value (the columns are unique).
- **Follow-up work**: newly filled columns can start downstream work.
  - A new `applemusic_id` goes onto the iTunes fast path (§1.4).
  - A new SoundCloud or YouTube ID can later feed a media download.

### 4.4 Conflict records

New table `service_id_conflicts_table`:

| Column | Notes |
| --- | --- |
| `id` | Primary key |
| `illusi_id` | The entity the incoming ID was being attached to |
| `column` | Which `service_ids_table` column (for example `applemusic_id`) |
| `existing_value` | The value already stored |
| `incoming_value` | The value that was rejected |
| `other_illusi_id` | Set for "taken by another entity" conflicts |
| `source` | Where the incoming ID came from (`itunes`, `genius`, `soundcloud`, ...) |
| `source_user_id`, `source_token_jti` | For client-submitted data (§0.2) |
| `status` | `open` / `deferred` / `merged` / `split` / `dismissed` |
| timestamps | |

### 4.5 Reconciliation job (cron)

Conflicts in `service_ids_table` are one of the hardest parts of the system. A
scheduled job looks at the data attached to each ID and decides whether two
Illusi IDs are really the same entity (merge), whether one Illusi ID is really
two entities (split), or whether there's nothing to do (dismiss).

**Runs as a separate worker process**, not inside the Express server. It shares the database and the `src/db` code.

**Scope**

- **Incremental run** (frequent, for example every 15 minutes): process `open` conflicts that are simple. A simple conflict involves exactly two `illusi_id`s, and the decision is clear-cut.
- **Full pass** (for example nightly): this is how every hard case gets resolved.
  1. **Pass over everything**: read the whole `service_ids_table`, plus all `open` and `deferred` conflicts.
  2. **Group**: build connected groups. Two `illusi_id`s are connected if they share any external ID value, are linked by a conflict record, or share an ISRC or a strong metadata match (normalized title, artist, and duration). One group can span many rows. For example, A conflicts with B on Apple Music, and B conflicts with C on SoundCloud.
  3. **Resolve in memory**: for each group, work out the target state: which real entities exist, and which external IDs belong to each. The result is a plan of merges, splits, and ID moves. Nothing is written in this step.
  4. **Apply**: run the steps backed by **hard evidence** (see Decisions) as one migration per group, each in its own transaction. Write the audit log and redirects (see below). Every other step in the plan becomes an admin review item (§11), with the plan attached.
  - **Memory**: for now, the whole table is loaded into memory. Build the grouping step as a function that takes one group's rows. Then it can later be fed group by group from SQL (streaming) without rewriting the resolve and apply code.

**Evidence for "same entity"** (each signal gets a weight and they add up to a confidence score):

- Agreement between services:
  - Genius `appleMusicId` equals the iTunes `trackId`.
  - SoundCloud and Genius `soundcloudUrl` point to the same track.
  - Two services report the same ISRC.
- Metadata: normalized title, primary artist, album, track number, `duration_ms` within tolerance, explicitness, release date.
- Audio: distance between the two tracks' feature vectors (§3), when both have been analyzed.
- Where an ID came from doesn't change its weight. **IDs submitted by clients are trusted as much as IDs the server found itself.**

**Decisions (conservative: only hard evidence is applied automatically)**

- **Automatic merge** only on hard evidence:
  - the same external ID is reported by **two independent services** (for example, Genius `appleMusicId` equals the iTunes `trackId` on the other row); or
  - the **same ISRC** plus `duration_ms` within ±3 s; or
  - the same external ID value (a unique column) is claimed by both rows, and their metadata doesn't contradict that.
- **Automatic split** only on hard evidence: the external IDs attached to one Illusi ID resolve to service entities whose metadata clearly disagrees. For example, different ISRCs plus different titles, or a duration gap of more than 10 s.
- **Everything else** (metadata-only or audio-only similarity, weak or mixed signals) → never applied automatically. The conflict is marked `deferred` and an **admin review item** (§11) is created with the proposed plan.
- **Low confidence** (signals contradict each other) → `dismissed`. Keep the existing link.
- The evidence list above is still computed and attached to every review item, so admins can see why a case was raised.

**Merge**

- Pick the survivor: the one with more user data or more filled columns, or the older one if tied.
- Merge the `service_ids_table` columns.
- Point every foreign key that references the loser at the survivor. That covers `tracks_table`, `albums_table`, and `artists_table` IDs and everything that references them: `user_tracks_table`, `playlist_tracks_table`, `track_plays_table`, `track_lyrics_table`, `track_lyrics_lookups_table`, `track_sample_data_table`, `track_sample_lookups_table`, `track_vectors_table`, `media_table`, `album_tracks_table`, `artist_albums_table`, `tracks_artists_table`, `tracks_producers_table`, `similar_artists_table`, `itunes_lookups_table`, and `thumbnails_table` (its `id` has no foreign key, so it has to be updated explicitly).
- When a composite primary key collides (for example, the same user has both tracks in their library), merge the two rows into one. Keep the earliest `created_at` and the union of flags such as playlist membership.
- Write `illusi_id_redirects_table (old_id → new_id)`, so clients holding the old ID still resolve. API reads follow redirects.

**Split**

- Create a new `service_ids_table` row and Illusi entity.
- Move the misattributed external IDs and their service data onto it.
- User data stays on the original entity, unless it is clearly tied to the moved external ID.

**Safety**

- Every merge and split runs in one transaction and is written to an append-only audit log, with enough detail to undo it.
- Only one instance runs at a time (`pg_try_advisory_lock`).
- A dry-run mode reports what it *would* do.
- Confidence thresholds can be configured.

### 4.6 Decided

- The job runs as a **separate worker**.
- Client-submitted IDs carry the **same weight** as IDs the server found.
- The full pass groups everything, resolves each group in memory, and applies only the hard-evidence steps. Everything else goes to the admin review list (§11).
- In memory for now, built so it can be switched to streaming later.

---

## 5. SoundCloud Ingest (client-submitted)

When a local user searches or browses SoundCloud, the client is **encouraged
but not required** to send the raw SoundCloud objects it saw. Nothing depends
on these submissions. They just add to the SoundCloud tables. Clients send them
on their own initiative. The server doesn't need to ask with an action (§0.1),
though a `SUBMIT_SOUNDCLOUD`-style action could be added later for targeted
requests.

Payload shapes follow lib-origin's `@origin/soundcloud/types/Search`: `User`, `Track`, `Playlist`, and `Track0`, the stub form that only has an `id`.

### 5.1 Endpoint

- `POST /ingest/soundcloud`. Requires an authenticated user. Rate limited per user.
- Body: `{ "items": [ ... ] }`, a mixed array of SoundCloud objects told apart by `kind` (`user` | `track` | `playlist`). Raw `collection` arrays from search, likes, and history can be passed through as they are. Wrapper objects (`LikedTrack`, `HistoryTrack`) are unwrapped to their `track`.
- Returns `202 Accepted` right away, with counts of accepted and rejected items. Processing happens in the background, so client searches never wait on it.
- Limits: a maximum body size and a maximum item count per request. Unknown `kind` values and malformed items are dropped one by one, without failing the whole batch.

### 5.2 Flattening

Nested objects are pulled out into their own rows:

- `track.user` and `playlist.user` (which can be one object or an array) → users.
- `playlist.tracks[]` → tracks. Full `Track1` objects are inserted. `Track0` stubs only give membership, since they have no title.
- `track.media.transcodings[]` → transcodings.
- `track.publisher_metadata` → columns on `soundcloud_tracks_table`. Mapping:
  - `artist` → `publisher_artist`
  - `album_title`, `release_title`, `isrc`, `upc_or_ean`, `explicit`, `contains_music`, `p_line`, `c_line` → the columns with the same names

### 5.3 Upsert rules

- **Write order**, in one transaction per request: users → tracks → transcodings → playlists → playlist_tracks. This keeps the foreign keys satisfied.
- **Key**: SoundCloud `id` for every entity. Transcodings use `url`.
- **Never null out existing data.** Updates use `COALESCE(excluded.col, existing.col)`, so a partial object (a stub, or a search result missing fields) can't erase fuller data that's already stored.
- **Don't apply stale data.** If the incoming `last_modified` is older than the stored `soundcloud_last_modified`, skip the descriptive fields. Volatile counters (`playback_count`, `likes_count`, `followers_count`, ...) are always updated to the newest values seen.
- **Playlist membership**:
  - If `tracks.length === track_count` (the list is complete), replace the membership with exactly that set, with `position` set to the array index.
  - Otherwise, only add rows for the tracks present. Never delete.
  - Stub tracks with no `soundcloud_tracks_table` row are skipped (the foreign key needs one). They get filled in the next time that playlist is submitted after the tracks are known.
- **Transcodings**: upsert by `url`, and store every URL that's submitted. If a track arrives with a `media` block, delete that track's transcodings that aren't in the new set.
  - **Schema change**: add `last_seen_at timestamptz` to `soundcloud_transcodings_table`. It's set every time the URL appears in a submission.
  - Transcodings older than `SC_TRANSCODING_STALE_AFTER` (configurable) are treated as stale by anything that uses them, and get refreshed by later submissions.
- **Field limits**: values longer than their `varchar` columns are truncated and logged, not rejected.
- **Field mapping**:
  - `created_at` → `soundcloud_created_at`
  - `last_modified` → `soundcloud_last_modified`
  - `badges.*` → `badge_*`
- **Enrichment** (§4): if `soundcloud_id` is already linked to an `illusi_id`, add `soundcloud_permalink` from `permalink_url` and `isrc` from `publisher_metadata.isrc`.

### 5.4 Trust (decided)

- A valid logged-in session (§12) **is** the attestation for SoundCloud submissions. There are no per-search tokens.
- Data from an authenticated user is trusted. There are no server-side spot checks.
- Rows can still be traced through the provenance log (§9.5), and anything disputed goes to admin review (§11).

---

## 6. Genius Ingest (lyrics fallback)

The client asks for lyrics (the full lyrics API comes later). The server checks
its own data first. If it has nothing, it tells the client to check Genius, and
the client sends back everything Genius returned.

### 6.1 Flow

1. **Client** requests lyrics for an Illusi `track_id` (§7).
2. **Server** runs its own lyrics services first (§7). If they find nothing and Genius hasn't been tried recently, the response includes a client action (§0.1): `{ "lyrics": null, "actions": [{ "type": "CHECK_GENIUS", "token": "...", "track_id": "...", "query": "<artist> <title>" }, ...] }`.
3. If the client looked on Genius and found nothing, it reports that with `{ token, track_id, result: "NOT_FOUND" }`, so the attempt is recorded (§7.3).
4. **Client** (optionally) runs `Genius.search_songs` and `Genius.get_lyrics` (lib-origin). It then calls `POST /ingest/genius` with `{ token, track_id, preloaded_state }`, the full `LyricsPreloadedState`. The token is checked as described in §0.2, and `track_id` must equal the token's target.
5. **Server** checks and stores the payload (6.2–6.4), then returns the lyrics.

### 6.2 Verification

- `preloaded_state.songPage.song` must be a key in `entities.songs`.
- **Match the Genius song to the track before linking anything.** Many Genius songs have no `appleMusicId`, so the match is tried in this order:
  1. **ID match (strong)**: **any** cross-service ID from the Genius song equals the same column in the track's `service_ids_table` row. One match is enough. The IDs checked are:
     - `genius_id`
     - `appleMusicId` → `applemusic_id`
     - `spotifyUuid` → `spotify_id`
     - `youtubeUrl` → `youtube_id`
     - `soundcloudUrl` → `soundcloud_permalink`
     - every `media[]` entry by `provider`
  2. **Metadata match**, if there's no ID match:
     - normalized **title** and **primary artist**, each with similarity ≥ 0.9 (same normalization as §1.2); and
     - **album**, if both sides have one; and
     - **duration**, if Genius provides one (for example on a `media[]` entry), within ±3 s.
  3. **No match**: return `422`. Genius entities may still be stored, but no lyrics are linked and no service IDs are written. A review item (§11) is created.
- **Lyrics come from `songPage.lyricsData.body` only.** Never trust a lyrics string sent by the client. The raw body is stored as it is (6.3 step 7). The server parses it to check it and to serve it, but a parse failure **doesn't stop storage**. See §7.1, raw-first storage.
  - This needs lib-origin to export its `parse_preloaded_state_lyrics`, which is currently private to the `Genius` namespace.
- Limits: a maximum body size (the preloaded state can be hundreds of KB). The server ignores keys it doesn't use.

### 6.3 Writes

Everything is written in one transaction, in this order:

1. `entities.users` → `genius_users_table`. `avatar.medium.url` goes into `avatar_url`.
2. `entities.artists`, plus `primaryArtist`, `featuredArtists`, `writerArtists`, and `producerArtists` from the song → `genius_artists_table`.
3. The song → `genius_songs_table`.
   - `primaryArtist.id` → `primary_artist_id`
   - `lyricsOwnerId` → `lyrics_owner_id`
   - `description.markdown` → `description`
   - `stats.hot` / `stats.pageviews` → `hot` / `pageviews`
   - `appleMusicId`, `spotifyUuid`, `youtubeUrl`, `soundcloudUrl` → the columns with matching names
4. `genius_song_artists_table`: `primaryArtists` → `PRIMARY`, `featuredArtists` → `FEATURED`, `producerArtists` → `PRODUCER`, `writerArtists` → `WRITER`.
5. `entities.referents` → `genius_referents_table`.
   - Some referents are stubs (only `id`, `classification`, `fragmentId`). They get `song_id = songPage.song` and are upserted with `COALESCE`, so they never overwrite fuller rows.
6. `entities.annotations` → `genius_annotations_table`.
   - `referentId` → `referent_id`
   - `createdBy` → `created_by_id`
   - `body.markdown` → `body_markdown`
   - `createdAt` → `genius_created_at`
7. `track_lyrics_table`: `service = 'GENIUS'`, `sync_type = 'NONE'`, `format = 'GENIUS_BODY_JSON'`, `raw_content` = `JSON.stringify(songPage.lyricsData.body)`. This is the raw, unparsed body. Instrumental songs get no lyrics row. Duplicates follow 6.5.
8. `tracks_producers_table`: `producerArtists` for this track.
9. Enrichment (§4) on the track's `illusi_id`: `genius_id` = the song `id`, plus the song's Spotify, YouTube, and SoundCloud IDs.
   - **Upsert every other ID Genius returns.** Genius can include other kinds of IDs and links: `media[]` providers, `appleMusicPlayerUrl`, artist IDs on `primaryArtist` / `featuredArtists`, and any new provider that appears.
   - Every one that maps to a `service_ids_table` column is enriched on the track, or on its artists for artist IDs.
   - Unknown providers are logged, so new columns can be added for them later.
10. **Apple Music ID** (only when Genius provides `appleMusicId`):
    - **Track has no `applemusic_id`**: set it, but only after the match in 6.2 passed. Then queue the track on the iTunes fast path (§1.4), so the full iTunes data (`itunes_*` tables, preview, artwork, explicitness) still gets fetched. The Genius ID only replaces the *search*, not the iTunes fetch.
    - **Track already has the same `applemusic_id`**: this strongly confirms the link. Nothing to write.
    - **Track has a different `applemusic_id`, or the ID belongs to another `illusi_id`**: record a conflict (§4.4) for the reconciliation job. Don't touch either row.

- **Upserts**: every Genius entity is upserted by its Genius `id`, using the "never null out" `COALESCE` rule from §5.3.
- **Format conversions**:
  - Genius timestamps (`lyricsUpdatedAt`, `updatedByHumanAt`, `createdAt`) are epoch seconds. Convert them to `timestamptz`.
  - `releaseDate` (`YYYY-MM-DD`) goes into the `date` column.
- **Entity maps**: they're `Record<id, T>`. The lib-origin types were generated from one sample page (`N8708949`, ...), so the API should use generic `Record<string, T>` types.

### 6.5 Lyrics duplicates and choosing the best version (applies to all lyrics services)

- **No exact duplicates.** Add `content_hash` to `track_lyrics_table`: a SHA-256 of the exact `raw_content`. Add a unique index on `(track_id, content_hash)`. Re-submitting identical lyrics does nothing.
- **Keep versions that differ even slightly**, from any service. Multiple rows per `(track_id, service)` are allowed.
- **Serving**: the lyrics API returns the *best* row for each track, chosen by a pluggable `rank_lyrics()` function. The real metric comes later.
  - Placeholder order: richer `sync_type` first (`SYLLABLE` > `WORD` > `LINE` > `NONE`), then newest.
  - Ranking happens when lyrics are read, not stored, so changing the metric never needs a data migration.
  - Only rows that **parse successfully** can be chosen. If the top row fails to parse, the next one is used (§7.1).

---

## 7. Lyrics Service

### 7.1 Services

| Service | Who fetches | lib-origin client | Typical output → `sync_type` |
| --- | --- | --- | --- |
| `BINILYRICS` | Server | `BiniLyrics.get_lyrics` | TTML → `WORD`/`SYLLABLE` (or `LINE`) |
| `GOLYRICS` | Server | `GoLyrics.get_lyrics` | TTML → `WORD`/`SYLLABLE` (or `LINE`) |
| `MUSIXMATCH` | Server | `Musixmatch.find_lyrics` | Richsync → `WORD`, subtitle LRC → `LINE`, plain → `NONE` |
| `LRCLIB` | Server | `LRCLib.get` | Synced LRC → `LINE` (word sync when `hasWordSync`), plain → `NONE`. Also reports `instrumental`. |
| `GENIUS` | Client (§6) | `Genius.get_lyrics` | Plain → `NONE` |
| `YOUTUBE_MUSIC` | Client | YouTube Music lyrics | Plain or `LINE` |

- **Store everything each service returns.** If a service returns more than one version (Musixmatch: plain, synced, and richsync), each is its own row. Exact duplicates are removed using `content_hash` (§6.5).
- Each lyrics service gets the same inputs from the track: title, primary artist, album, and `duration_ms`, converted to seconds where the service expects it.

**Raw-first storage**

`raw_content` is always the **raw, unparsed data exactly as the service returned it**. If a parser breaks or the service changes its format, we still have the data. Once the parser is fixed, it can be re-parsed and served without fetching it again.

| Service | What `raw_content` holds | `format` |
| --- | --- | --- |
| BiniLyrics / GoLyrics | The TTML document | `TTML` |
| Musixmatch | `richsync_body` (JSON), `subtitle_body` (LRC), `lyrics_body` (plain) | `MXM_RICHSYNC_JSON` / `LRC` / `PLAIN` |
| LRCLib | `syncedLyrics` (LRC or enhanced LRC), `plainLyrics` | `LRC` / `ELRC` / `PLAIN` |
| Genius | `songPage.lyricsData.body` (JSON) | `GENIUS_BODY_JSON` |
| YouTube Music | The lyrics payload as the client received it | `YTM_JSON` / `PLAIN` |

- **Schema change**: add a `format` column (an enum) to `track_lyrics_table`. A parser has to know what it's reading, and guessing from `service` + `sync_type` won't hold up as formats multiply.
- **Parse on read**: the server parses rows into one shared lyrics structure (lines → words/syllables with timings) and gives that to clients. Clients never receive the raw content.
  - An optional `parsed_cache` column (jsonb) can be filled in and thrown away at any time. It's cleared when the parser version changes.
- **Parse failures**: the row is kept, the failure is logged with its service and format, and serving falls back to the next-ranked row that parses. A parse failure **doesn't** change the lookup status. The service did find lyrics.
- **Storing must not depend on parsing**: lib-origin's `get_lyrics` helpers parse the TTML before returning. The server must still get and store the raw TTML even when `parse_ttml` fails. Use the lower-level calls (`get_ttml`) or make the helpers return the raw data when parsing fails.

### 7.2 Request flow: `GET /tracks/:id/lyrics`

1. **Stored lyrics first.** If any `track_lyrics_table` rows exist, return the best one (`rank_lyrics()`) right away.
   - **Recheck on request**: if a server service is due for a recheck (7.3), start a **background** recheck of the services that are due. The response doesn't wait for it. Better lyrics found this way are stored and reach the client on its next request or sync.
2. **Otherwise, query the server services in parallel**: BiniLyrics, GoLyrics, Musixmatch, and LRCLib. Only query a service that hasn't been tried recently (7.3).
   - Each service has its own timeout. The response waits for **all** services to finish or time out, never longer than the overall deadline.
   - **One lookup per track at a time.** If two users ask for the same track at once, they share one lookup instead of starting two.
   - Each service's own rate limits and cooldowns are respected. Musixmatch has a captcha cooldown, and LRCLib has `Retry-After`. A service that is cooling down is skipped and recorded as `SKIPPED`, not `NOT_FOUND`.
3. **Store** every result that came back, plus a lookup record for every service that was queried, found or not (7.3).
4. **If anything was found**: return the best result.
5. **If nothing was found**: return `{ "lyrics": null }`. Include actions **only if every server service has a current `NOT_FOUND`**.
   - If any server service is `ERROR` or `SKIPPED`, send no actions. Those services get retried after their short wait, on a later request.
   - When actions are sent, include `CHECK_GENIUS` and/or `CHECK_YOUTUBE_MUSIC` only for client services that haven't been tried recently.
   - If LRCLib reports `instrumental`, or the linked Genius song is instrumental, return `{ "instrumental": true }` and send no actions.

### 7.3 Lookup records (always written)

Every attempt is recorded, **including failures to find anything**, so we know
whether to ask a service again or skip it. `track_lyrics_table` can't hold
these records because `raw_content` is `NOT NULL`, so they go in a new table:

`track_lyrics_lookups_table`

| Column | Notes |
| --- | --- |
| `track_id` | Foreign key to `tracks_table`, on delete cascade |
| `service` | `lyrics_services` enum |
| `status` | `FOUND` / `NOT_FOUND` / `INSTRUMENTAL` / `ERROR` / `SKIPPED` |
| `attempted_at` | |
| `retry_after` | When this service may be asked again for this track |
| `source_user_id` | Set when the attempt was made by a client (Genius, YouTube Music) |

- Primary key is `(track_id, service)`. Each new attempt overwrites the row.
- **Rechecks only happen when a user requests lyrics.** There's no periodic background job. A request rechecks a service only if its last attempt is older than its wait (all configurable):
  - `FOUND` and `NOT_FOUND`: `LYRICS_RECHECK_AFTER` (default **14 days**). Services keep adding and improving lyrics, so a track requested again after a couple of weeks gets rechecked.
  - `INSTRUMENTAL`: never.
  - `ERROR` or `SKIPPED`: minutes, with backoff.
- Sync (§8) doesn't count as a user request for rechecks. It only queues lookups for tracks that have **never** been looked up.
- Client services are recorded through their ingest endpoints. A `result: "NOT_FOUND"` submission records `NOT_FOUND`, and it still has to pass the token checks in §0.2.

### 7.4 YouTube Music ingest

- `POST /ingest/youtube_music_lyrics`. Body: `{ token, track_id, youtube_id?, lyrics?, result? }`. Token checks follow §0.2.
- Stored as `service = 'YOUTUBE_MUSIC'`, with `sync_type` taken from the payload: `LINE` if timed, otherwise `NONE`.
- A `youtube_id` in the payload goes through enrichment (§4) on the track.


---

## 8. User Sync (local-first, pull then push)

Clients keep a local-first database. **Everything that concerns the user is
synced.** A sync is always a **pull** followed by a **push**:

1. **Pull**: the client gets everything that changed on the server since its last cursor.
2. **Resolve locally**: the client merges that into its local database. Most conflicts go to the server, with the exceptions in 8.4.
3. **Push**: the client sends its local changes, based on the cursor it just pulled.

### 8.1 What's in scope

**Data the user owns.** The user's version is the one that counts.

- User profile: `users_table`, except `password_hash`, which is never synced.
- `user_tracks_table`: the user's library, including the user's own `title` for a track, `start_at` / `end_at`, `downloaded_at`, and `deleted`.
- `playlists_table`, `playlist_tracks_table`, `playlist_inherited_searches_table`, `playlist_inherited_playlists_table`.
- `linked_playlists_table`: the user's list of linked external playlists, as service URIs. The external playlists themselves can't be modified through Illusi. The server has **no behavior** for them: it doesn't fetch, mirror, or resolve them. It only stores and syncs the list, like any other user-owned row.
- `track_plays_table`, `user_recent_searches`.

**Shared data for every track the user touches.** This covers library tracks, playlist tracks, and tracks reached through inherited playlists. Inherited playlists are always the user's own (§10).

- `tracks_table`, `albums_table`, `artists_table`, and the join tables (`tracks_artists_table`, `album_tracks_table`, `artist_albums_table`, `tracks_producers_table` → Genius artist names).
- **All service IDs**: every `service_ids_table` column for those tracks, albums, and artists.
- **Best lyrics only**: one row chosen by `rank_lyrics()`, **already parsed** (§7.1), or `instrumental: true`.
- `track_sample_data_table`.
- Selected iTunes fields: artwork, `explicitness`, release date, genre.
- `thumbnails_table` rows for those tracks, albums, and artists (§14).

**Housekeeping**

- `illusi_id_redirects_table` entries (§4.5) that affect any of the above.

### 8.2 Pull: `POST /sync/pull`

- Body: `{ cursor?: string }`. Leave `cursor` out for a full pull.
- Response:
  - **`redirects`**, listed first. The client must rewrite local IDs from `old_id` to `new_id` before applying anything else.
  - **Changed rows** for everything in 8.1 since `cursor`, with soft-deletes shown as `deleted` flags.
  - **`next_cursor`** / **`has_more`**: results come in pages.
  - **`actions`** (optional, §0.1): for example `CHECK_GENIUS` for tracks where every server lyrics service returned `NOT_FOUND` (§7.2).
- **Never waits on external services.** For tracks that have never been looked up, it **queues** background lyrics, iTunes, and analyzer work.
- **Consistent snapshot**: each page is read in one `REPEATABLE READ` transaction. The cursor holds the database time at the start of the snapshot.
- **What counts as changed**: a row is included if it, or any related row, has `modified_at` / `created_at` after the cursor. This needs indexes on `modified_at`.

### 8.3 Push: `POST /sync/push`

- Body: `{ push_id, base_cursor, changes }`.
  - `push_id` is a UUID generated by the client, so a retried push is only applied once.
  - `base_cursor` is the cursor from the pull this push is based on.
- **A push is never rejected for being stale.** The per-field rules in 8.4 decide what gets applied. Once the push is applied, the response returns the **authoritative values** of every row it touched, and the client overwrites its local copy with them.
  - `base_cursor` is still sent. If the push references an `illusi_id` that was merged away after that cursor, the server resolves it through `illusi_id_redirects_table` and returns the redirect.
- **New local entities** (artists, albums, tracks, and their relations) are processed by the same engine as contributions (§9). They're matched against existing entities first, then created if there's no match. The response includes a `{ temp_id → illusi_id }` map, and the client rewrites its local IDs from it.
- Any service IDs the client sends go through enrichment (§4): only empty columns get filled, and conflicts are recorded. Client IDs carry the same weight as server ones.
- **Append-only rows**: plays and recent searches need client-generated UUIDs so a re-push doesn't duplicate them.
  - **Schema change**: add a `client_id uuid unique` column to `track_plays_table` and `user_recent_searches`.
- The whole push is applied in one transaction. The response includes the new cursor, so the client doesn't need to pull again just to see its own writes.

### 8.3a Initial import and ID resolution

Clients are local-first, so a client may already hold a large local database
before it ever syncs, for example on first login or after a migration from an
older version. Everything in it, and especially **an `illusi_id` for every
local entity**, has to get into the server reliably.

- **Bulk import goes through push**: the client sends its whole local database through `/sync/push` in **chunks** (for example up to 500 entities per push).
  - Dependencies go first: artists → albums → tracks → relations → user-owned rows (library, playlists, plays, ...).
  - Each chunk has its own `push_id`, so it's idempotent and safe to retry.
- **Resumable**: every chunk's response returns its `{ temp_id → illusi_id }` map. The client saves that map locally **before** sending the next chunk. If the import is interrupted, it carries on from the first chunk that isn't confirmed. Nothing is duplicated, because chunks are idempotent and entities are matched (§9.2).
- **No duplicates of global entities**: local entities are matched against existing ones by their service IDs and metadata (§9.2). A track the server already knows gets its **existing** `illusi_id`. A new one is created only if there's no match.
- **The client stores `illusi_id`** alongside its own local ID for every entity, and uses `illusi_id` in every later request.
- **`POST /resolve`**: a read-only lookup that creates nothing.
  - Body: `{ items: [{ ref, type: 'track' | 'album' | 'artist', service_ids?, title?, artist?, album?, duration_ms? }] }`.
  - Returns `{ [ref]: illusi_id | null }`, using the same matching as §9.2 and following redirects.
  - Lets a client find IDs for things it only knows by service ID, without importing them.
- **Progress**: the import endpoint reports the counts processed, so the client can show progress for a large first import.

### 8.4 Conflict rules (the client follows them, and the server enforces them too)

| Data | Who wins |
| --- | --- |
| **Data the user owns** (8.1) | **Last write wins.** Each pushed row carries the client's edit timestamp (`edited_at`), and the server applies it only if it's newer than the stored one. This includes the user's own `user_tracks_table.title` for a track, and soft deletes. |
| **Shared data, server field empty (`NULL`)** | **First write wins.** Whichever client (or device) pushes first fills it. Later different values follow the next row. |
| **Shared data, server already has a value** | **The server.** A different client value isn't applied. It's flagged for admin review (§11). For `service_ids_table` it's recorded as a conflict (§4.4) for the reconciliation job. Only admins can change the value. |
| **Derived data** (lyrics, sample data, vectors, iTunes rows, redirects) | **Always the server.** It's read-only for clients. Lyrics come in only through the ingest endpoints. |

- The server checks every pushed field against this table. It doesn't trust the client to have resolved conflicts correctly.
- Soft deletes (`deleted = true`) in data the user owns follow last-write-wins like any other update. They're never physical deletes.

### 8.5 Multiple devices

- **Shared data**: the first device to push becomes the source of truth. Later devices see that value on their next pull, and their different values are handled by the "server already has a value" rule.
- **Data the user owns**: last write wins, using the client's `edited_at`.
  - Clamp `edited_at` to the server's current time, so a device with a clock set in the future can't win every conflict.
  - **Schema change**: the user-owned tables (`user_tracks_table`, `playlists_table`, `playlist_tracks_table`, `playlist_inherited_*`, `linked_playlists_table`) need an `edited_at timestamptz`. It's separate from `modified_at`, which is the server write time and is used for pull cursors.

- **Granularity (decided)**: last write wins at the **row level**. The newer `edited_at` replaces every user-owned column of that row. Example: if device A renames a track and device B later sets its `start_at` from an older copy of the row, B's whole row wins, so A's rename is lost. That's accepted.

---

## 9. Global Data Contributions (client-submitted)

Clients fetch music data on their own side, and they're expected to keep
sending it to us to grow and correct the **global** database. These endpoints
are open to any logged-in user, under the attestation rules in §0.2.

### 9.1 Endpoints

- `POST /contribute`: one endpoint that takes a **graph** of entities and relations in a single payload.
- Covered tables: `artists_table`, `albums_table`, `tracks_table`, `tracks_artists_table`, `album_tracks_table`, `artist_albums_table`, `similar_artists_table`, and `service_ids_table` (through each entity's `service_ids`).
- More tables can be added as the schema grows. Service-specific raw data keeps its own ingest endpoints (SoundCloud §5, Genius §6, YouTube Music lyrics §7.4).

```ts
interface ContributionPayload {
	contribution_id: string;            // client UUID, so a retry is only applied once
	artists?: { ref: string; name: string; description?: string; primary_genre_name?: string; service_ids?: ServiceIds; thumbnails?: Thumbnail[] }[];
	albums?:  { ref: string; name: string; artist_ref?: string; album_type?: AlbumType; release_date?: string; track_count?: number; explicit?: boolean; service_ids?: ServiceIds; thumbnails?: Thumbnail[] }[];
	tracks?:  { ref: string; title: string; album_ref?: string; duration_ms?: number; explicit?: boolean; imported?: boolean; service_ids?: ServiceIds; thumbnails?: Thumbnail[] }[];
	relations?: {
		tracks_artists?:  { track_ref: string; artist_ref: string }[];
		album_tracks?:    { album_ref: string; track_ref: string; track_number?: number }[];
		artist_albums?:   { artist_ref: string; album_ref: string; position?: number }[];
		similar_artists?: { artist_ref: string; similar_artist_ref: string }[];
	};
}
// a ref is either a temporary ID local to this payload, or an existing illusi_id
type ServiceIds = Partial<Record<'youtube_id' | 'spotify_id' | 'soundcloud_id' | 'soundcloud_permalink' | 'amazonmusic_id' | 'applemusic_id' | 'bandlab_id' | 'audiomack_id' | 'deezer_id' | 'pandora_id' | 'tidal_id' | 'genius_id' | 'isrc', string | number>>;
interface Thumbnail { url: string; width?: number; height?: number }   // lib-origin IllusiveThumbnail
```

- Response: `{ refs: { [ref]: illusi_id }, created: [...], matched: [...], conflicts: [...] }`.

### 9.2 Matching (avoid creating duplicates)

For each entity in the payload, the server looks for an existing entity in this order:

1. **The ref is already an `illusi_id`**: use it, following redirects if it was merged.
2. **Service ID match**: any value in the entity's `service_ids` already exists in `service_ids_table` (for example `applemusic_id`, `spotify_id`, `isrc`). If the IDs point at **more than one** `illusi_id`, take the best match and record a conflict (§4.4).
3. **Strong metadata match**:
   - Tracks: normalized title, primary artist, album, and duration within tolerance.
   - Albums: name and artist.
   - Artists: name, plus a shared album or track.
4. **No match**: create a new `service_ids_table` row and the entity.
   - An unclear metadata match also counts as no match. Create the entity and record a conflict, so the reconciliation job (§4.5) can merge it later if needed.

### 9.3 Write rules

- Writes go in foreign-key order: artists → albums → tracks → `service_ids_table` enrichment → relations. Everything is in one transaction per contribution.
- **Entity fields**: shared-data rules apply (§8.4). Empty fields are filled in, first write wins. A different value for a field that already has one isn't applied. It's **flagged for admin review** (§11) with both values. Service IDs go through enrichment (§4).
- **Relations only ever add.** Contributions add relations and fill empty relation fields (`track_number`, `position`). They **never** delete relations or entities. Deleting global data is only done by the reconciliation job and admin tools.
  - `similar_artists_table` grows as the union of everything submitted. The `artist ≠ similar_artist` check is enforced.
  - **Similarity goes both ways.** A → B means B is also similar to A.
    - **Store pairs exactly as submitted.** A pair may end up as one row (A → B) or two (A → B and B → A), depending on what users send. The server never adds the reverse row itself, and both forms mean the same thing.
    - **Queries look in both directions**: `WHERE artist_id = $1 OR similar_artist_id = $1`, returning the *other* artist, with duplicates removed (`DISTINCT`). That way one row and two rows give the same result.
    - The reverse direction needs its own index. `similar_artists_similar_artist_id_idx` already exists.
- **Pipelines**: newly created entities enter the normal pipelines.
  - The iTunes queue (§1.4), unless the track is `imported`.
  - Lyrics lookups (§7) when a user requests them or syncs.
  - The analyzer (§2) once media or a preview exists.
- **Shared engine**: the matching and upsert logic here is the same engine used by sync push (§8.3) for new local entities. There is one implementation.

### 9.4 Limits

- Per-user rate limits.
- A maximum payload size and a maximum number of entities per contribution.
- Field lengths are truncated to their `varchar` limits and logged.
- A malformed entity is rejected on its own, together with any relations that reference it. The rest of the payload is still applied.

### 9.5 Provenance

- New table `contributions_log_table`: `contribution_id`, `user_id`, `received_at`, and for each entity touched, the fields it filled.
- This lets bad data be traced to its user and reverted, and lets heavy abusers be rate limited or blocked.
- The SoundCloud (§5) and Genius / YouTube Music (§6, §7) ingests write to the same log.

---

## 10. Playlists

### 10.1 Inheritance is limited to the user's own playlists

- `playlist_inherited_playlists_table.ref_id` must point to a playlist owned by the **same user** as `playlist_id`. Users can't inherit from other users' playlists, public or not.
- The server enforces this on every write path: sync push and any playlist endpoints. Optionally, a database trigger or check enforces it too.
- **Cycles**: the server must reject inheritance cycles (A → B → A). The existing check only blocks a playlist from inheriting from itself directly.

### 10.2 Copying a public playlist: `POST /playlists/:id/copy`

- Requires an authenticated user. The source playlist must be `public = true` and not `deleted`, or be owned by the caller.
- Creates a **new playlist owned by the caller**, copying `title`, `description`, `sort_mode`, and the source's own `playlist_tracks_table` rows that aren't `deleted`.
- **The copy is a one-time snapshot.** It isn't linked to the source, so later changes to the source don't affect it.
- **Nothing inherited is copied.** No `playlist_inherited_playlists_table` rows, no `playlist_inherited_searches_table` rows, and none of the tracks that only appear in the source through inheritance. Only the source's directly added tracks are copied.
- Defaults on the copy: `public = false`, `pinned = false`, `archived = false`.
- The copied tracks enter the caller's sync scope (§8.1) on their next pull. The response returns the new playlist so the client can insert it locally right away.

- **No attribution.** The copy behaves exactly as if the user had created it themselves. Nothing about the source is stored, and there's no `copied_from` column.
- Custom artwork isn't copied.

### 10.3 Server-side resolution

The server must be able to work out a playlist's **full track list**, including
inheritance. Examples: recommendations (taste vectors, §3.4) and any future web
view.

- **Same rules as the client**: use lib-origin's implementation (`Illusive/src/sql/sql_playlists.ts`) so the server and clients always get the same result:
  1. Start with the playlist's own `playlist_tracks_table` rows that aren't `deleted`.
  2. For each `playlist_inherited_playlists_table` row in order, resolve the referenced playlist recursively. Combine it using the row's `mode` (`tracks_include` / `tracks_exclude` / `tracks_mask` / `tracks_intersection`). Skip any ancestor that's already in the chain (cycle guard), even though cycles are rejected when written (10.1).
  3. For each `playlist_inherited_searches_table` row, run `track_query_filter(<user's library>, query)` with lib-origin's `TRACK_QUERY_FLAGS`. The library is the user's non-deleted `user_tracks_table` tracks. Combine the result using the row's `mode`.
  4. Sort with `sort_playlist_tracks(sort_mode)`.
- **Adapter**: lib-origin's query flags and sorts work on its `Track` type. The server needs one adapter from database rows to `Track`, which joins the user-specific fields the flags and sorts use: the user's title override, `downloaded_at`, plays (`track_plays_table`), and added date.
- **Caching**: results are cached for each user and playlist. The cache is cleared when any of the user's library, playlists, or inheritance rows change. Search-inherited playlists change whenever the library does.
- **lib-origin dependency**: these functions currently live in Illusive's client code, which uses client-side stores and SQLite. They need to be pulled out into pure functions (tracks in, tracks out) that both the client and the server can import.

### 10.4 Custom artwork

A playlist can have its own artwork image instead of the generated cover (the first tracks' thumbnails).

- **Upload**: `PUT /playlists/:id/artwork`, owner only (otherwise `404`). Body is `multipart/form-data`: a `file` part, plus an optional `edited_at` field (ISO time of the edit on the device).
  - Up to `ARTWORK_MAX_BYTES` (default 10 MB). JPEG, PNG or WebP, checked by sniffing the magic bytes (`415` otherwise, `422` if it doesn't decode).
  - Refused with `507` while the disk is below `DISK_MIN_FREE_GB`, like media uploads.
  - Re-encoded with ffmpeg as a JPEG no larger than `ARTWORK_MAX_PX` (default 1024) on its longest side, never upscaled, with every metadata block dropped (EXIF location included).
  - Stored as `MEDIA_DIR/artwork/<uuid>.jpg`. The file name is `playlists_table.artwork_id`. Each upload gets a new id.
- **Removal**: `DELETE /playlists/:id/artwork`, owner only, optional `?edited_at=`.
- **Conflicts**: last-write-wins on its own clock, `playlists_table.artwork_edited_at`, separate from the row's `edited_at`. Artwork changes and playlist row edits never overwrite each other. The device's `edited_at` is clamped to server time like sync pushes (§8.4). An older change is ignored. Both routes answer `{ applied, playlist }` with the stored playlist row either way.
- **Sync**: `artwork_id` and `artwork_edited_at` are columns of the playlist row, so the read API (§16.4) and sync pull (§8.2) return them. Sync push never writes them.
- **Download**: `GET /artwork/:artwork_id`. Allowed for the owner, or anyone while the playlist is public and not deleted (`404` otherwise). The id never changes for the same file, so the response is cached forever (`ETag` = the id, `Cache-Control: private, max-age=31536000, immutable`). Behind nginx the file is served through `X-Accel-Redirect`, like media.
- **Files**: a replaced or removed image's file is deleted after commit. Artwork files are backed up like media.

---

## 11. Admin Review & Corrections

Corrections to global data are made **only by admins**. Anything that might be
wrong is collected in one review list for admins to work through.

### 11.1 Admin role

- **Schema change**: add `role` to `users_table` (enum `USER` / `ADMIN`, default `USER`).
- All `/admin/*` endpoints require `role = 'ADMIN'`.
- Admin edits are the **only** way to overwrite a field on shared data that already has a value. First write wins (§8.4) doesn't apply to them.

### 11.2 What gets flagged

New table `review_items_table`. A row is added whenever:

- **Contributed value differs**: a contribution, sync push, or ingest sends a different value for a shared field that already has one (§9.3). The flag records the field, the current value, and the proposed value.
- **Service ID conflict**: every merge, split, or ID move the reconciliation job proposed but couldn't apply because it lacked hard evidence (§4.5). The proposed plan and the evidence are attached. Applying the item runs that plan.
- **Lyrics parse failure** (§7.1): a stored lyrics row that doesn't parse.
- **Genius match rejected** (§6.2): a submission that failed the track match.
- **Automatic merge or split** (§4.5): listed for information, with undo through the audit log.

Each row has: `id`, `kind`, `entity_table`, `entity_id`, `field?`, `current_value`, `proposed_values` (jsonb, so several conflicting proposals can be grouped), `source_user_ids`, `occurrences`, `status` (`OPEN` / `APPLIED` / `DISMISSED`), `resolved_by`, `resolved_at`, and timestamps.

- **Deduplicated**: another report of the same `(kind, entity, field, proposed value)` increases `occurrences` and adds the user to `source_user_ids` instead of creating a new row. How many independent users proposed the same correction is a useful signal for admins.

### 11.3 Admin endpoints

- `GET /admin/review`: a paged list that can be filtered by `kind`, `entity_table`, and `status`, and sorted by `occurrences` or age. Each item includes enough context to decide: the entity's current row, its service IDs, and links to the iTunes and Genius data.
- `POST /admin/review/:id/apply`: apply one of the proposed values, or a value the admin types, to the entity.
- `POST /admin/review/:id/dismiss`.
- `PATCH /admin/entities/:table/:id`: a direct correction of any shared entity field, outside the review list.
- Every admin change:
  - bumps `modified_at`, so the correction reaches clients on their next pull (§8.2);
  - is written to the audit log (§4.5) with the admin's ID and the old value, so it can be undone.

### 11.4 Scope

- **API only for now.** The endpoints in 11.3 are the whole requirement.
- **Back burner**: an admin dashboard (web UI) built on top of these endpoints. Not in scope yet. Keep the API responses rich enough that a dashboard could be built later without backend changes.

---

## 12. Authentication

JWT access tokens plus rotating refresh tokens. Every "logged-in" or "attested"
requirement in this document refers to this section.

### 12.1 Endpoints

- `POST /auth/register`: `{ username, email, password }`.
  - The email is lowercased, as the existing check constraint requires.
  - The password is hashed with **argon2id** into `password_hash`.
- `POST /auth/login`: `{ email, password, device_name? }` → `{ access_token, refresh_token }`.
- `POST /auth/refresh`: `{ refresh_token }` → a new `{ access_token, refresh_token }` pair (rotation).
- `POST /auth/logout`: revokes the current refresh token. `POST /auth/logout_all` revokes every session for the user.

### 12.2 Tokens

- **Access token**: a signed JWT that expires after about 15 minutes. Claims: `sub` (user_id), `role`, `sid` (session id), `iat`, `exp`. Sent as `Authorization: Bearer <token>`.
- **Refresh token**: 256 random bits, opaque. Expires after about 60 days (configurable).
  - Only its hash is stored, in a new `sessions_table`: `id`, `user_id`, `token_hash`, `device_name`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`, `replaced_by`.
- **Rotation with reuse detection**: every refresh issues a new refresh token and revokes the old one. If an already-used refresh token is presented again, it may have been stolen, so **every session in that chain is revoked**.
- **Action tokens (§0.2)** are signed with a **separate key** from access tokens. They also carry `sid`, so revoking a session also invalidates the action tokens issued to it.
- **Admin endpoints** re-check `role` in the database, not only the JWT claim. That way, removing someone's admin role takes effect immediately.

### 12.3 Protection

- Login and register are rate limited per IP and per email. Failed logins get progressively slower.
- Every endpoint is authenticated except `/auth/register`, `/auth/login`, and `/auth/refresh`.
- **Out of scope for now**: password reset, email verification, OAuth / social login.
- **Deleted accounts**: access tokens are stateless, so `require_auth` also checks that the user still exists. A user seen recently is cached for up to a minute. Deletion removes them from that cache in every API process at once (a Postgres `NOTIFY`), so their tokens stop working immediately.

### 12.4 Data export

- `POST /me/export` starts an export of everything the server holds about the caller, and answers `202` with the job: `{ id, status, created_at, started_at, finished_at, expires_at, size, error }`.
  - One export can be `PENDING` or `RUNNING` per user. Asking again meanwhile answers `409` with `{ error, export }`.
  - After one that didn't fail, the next can be requested once `EXPORT_COOLDOWN_HOURS` (default 24) have passed. Earlier answers `429` with `{ error, export, retry_after_s }` and a `Retry-After` header.
- `GET /me/export/:id` returns the job; poll it until `status` is `READY` (or `FAILED`). `GET /me/exports` lists the caller's latest 20.
- `GET /me/export/:id/file` downloads it once `READY`: `application/gzip`, `Content-Disposition: attachment; filename="illusi-export-<date>.json.gz"`. `409` before it's ready, `410` once expired.
- Another user's export is a `404`.
- **Contents**: one gzipped JSON document: `{ format: "illusi-export", version, exported_at, user, sessions, library, playlists, linked_playlists, plays, recent_searches, unavailable_reports, media_uploads, contributions, tracks }`.
  - Sessions are listed without any token material.
  - Each playlist carries its `tracks`, `inherited_searches` and `inherited_playlists`.
  - `tracks` maps every track id mentioned anywhere in the file to its read-API view (§16.2), so the file can be read on its own.
- **Jobs** live in `export_jobs_table` (status `PENDING | RUNNING | READY | FAILED | EXPIRED`), so they survive restarts.
  - One API process runs them, the holder of the `exports` advisory lock, whether or not `BACKGROUND_SERVICES` is on.
  - A job left `RUNNING` by a process that died is queued again.
  - A job that fails, or finds the disk below `DISK_MIN_FREE_GB`, ends `FAILED` with a short `error`.
- **Files** are written to `MEDIA_DIR/.exports/<id>.json.gz`, which is never served directly and never backed up.
  - Ready exports expire after `EXPORT_TTL_DAYS` (default 7). An hourly cleanup removes expired files and anything without a ready job.
  - Finished job rows are forgotten after 30 days.

### 12.5 Account deletion: `DELETE /me`

- Body `{ password }`. The password is required again even with a valid session.
- Rate limited per user (5 per 15 minutes) and per IP. A wrong password is a `401`. Success is a `204`.
- One transaction:
  - **Deleted**: the user row, and with it every personal row through its foreign keys: sessions, library, playlists with their tracks and inheritance rows, plays, recent searches, linked playlists, unavailable reports, export jobs and sync push replays. Their used action-token ids are deleted too.
  - **Kept**: what the user added to the shared catalog (artists, albums, tracks, service ids, lyrics, media), with their id removed. `media_table.uploaded_by`, `contributions_log_table.user_id` (now nullable), `service_id_conflicts_table.source_user_id`, the lyrics `source_user_id`s, `audit_log_table.actor_user_id` and the release-check and research `checked_by` become null. The user is removed from review items' `source_user_ids`, including inside `proposed_values`.
  - **Play totals**: they drop by the user's plays.
- After commit their playlist artwork and export files are deleted. Their access and refresh tokens stop working at once (§12.3).
- Playlist artwork already copied to the off-site media backup stays there, because that bucket is append-only (`scripts/backup-media.sh`).

---

## 13. Media Uploads

Rows in `media_table` are created **only by client uploads**.

### 13.1 Endpoint: `POST /tracks/:id/media`

- Authenticated (§12). Body is `multipart/form-data`: a `file` part, plus an optional `quality` field.
- `:id` must be an existing `tracks_table.id`, following redirects if it was merged.

### 13.2 Validation and storage

- **Size**: up to `MEDIA_MAX_BYTES`.
- **Disk space**: with less than `DISK_MIN_FREE_GB` free on the media disk, refuse the upload with `507` before reading the body. Database writes are never refused for disk space.
- **Audio only**: check the type by sniffing the file's magic bytes (for example mp3, m4a/aac, flac, ogg/opus, wav). Don't trust the client's `Content-Type`.
- **Storing the file**:
  1. Stream it to a temp file in `MEDIA_DIR/.incoming/`, computing a SHA-256 along the way.
  2. Convert it with ffmpeg to AAC in an `.m4a` container, at `MEDIA_AAC_BITRATE` (default `256k`). AAC input is remuxed without re-encoding. Only the first audio stream is kept, with `+faststart` so ranged playback starts early. Input ffmpeg can't decode is rejected with `422`.
  3. Rename it atomically to `MEDIA_DIR/<uuid>.m4a`.
  4. `resource_id` = `<uuid>.m4a`.
- **No duplicates**: if this track already has media with the same hash of the **uploaded** bytes, discard the upload and return the existing row.
  - **Schema change**: add `content_hash` to `media_table`, with a unique index on `(track_id, content_hash)`.
- **After insert**: the `media_table` row starts the analyzer (§2.3). The upload is written to the provenance log (§9.5).
- **Never deleted** by the analyzer or any automated job. Only admin tools can remove media.

### 13.3 Downloading media: `GET /media/:resource_id`

- Authenticated. Allowed only if the requesting user has the media's track in their library: a non-deleted `user_tracks_table` row, or the track is in one of their non-deleted playlists. Otherwise `403`.
- Supports HTTP `Range` requests, so clients can stream and resume.

### 13.4 Requesting media from clients

The server asks clients to upload audio they've **already downloaded locally**.
`user_tracks_table.downloaded_at` shows which tracks those are.

- **New action** (§0.1): `{ type: 'UPLOAD_MEDIA', token, track_id }`. It's issued for tracks where:
  - the user's `downloaded_at` is set;
  - the track is `imported` or `backpacked` (§17), or it has lyrics and all of them are unsynced (`sync_type` `NONE`),
    so vocal detection (§2.11) can help line-sync them. Other tracks can still be played from a service, so no copy is
    asked for;
  - the track has **no** `media_table` row yet.
- **Where requests come from**:
  - attached to `/sync/pull` responses, a limited number per pull;
  - `GET /media/requests`, which returns `{ actions: [...] }` with every pending `UPLOAD_MEDIA` request for the user, in pages.
- The upload (`POST /tracks/:id/media`) includes the action `token`, checked as in §0.2. Uploads without a token are still accepted, because uploading is open to any logged-in user.
- As with every action, the client may ignore it. Once any user uploads media for a track, requests stop going out for that track to everyone.
- Backpacked tracks (§17) are requested first.

---

## 14. Thumbnails

`thumbnails_table` (`id`, `url` primary key, `width`, `height`) holds artwork
URLs for tracks, albums, and artists. `id` is the owning entity's `illusi_id`.
The shape matches lib-origin's `IllusiveThumbnail { url, width, height }`.

### 14.1 Sources

| Source | URLs | Size |
| --- | --- | --- |
| iTunes (§1) | `artworkUrl30/60/100/600` | Known (30–600). The URL path has `{w}x{h}bb` in it. |
| SoundCloud (§5) | `artwork_url` for tracks and playlists | `-large` = 100×100. The `-t500x500` variant can be derived from it. |
| Genius (§6) | Song `songArtImageUrl` / `headerImageUrl`, artist `imageUrl` / `headerImageUrl` | Unknown → `NULL` |
| YouTube | Derived from `youtube_id`: `i.ytimg.com/vi/<id>/{default,mqdefault,hqdefault,sddefault,maxresdefault}.jpg` | Known (120×90 … 1280×720) |
| YouTube Music / Google-hosted | `…=w{W}-h{H}` URLs | Read from the URL |
| Clients | `thumbnails[]` on contribution entities (§9.1) and sync push | As sent. `NaN` → `NULL` |

### 14.2 Rules

- **Upsert by `url`**. `width` and `height` are only filled in when empty.
- **Missing sizes**: parse them from known URL patterns (`(\d+)x(\d+)bb`, `w(\d+)-h(\d+)`, `t500x500`) when they weren't provided.
- **Ownership**: a thumbnail is only attached once its owner's `illusi_id` is known. Service data that isn't linked keeps its artwork in its own tables until it is linked.
- **Best thumbnail**: the largest `width × height`. Unknown sizes rank lowest. This is the same rule as lib-origin's `best_thumbnail`.
- **URLs only**: the server stores URLs. It doesn't download or host images.
- Merges re-point `thumbnails_table.id` (§4.5).

---

## 15. New Releases

Albums, singles and EPs, plus SoundCloud tracks, released in the last
`NEW_RELEASES_WINDOW_DAYS` (default 7) days. Both endpoints only read the
database. Clients keep it current by fulfilling `FETCH_NEW_RELEASES` actions.

### 15.1 Endpoints

- `GET /new-releases`: everything in the window.
- `GET /new-releases/me`: only releases by artists in the user's library.
  - An artist is in the library when they're credited on any non-deleted `user_tracks_table` track.
  - Albums match on `albums_table.artist_id` or an `artist_albums_table` credit, so features count.
  - SoundCloud tracks match when the uploader is linked to a library artist (`soundcloud_id`), or uploaded a SoundCloud track that is in the library.
- Query: `limit` (1–500, default 200), applied to each list.
- Response: `{ since, until, albums: [{ id, name, album_type, release_date, track_count, explicit, artists[], thumbnails[] }], soundcloud_tracks: [{ id, illusi_id, title, permalink, artwork_url, duration, genre, explicit, release_date, user }] }`, newest first.

### 15.2 Release dates

- **Albums**: `albums_table.release_date` falls within `[now - window, now]`. Future (pre-release) dates are excluded.
- **SoundCloud**: `coalesce(release_date, display_date, soundcloud_created_at)`, using the same window. Only public tracks are included.

### 15.3 Client checks (`FETCH_NEW_RELEASES`)

- `GET /new-releases/me?services=spotify,soundcloud,...` names the services the client is logged into.
  - Supported services: `applemusic`, `spotify`, `soundcloud`, `youtube_music`, `deezer`, `tidal`, `amazonmusic`, `audiomack`, `bandlab`, `pandora`.
- For each named service, the response adds one action per library artist that has an ID on that service and is due a check.
  - **Due**: never checked, or the last check is older than `NEW_RELEASES_RECHECK_HOURS`.
  - **Not re-issued**: once handed out, an artist isn't handed out again for `NEW_RELEASES_REQUEST_COOLDOWN_MIN`.
  - **Limit**: at most `NEW_RELEASES_MAX_ACTIONS` actions in total, taking turns between services.
- New table `artist_release_checks_table (artist_id, service, requested_at, checked_at, checked_by)`.
- **Fulfilment**: `POST /ingest/new_releases` with `{ token, artist_id, service, contribution_id?, releases?, soundcloud_items? }`.
  - The token target is `service:artist_id` (§0.2).
  - `releases` is a §9.1 contribution graph. It is scoped to the target artist (§0.2.5):
    - albums credited to the artist (its `illusi_id` used as the ref),
    - tracks on those albums,
    - artists credited on those albums and tracks.
    Everything else is rejected, and `similar_artists` is dropped. What remains goes through the shared contribution engine (§9.3).
  - `soundcloud_items` is the §5.1 shape. Only the target's SoundCloud user and their uploads are written.
  - An empty submission is valid: it records that the artist had nothing new.
  - The check is marked done in the same transaction. Provenance records the token's `jti` (§9.5).

---

## 16. Read API

Sync (§8) is the local-first path: a client that keeps a full local copy never
needs these endpoints. They exist so a client can browse what it hasn't synced:
a fresh device before its first pull finishes, an online-only client, another
user's public playlist, or the global catalog (search, artists, albums).

### 16.1 Conventions

- **Read-only.** These endpoints never write. Library, playlist and profile changes still go through `POST /sync/push` (§8.3), and catalog additions through `POST /contribute` (§9).
- **Authenticated** (§12), mounted under `/api/v1` (§0.0), rate limited per user.
- **Same column names as sync rows** (§8.1), so a client can upsert anything it reads straight into its local database.
- **Merged ids are followed.** If a requested id was merged (§4.5), the response describes the surviving entity and adds `redirected_from: <requested id>`. Clients should rewrite their local reference.
- **Soft-deleted rows are never returned**, except where an endpoint has an explicit `include_deleted` flag.
- **Paging**: `?limit&cursor` → `{ items, next_cursor }`. `limit` defaults to 50, maximum 200. The cursor is opaque, and `next_cursor` is `null` on the last page.
- **Lyrics are not inlined.** Clients call `GET /tracks/:id/lyrics` (§7.2), which also handles the client lyrics actions.

### 16.2 Views

Every list and detail endpoint returns these shapes:

- `ArtistRef`: `{ id, name }`. `AlbumRef`: `{ id, name, album_type, release_date }`.
- `TrackView`: the `tracks_table` row, plus:
  - `artists: ArtistRef[]` in credit order, `album: AlbumRef | null`, `track_number`;
  - `service_ids`, `thumbnails[]`, `itunes` (§8.1 `ItunesFields`, or `null`), `sample_data` (or `null`);
  - `producers: { id, name }[]`;
  - `has_media` and `has_lyrics` flags;
  - `user`: the caller's own overlay, or `null` when the track isn't in their library: `{ title, downloaded_at, start_at, end_at, added_at, plays, last_played_at }`.
- `AlbumView`: the `albums_table` row, plus `artist: ArtistRef | null`, `artists: ArtistRef[]` (every `artist_albums_table` credit), `service_ids`, `thumbnails[]`, `itunes`.
- `ArtistView`: the `artists_table` row, plus `service_ids`, `thumbnails[]`, `itunes`, `album_count`, `track_count`, and `in_library` (the caller has a library track crediting this artist).
- `PlaylistView`: the `playlists_table` row, plus `owner: { id, username }`, `is_owner`, `track_count` (resolved, §10.3) and `thumbnails[]` (the best thumbnail of each of the first four resolved tracks).
  - For the owner only, it also includes `inherited_searches[]` and `inherited_playlists[]` (the rows from the inheritance tables). Other users never see them (§10.1).

### 16.3 The caller

- `GET /me` → `{ user, stats: { tracks, playlists, plays } }`. `user` is the §8.1 `SyncUser`, without `password_hash`.
- `GET /me/library`: the caller's non-deleted `user_tracks_table` tracks, as paged `TrackView`s.
  - `sort`: any `sort_type` value, using `sort_playlist_tracks` (the same rules as §10.3). Default `ADDED_DATE_HILOW`.
  - `q`: optional. Filtered with `track_query_filter` and lib-origin's `TRACK_QUERY_FLAGS`, exactly like a search-inherited playlist (§10.3).
- `GET /me/playlists?include_archived&include_deleted` → `{ items: PlaylistView[] }`, not paged. Archived playlists are included by default, and deleted ones are not.
- `GET /me/plays`: `track_plays_table`, newest first, as paged `{ id, client_id, created_at, track: TrackView }`.
- `GET /me/recent_searches?limit` → `{ items }`, newest first.
- `GET /me/linked_playlists` → `{ items }`.

### 16.4 Playlists

- `GET /playlists/:id` → `PlaylistView`.
  - Readable by its owner, or by anyone when it is `public` and not `deleted`. Otherwise `404`, so a private playlist's existence isn't revealed (same as §10.2).
- `GET /playlists/:id/tracks`: the **resolved** track list (§10.3) in the playlist's `sort_mode`, as paged `TrackView`s.
  - Search inheritance always runs against the **owner's** library. A public playlist therefore shows everyone what its owner sees.
  - The `user` overlay on each track is always the **caller's** own.
- `GET /playlists/public?q&limit&cursor`: public, non-deleted playlists from every user, as paged `PlaylistView`s. `q` matches the title.
  - The route is registered before `/playlists/:id`, and `:id` must be a UUID.
- `GET /users/:id/playlists`: one user's public playlists, as paged `PlaylistView`s. For the caller's own id it behaves like `GET /me/playlists`.

### 16.5 Catalog

- `GET /tracks/:id` → `TrackView`.
- `POST /tracks/batch` with `{ ids }` (at most 500) → `{ items: TrackView[], missing: string[] }`.
  - Items follow `ids` order.
  - A merged id comes back as its survivor, with `redirected_from` set.
  - `missing` lists ids that don't exist.
- `GET /tracks/:id/similar?limit` → `{ items: TrackView[] }`: nearest neighbours by track vector (§3). If the track has no vector yet, `items` is empty.
- `GET /albums/:id` → `{ album: AlbumView, tracks: TrackView[] }`. Tracks are ordered by `album_tracks_table.track_number`, then title.
- `GET /artists/:id` → `ArtistView`.
- `GET /artists/:id/albums?album_type`: albums credited to the artist (`albums_table.artist_id` or `artist_albums_table`), as paged `AlbumView`s. Ordered by `artist_albums_table.position`, then newest `release_date` first.
- `GET /artists/:id/tracks?sort=popular|newest|title`: tracks crediting the artist, as paged `TrackView`s.
  - `popular` (the default) counts `track_plays_table` rows across all users.
- `GET /artists/:id/similar?limit` → `{ items: ArtistView[] }`.
  - `similar_artists_table` rows in either direction come first. They are treated as bidirectional, whether a pair is stored as one row or two.
  - The list is then filled with artist-vector neighbours (§3), if there are any.

### 16.6 Search: `GET /search`

- Query:
  - `q` (required, 1–256 characters);
  - `types`: a comma-separated subset of `track,album,artist,playlist`, default all four;
  - `scope`: `global` (default) or `library`;
  - `limit`, and `cursor` (only valid when `types` names a single type).
- Response: `{ tracks?, albums?, artists?, playlists? }`, one `{ items, next_cursor }` page per requested type. To page further through one type, repeat the query with `types=<that type>&cursor=…`.
- **Matching**:
  - Case- and accent-insensitive trigram matching on `tracks_table.title`, `albums_table.name`, `artists_table.name` and `playlists_table.title`.
  - Tracks also match on their credited artists' names, so `artist title` queries work.
  - Ranking: exact match, then prefix match, then trigram similarity. Ties are broken by total plays.
- **Links and IDs**: if `q` is a recognisable service URL or ID (Spotify, Apple Music, YouTube or YouTube Music, SoundCloud, Deezer or Tidal links, or an ISRC), the server first looks it up in `service_ids_table`. Any hit is ranked first.
- **Scope**:
  - `library` limits tracks to the caller's non-deleted library, albums and artists to those of library tracks, and playlists to the caller's own.
  - `global` searches the whole catalog, and playlists are public ones plus the caller's own.
- Searching doesn't write `user_recent_searches`. Clients record searches themselves and push them through sync (§8.3).
- **Schema change**: enable `pg_trgm` and `unaccent`, and add GIN trigram indexes on the four searched columns.
  - Tracks, albums and artists store the folded text as generated columns (`tracks_table.search_title`, `albums_table.search_name`, `artists_table.search_name`), and the trigram indexes are on those, so a lookup doesn't fold every matched row again. Playlists keep an index on the folded expression.
  - The generated columns are lookup helpers only: sync pull doesn't send them.

### 16.7 Search suggestions: `GET /search/suggestions`

Asked on every keystroke while the user types, so it has to be cheap.

- Query:
  - `q`: up to 256 characters. After case and accent folding and collapsing whitespace, a `q` shorter than **2** characters returns empty lists. With exactly 2 characters only the caller's recent searches are suggested. The catalog is searched from 3 characters on, because shorter text can't use the trigram indexes.
  - `limit`: per list, 1–10, default 5.
- Response: `{ tracks, artists, albums, text }`, each at most `limit` long:
  - `tracks`: `{ id, title, artists, thumbnail, in_library }`, where `artists` lists credited artist names in credit order.
  - `artists`: `{ id, name, thumbnail, in_library }`.
  - `albums`: `{ id, name, artists, thumbnail, in_library }`.
  - `thumbnail` is `{ url, width, height }` or `null`: the smallest one at least 120 px wide, otherwise the largest known.
  - `in_library`: the track is in the caller's non-deleted library. For artists and albums it means one of their tracks is.
  - `text`: `{ text, kind }` completions, `kind` being `recent`, `artist`, `track` or `album`. The caller's recent searches containing `q` come first, most recent first. Then come artist names, `artist title` combinations, track titles and album names, best match first. They're de-duplicated by folded text and never equal to `q`.
- **Matching and ranking**:
  - Case- and accent-insensitive, like search.
  - Order: exact match, then prefix, then substring, then trigram similarity. Within the same match kind, items in the caller's library come first, then the closer text (by trigram similarity), then total plays.
  - A broader match kind is only looked up while fewer than 10 better matches were found: it couldn't outrank them.
  - When the leading words of `q` name an artist exactly, the rest is matched against that artist's track titles, so `drake hotl` suggests Drake's "Hotline Bling".
- **Caching**:
  - The response carries a weak `ETag` and `Cache-Control: private, max-age=30`. A matching `If-None-Match` gets a `304` until the catalog, play totals, the caller's library or their recent searches change.
  - The catalog part of an answer is shared by all users and kept in memory for 30 seconds per catalog version and query.
- Rate limit: 300 requests per minute per user. The per-IP limit at the proxy (120 per minute) still applies.

---

## 17. Backpacked Tracks

A track is **backpacked** when it can't be played or downloaded from the service a client uses for it (the video
was removed, the upload was taken down). `tracks_table.backpacked` marks it for everyone, and `backpacked_at` records
when it was first reported. The server then tries to get the track playable again: first by asking users who
already downloaded it for a copy, then by asking users who have it in their library to find it somewhere else.

### 17.1 Reporting: `POST /tracks/:id/unavailable`

- Body: `{ service, reason? }`. `service` is one of `youtube`, `soundcloud`, `bandlab`, `audiomack`; `reason` is free text, up to 256 characters.
- Follows merge redirects. Unknown tracks return `404`.
- Each report is stored in `track_unavailable_reports_table`, one row per (track, user, service).
- If the track already has a `media_table` row, it's playable through `GET /media`, so it isn't flagged. The response is `{ track_id, backpacked: false, has_media: true }`.
- Otherwise it sets `backpacked = true` and bumps `modified_at` so the flag syncs to every client. `backpacked_at` is set on the first report and kept on later ones. The response is `{ track_id, backpacked: true, backpacked_at, has_media: false }`.

### 17.2 Asking for a copy

For the first `BACKPACK_UPLOAD_WINDOW_HOURS` (default 48) after `backpacked_at`, the only requests are `UPLOAD_MEDIA`
actions (§13.4), with backpacked tracks put ahead of the user's other pending uploads.

### 17.3 Research: `RESEARCH_TRACK`

After the upload window, users who have the track in their library (and no media exists) get
`{ type: 'RESEARCH_TRACK', token, track_id, service, query, title, artists, duration_ms }`. `query` is
`Artist, Artist - Title`, ready to type into the service's search.

- **Where requests come from**: up to 5 per `/sync/pull` (on the last page), and `GET /backpack/requests?limit=` (1–50, default 10).
- **Service order**: services whose id column in `service_ids_table` is empty come first, since a result there can be written right away. Services that already hold a (dead) id come last.
- **Pacing**, tracked per (track, service) in `track_research_table`:
  - a handed-out request isn't repeated for `BACKPACK_RESEARCH_COOLDOWN_MIN` (default 60);
  - a `NOT_FOUND` answer is retried after `BACKPACK_RESEARCH_RETRY_DAYS` (default 30);
  - a `FOUND` service is never asked again.

### 17.4 Submitting: `POST /ingest/track_research`

- Body: `{ token, track_id, service, service_id }` when found, or `{ token, track_id, service, result: 'NOT_FOUND' }`.
- The token must be a `RESEARCH_TRACK` token for that exact track and service (§0.2).
- `service_id` may be an id or a link. It's normalized for the service's column: `youtube_id`, `soundcloud_permalink`, `bandlab_id` or `audiomack_id`. An unrecognisable value returns `422` and leaves the token unused.
- A found id goes through the shared service-id writer (§4.4), with provenance source `research`:
  - an empty column is filled and the track stops being backpacked (`backpacked = false`, `backpacked_at = null`);
  - a different value on a filled column becomes a service id conflict for admin review, and the track stays backpacked.
- Response: `{ track_id, service, status, applied, backpacked, conflict? }`.

### 17.5 Clearing

The flag is cleared when media is uploaded for the track (§13) or when a research result fills an empty column.
Clients treat `backpacked` as "don't try the original service": they play the server copy if there is one, and
otherwise show the track as unavailable.

### 17.6 Schema

- `tracks_table.backpacked_at` (nullable), with a partial index on it where `backpacked`.
- `track_unavailable_reports_table (track_id, user_id, service, reason)`.
- `track_research_table (track_id, service, status PENDING | FOUND | NOT_FOUND, requested_at, checked_at, checked_by, found_value)`.
- `research` added to `provenance_source`.
