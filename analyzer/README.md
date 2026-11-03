# Illusi music analyzer

A small localhost HTTP API around [Mood-Detector](https://github.com/usr-wwelsh/Mood-Detector),
[VibeNet](https://github.com/jaeheonshim/vibenet) and [Essentia's](https://essentia.upf.edu/models.html) voice/instrumental
model. It runs as its **own process**.
Express never spawns it. Express only polls `GET /health` and sends file paths to `POST /analyze` and `POST /vocals`.
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
| `GET /health` | `200 {"status":"ok"}` once every model is loaded; `503` while loading or if loading failed |
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
  "danceability": 0.62, "speechiness": 0.04,
  "tempo_confidence": 1.7, "rms_energy": 0.41, "spectral_rolloff": 5400.0, "zero_crossing_rate": 0.08,
  "mfccs": [-120.4, 98.1, ...], "chroma": [0.41, 0.37, ...], "duration_ms": 214300,
  "mood_scores": {"House": 0.81, "Techno": 0.64, "Disco": 0.55, "Ambient": 0.12, "DnB": 0.31, "Downtempo": 0.42}
}
```

- `mood`: one label from Mood-Detector's fixed rule-based set, for example `House/Dance`, `Drum & Bass` or `Melancholic/Sad`.
- `tempo`: BPM, after Mood-Detector's half-tempo correction.
- `brightness`: the mean spectral centroid, in Hz.
- `key`: Mood-Detector's `"F# minor"` / `"F# major"`, converted to `F#m` / `F#` (sharps only, at most 5 characters).
- VibeNet values are all 0–1. Its `energy` is returned as `arousal`.
- The rest of what Mood-Detector measures, on the same 30 s excerpt as `tempo`: `tempo_confidence` (the variance of
  the onset strength; under 0.2 means no clear beat), `rms_energy` (mean RMS × 2.5, clipped to 0–1),
  `spectral_rolloff` (Hz), `zero_crossing_rate`, 13 mean `mfccs`, 12 mean `chroma` bins (C to B, 0–1),
  `duration_ms` of the whole file, and `mood_scores`, its similarity (0–1) to six reference styles.

### `POST /vocals`

`{"path": "/abs/file"}`, with the same error statuses as `/analyze`. The API only sends full media files here, never
iTunes previews, and only for tracks whose lyrics are all unsynced, since its results exist to sync them. `/analyze`
runs for every track. Both share one queue that takes the tracks Illusi users play most first, then the ones streaming
services report the most plays for.

```json
{
  "model": "discogs-effnet-bsdynamic-1+voice_instrumental-discogs-effnet-1",
  "hop_ms": 256, "window_ms": 2048, "duration_ms": 214000,
  "voice": [0.01, 0.02, 0.71, 0.93, ...],
  "segments": [{"start_ms": 9856, "end_ms": 17024}, ...]
}
```

- `voice[i]`: the probability (0–1) that the window `[i * hop_ms, i * hop_ms + window_ms)` has a voice in it,
  singing or talking. Windows overlap, so a value is best read as belonging to the window's centre,
  `i * hop_ms + window_ms / 2`. The last window may run past the end of the file (padded with silence).
- `segments`: voiced spans, from `voice` with hysteresis (a window at 0.6 or more starts a span, one below 0.4 ends
  it), gaps up to 1 s bridged and spans under 1 s dropped. Boundaries are accurate to about half a second; use
  `voice` for anything finer.
- `rhythm`: `{"model", "bpm", "confidence", "beats_ms": [...], "bpm_estimates": [...]}`, Essentia's
  `RhythmExtractor2013` (multifeature) over the whole file ([`rhythm.py`](./rhythm.py)). `beats_ms` is every beat,
  increasing. `confidence` is Essentia's multifeature score, 0 to about 5.32 (above 3.5 is very reliable, under 1.5
  unreliable). Unlike `tempo` from `/analyze`, it covers the whole track and keeps the beat positions.
  `bpm_estimates` is the distinct tempos Essentia considered, increasing.
- `words`: `{"model", "words": [{"text", "start_ms", "end_ms", "probability"}, ...]}`, what Whisper (`small.en`
  through faster-whisper, int8, greedy decoding) heard in the full mix, in order ([`words.py`](./words.py)). Empty
  when it heard nothing. Mishearings are common; the lyrics aligner only needs a few confident words per line.
- `speech`: `{"model", "hop_ms": 32, "voice": [...]}`, Silero VAD's voice probability of each 32 ms frame
  ([`speech.py`](./speech.py)). Silero is a speech detector, so it is often silent through sung pop; it is sharper
  than `voice` on rap.
- `beat_grid`: `{"model", "beats_ms": [...], "downbeats_ms": [...]}`, Beat This! ([`beat_grid.py`](./beat_grid.py)),
  which follows tempo changes and finds downbeats, unlike `rhythm`.

The last three exist to line up plain lyrics (lib-origin's `LyricsAlign.heard_line_sync`). On 2 threads a 4-minute
track takes about 30 s more than before, almost all of it Whisper, and the process needs about 2 GB of memory with
every model loaded.

How it works ([`vocals.py`](./vocals.py)): the file is decoded to 16 kHz mono, turned into the same log-mel
spectrogram Essentia's `TensorflowInputMusiCNN` produces (ported to numpy; it matches Essentia to float precision),
cut into 128-frame (2.048 s) patches every `ANALYZER_VOCALS_HOP_FRAMES` frames, and run through Discogs-EffNet
for embeddings and the voice/instrumental head for probabilities, both with onnxruntime. Essentia itself isn't
installed. A 4-minute track takes a few seconds of CPU.

Whisper's weights and faster-whisper are MIT, as are Silero VAD and Beat This!. The image downloads the Whisper model
(pinned to a commit and by checksum) and the Beat This! checkpoint into `ANALYZER_MODELS_DIR`; run locally, both are
downloaded on first start (into the Hugging Face and torch hub caches). Beat This! needs PyTorch: on Linux the
requirements pull the CPU-only build, since the default one bundles CUDA.

Beat tracking uses the Essentia library itself (`essentia` on PyPI, AGPL-3.0), pinned to the last release with
Python 3.12 wheels; those exist for Linux x86_64 and macOS only, so the image is built for amd64.

The model files are CC BY-NC-SA 4.0 (non-commercial; Essentia sells proprietary licenses). The
[`Dockerfile`](./Dockerfile) downloads them, pinned by checksum. To run locally, fetch them into `analyzer/models/`
(git-ignored):

```sh
mkdir -p analyzer/models && cd analyzer/models
curl -fLO https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx
curl -fLO https://essentia.upf.edu/models/classification-heads/voice_instrumental/voice_instrumental-discogs-effnet-1.onnx
shasum -a 256 *.onnx
# a280825b334797cf677939db8cd5762c0392aedd0ca6415dbc1cd083f045e43c  discogs-effnet-bsdynamic-1.onnx
# 20155e4c439714b0c45c08644b73c8e12d9dccb173bd4ab9934bf1e5aee837ca  voice_instrumental-discogs-effnet-1.onnx
```

Under systemd (`ProtectSystem=strict`) nothing can be downloaded at start, so fetch the Whisper model and the Beat This!
checkpoint there too, with the requirements installed:

```sh
python -c "from faster_whisper import download_model; download_model('small.en', output_dir='faster-whisper-small.en')"
curl -fL -o beat_this-final0.ckpt https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt
shasum -a 256 beat_this-final0.ckpt
# 8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331  beat_this-final0.ckpt
```

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
| `ANALYZER_MODELS_DIR` | `analyzer/models` (`/app/models` in the image) | Directory holding the two vocal ONNX files, and optionally `faster-whisper-<size>/` and `beat_this-final0.ckpt` |
| `ANALYZER_VOCALS_HOP_FRAMES` | `16` | Step between vocal windows, in 16 ms frames (16 = 256 ms). Smaller is finer and slower. |
| `ANALYZER_VOCALS_THREADS` | `2` | Threads for the vocal models, Whisper and Beat This! |
| `ANALYZER_WHISPER_MODEL` | `small.en` | faster-whisper model size. Smaller ones are faster and hear fewer words. |

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

Only [`models.py`](./models.py) imports Mood-Detector or VibeNet. Both receive the decoded WAV path, never the original file. All models are loaded once, at startup, in a
background thread, and inference is serialized with a lock.

- Mood-Detector's `analyze_audio()` is **not** used, for two reasons. It rejects files without an audio extension,
  and media files are bare UUIDs. Its result also has no brightness. Instead, `models.py` calls
  `mood_detector.features.extract_features(path)` (whose `spectral_centroid` is used as brightness) and
  `mood_detector.mood_classifier.classify_mood(features)`.
- VibeNet: `vibenet.load_model()` returns an ONNX EfficientNet model, and `model.predict(path)[0].to_dict()` returns its result.

- Vocals: `vocals.VocalDetector`, loaded with the others and sharing their lock. So are `words.WordRecognizer`,
  `speech.SpeechDetector` and `beat_grid.BeatTracker`.

If either library changes, update `RealAnalyzer.__init__` and `RealAnalyzer.analyze`. [`contract.py`](./contract.py)
holds the pure mapping (key format, field renames, validation).
