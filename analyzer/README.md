# Illusi music analyzer

A small localhost HTTP API around [Mood-Detector](https://github.com/usr-wwelsh/Mood-Detector) and
[VibeNet](https://github.com/jaeheonshim/vibenet). It runs as its **own process**.
Express never spawns it. Express only polls `GET /health` and sends file paths to `POST /analyze`.
The analyzer has no database access and never deletes or modifies its input files.

## Input formats

Every input is first decoded by **ffmpeg** ([`audio.py`](./audio.py)) into a temporary mono 16-bit 44.1 kHz WAV, which
both models then read. Anything ffmpeg can decode works: `.m4a`/AAC (iTunes previews), `.webm` and `.ogg` (Opus or
Vorbis), mp3, flac, wav, and so on. ffmpeg detects the format from the content, so extensionless media files
(`MEDIA_DIR/<resource_id>`) are fine. Only the first audio stream is used. A file that ffmpeg can't decode, or that has
no audio stream, returns `422`. The temporary WAV is written to the system temp directory (`TMPDIR`) and deleted after
each request.

## API

| Request | Response |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` once both models are loaded; `503` while loading or if loading failed |
| `POST /analyze` `{"path": "/abs/file"}` | `200` combined JSON (below) |
| | `400`: the path is missing, not absolute, outside `ANALYZER_PATH_ROOTS`, or unreadable |
| | `422`: the file can't be decoded as audio |
| | `500`: a model failed |
| | `503`: the models aren't loaded yet |

```json
{
  "mood": "House/Dance",
  "tempo": 124.5, "brightness": 2810.2, "key": "F#m",
  "arousal": 0.70, "valence": 0.88,
  "acousticness": 0.34, "instrumentalness": 0.71, "liveness": 0.16,
  "danceability": 0.62, "speechiness": 0.04
}
```

- `mood`: one label from Mood-Detector's fixed rule-based set, for example `House/Dance`, `Drum & Bass` or `Melancholic/Sad`.
- `tempo`: BPM, after Mood-Detector's half-tempo correction.
- `brightness`: the mean spectral centroid, in Hz.
- `key`: Mood-Detector's `"F# minor"` / `"F# major"`, converted to `F#m` / `F#` (sharps only, at most 5 characters).
- VibeNet values are all 0–1. Its `energy` is returned as `arousal`.

## Run locally

Requires Python 3.12 or later (VibeNet needs it) and `ffmpeg` on `PATH`. The models won't load without it, so `/health` stays `503`.

```sh
cd analyzer
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
ANALYZER_URL=http://127.0.0.1:8765 python server.py
curl -s localhost:8765/health
curl -s -XPOST localhost:8765/analyze -H 'content-type: application/json' -d '{"path":"/abs/path/song.m4a"}'
```

Sanity check. It needs no models or Python dependencies, and tests the contract helpers and HTTP server with a fake model.
If `ffmpeg` is on `PATH`, it also round-trips m4a, webm, ogg, mp3 and flac test tones through the decoder:

```sh
python3 analyzer/selfcheck.py
```

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `ANALYZER_URL` | `http://127.0.0.1:8765` | Bind host and port. Use the same value the API uses. |
| `ANALYZER_HOST` / `ANALYZER_PORT` | | Override the host or port parsed from `ANALYZER_URL` |
| `ANALYZER_PATH_ROOTS` | (any) | `:`-separated directories that requests may point into. Set it to the API's `ANALYZER_TMP_DIR` and `MEDIA_DIR`. |
| `ANALYZER_ALLOW_REMOTE` | unset | Set it to `1` to allow binding a non-loopback address. Not recommended. |
| `ANALYZER_FFMPEG` | `ffmpeg` on `PATH` | Path to the ffmpeg binary |
| `ANALYZER_DECODE_TIMEOUT_S` | `300` | Maximum time for ffmpeg to decode one file. A timeout returns `422`. |

The API sends **absolute paths**, so the analyzer must see `ANALYZER_TMP_DIR` and `MEDIA_DIR` at the same
absolute paths the API uses. Read-only access is enough.

## Deploy

- systemd: see [`illusi-analyzer.service`](./illusi-analyzer.service).
- docker-compose: see [`docker-compose.example.yml`](./docker-compose.example.yml) and the [`Dockerfile`](./Dockerfile).
  The image installs ffmpeg, and the build fails if its ffmpeg lacks the aac, opus, vorbis, mp3 or flac decoders.
  It uses `network_mode: host` so the analyzer stays on 127.0.0.1, and mounts the data directories read-only at
  the same paths.

The Postgres database also needs pgvector for the vectors table: it is created by the first migration in `drizzle/` (`npm run db:migrate`).

## Adjusting the model integration

Only [`models.py`](./models.py) imports Mood-Detector or VibeNet. Both receive the decoded WAV path, never the original file. Both are loaded once, at startup, in a
background thread, and inference is serialized with a lock.

- Mood-Detector's `analyze_audio()` is **not** used, for two reasons. It rejects files without an audio extension,
  and media files are bare UUIDs. Its result also has no brightness. Instead, `models.py` calls
  `mood_detector.features.extract_features(path)` (whose `spectral_centroid` is used as brightness) and
  `mood_detector.mood_classifier.classify_mood(features)`.
- VibeNet: `vibenet.load_model()` returns an ONNX EfficientNet model, and `model.predict(path)[0].to_dict()` returns its result.

If either library changes, update `RealAnalyzer.__init__` and `RealAnalyzer.analyze`. [`contract.py`](./contract.py)
holds the pure mapping (key format, field renames, validation).
