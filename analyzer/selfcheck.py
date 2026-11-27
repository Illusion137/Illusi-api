"""Dependency-free sanity check: `python3 analyzer/selfcheck.py`.

Exercises the contract helpers and the HTTP server with a fake analyzer (no models needed).
Exits non-zero on the first failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audio import decode_to_wav  # noqa: E402
from contract import BadRequest, DecodeError, ModelError, build_response, to_short_key, validate_path  # noqa: E402
from alignment import ALPHABET, build_alignment_response  # noqa: E402
from beat_grid import build_beat_grid_response  # noqa: E402
from rhythm import build_rhythm_response  # noqa: E402
from speech import build_speech_response  # noqa: E402
from words import build_words_response  # noqa: E402
from server import serve  # noqa: E402

VIBE = {"acousticness": 0.34, "danceability": 0.62, "energy": 0.70, "instrumentalness": 0.71,
        "liveness": 0.16, "speechiness": 0.04, "valence": 0.88}
FEATURES = {"tempo": 124.5, "tempo_confidence": 1.7, "energy": 0.41, "spectral_centroid": 2810.0, "spectral_rolloff": 5400.0,
            "zero_crossing_rate": 0.08, "mfccs": [-120.0] + [3.5] * 12, "chroma": [0.4] * 12, "sample_rate": 22050, "duration": 214.3}
SCORES = {"House": 0.81, "Techno": 0.64}


class FakeAnalyzer:
    def analyze(self, path: str) -> dict:
        with open(path, "rb") as f:
            head = f.read(4)
        if head == b"BAD!":
            raise DecodeError("not audio")
        if head == b"BOOM":
            raise ModelError("model crashed")
        return build_response("House/Dance", 124.5, 2810.0, "F# minor", VIBE, FEATURES, SCORES)

    def vocals(self, path: str) -> dict:
        if open(path, "rb").read(4) == b"BAD!":
            raise DecodeError("not audio")
        return {"model": "fake", "hop_ms": 256, "window_ms": 2048, "duration_ms": 1000, "voice": [0.9], "segments": [],
                "rhythm": build_rhythm_response(120, [0.5, 1.0], 3.1, [120]),
                "speech": build_speech_response([0.2, 0.8]),
                "words": build_words_response("fake", [(" hello", 0.5, 0.9, 0.8)]),
                "beat_grid": build_beat_grid_response([0.5, 1.0], [0.5])}

    def alignment(self, path: str) -> dict:
        if open(path, "rb").read(4) == b"BAD!":
            raise DecodeError("not audio")
        return build_alignment_response(1000, [], [], build_words_response("fake", [(" hello", 0.5, 0.9, 0.8)]),
                                        build_beat_grid_response([0.5, 1.0], [0.5]), [(0.5, 1.0, 2.0, 0.9)])


def check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)
    print(f"ok   {msg}")


def request(base: str, method: str, path: str, body: object = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def check_ffmpeg_decode() -> None:
    """Encodes a 2s tone into each container (bare file names, like media files) and decodes it back."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("skip ffmpeg decode checks (ffmpeg not on PATH)")
        return
    formats = (("m4a", "mp4", ["-c:a", "aac"]), ("webm", "webm", ["-c:a", "libopus"]),
               ("webm (vorbis)", "webm", ["-c:a", "libvorbis"]), ("ogg", "ogg", ["-c:a", "libopus"]),
               ("mp3", "mp3", []), ("flac", "flac", []))
    with tempfile.TemporaryDirectory() as d:
        for label, fmt, codec in formats:
            src = os.path.join(d, "src-" + label.replace(" ", "_"))
            enc = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                                  "-i", "sine=frequency=440:duration=2", "-ac", "2", *codec, "-f", fmt, src],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if enc.returncode != 0:
                print(f"skip {label}: this ffmpeg can't encode it")
                continue
            out_dir = tempfile.mkdtemp(dir=d)
            wav = decode_to_wav(src, out_dir, ffmpeg)
            with open(wav, "rb") as f:
                header = f.read(44)
            # mono, 16-bit, 44.1 kHz, ~2s of samples
            ok = (header[:4] == b"RIFF" and header[8:12] == b"WAVE" and int.from_bytes(header[22:24], "little") == 1
                  and int.from_bytes(header[24:28], "little") == 44100 and os.path.getsize(wav) > 44100 * 2 * 1.5)
            check(ok and os.path.exists(src), f"ffmpeg decodes {label} without an extension to mono WAV")
        junk = os.path.join(d, "junk")
        with open(junk, "wb") as f:
            f.write(b"definitely not audio" * 100)
        try:
            decode_to_wav(junk, tempfile.mkdtemp(dir=d), ffmpeg)
            check(False, "undecodable file raises DecodeError")
        except DecodeError:
            check(True, "undecodable file raises DecodeError")


def check_vocals_helpers() -> None:
    """The pure parts of vocals.py (needs numpy, not the models)."""
    try:
        import numpy as np
        import vocals
    except ImportError:
        print("skip vocals checks (numpy not installed)")
        return
    check(vocals.mel_frames(np.zeros(16000)).shape == (63, 96), "1s at 16 kHz -> 63 mel frames of 96 bands")
    check(float(vocals.mel_frames(np.zeros(4000)).max()) == 0.0, "silence -> all-zero log-mel")
    starts = vocals.patch_starts(1876, 62)
    check(starts[:2] == [0, 62] and starts[-1] + 128 >= 1876 and starts[-2] + 128 < 1876, "patches cover every frame")
    check(vocals.patch_starts(10, 16) == [0], "a file shorter than one patch -> one padded patch")
    hop = 256.0
    voice = [0.1] * 10 + [0.9] * 10 + [0.5] * 2 + [0.1] * 10 + [0.7] * 2 + [0.1] * 10
    segs = vocals.segments(voice, hop, 60_000)
    check(segs == [{"start_ms": 3456, "end_ms": 6528}], "hysteresis keeps 0.5 inside a segment, drops spans under 1s")
    gap = [0.9] * 8 + [0.1] * 3 + [0.9] * 8
    check(len(vocals.segments(gap, hop, 60_000)) == 1, "gaps under 1s are bridged")
    r = vocals.build_vocals_response([1.2, -0.1, 0.5], 16, 3000)
    check(r["voice"] == [1.0, 0.0, 0.5] and r["hop_ms"] == 256 and r["window_ms"] == 2048, "vocals response clamps and reports timing")


def check_alignment_helpers() -> None:
    """The encoders of alignment.py (need numpy, not the models)."""
    try:
        import base64

        import numpy as np
        from alignment import LETTER_SCALE, encode_letters, encode_loudness, frame_rms
    except ImportError:
        print("skip alignment checks (numpy not installed)")
        return
    log_probs = np.full((3, len(ALPHABET)), -100.0)
    log_probs[0, 0], log_probs[1, 1], log_probs[2, 2] = 0.0, -0.5, -1.13
    q = np.frombuffer(base64.b64decode(encode_letters(log_probs)), dtype=np.uint8).reshape(3, len(ALPHABET))
    check(q[0, 0] == 0 and q[1, 1] == 0.5 * LETTER_SCALE and q[2, 2] == round(1.13 * LETTER_SCALE) and q[0, 1] == 255,
          "letters are -log p in 1/scale steps, capped at 255")
    loud = np.frombuffer(base64.b64decode(encode_loudness([0.0, 0.25] + [1.0] * 8 + [100.0])), dtype=np.uint8)
    check(list(loud) == [0, 64] + [128] * 8 + [255], "loudness is sqrt(rms / p90) in bytes, capped at 4x p90")
    rms = frame_rms(np.concatenate([np.zeros(100), np.ones(100)]), 2)
    check(abs(rms[0]) < 1e-9 and abs(rms[1] - 1) < 1e-9, "frame RMS splits the audio evenly")
    r = build_alignment_response(1000, log_probs, [0.1, 0.2, 0.3], {"model": "w", "words": []}, {"model": "b", "beats_ms": [], "downbeats_ms": []},
                                 [(0.5, 1.0, 2.0, 0.91234), (1.0, 0.5, 2.0, 1.0), (0.5, 1.0, float("nan"), 1.0)])
    check(abs(r["frame_ms"] - 1000 / 3) < 1e-9 and r["alphabet"] == ALPHABET and len(base64.b64decode(r["letters"])) == 3 * len(ALPHABET),
          "alignment response reports the frame length and the letters")
    check(r["repeats"] == [{"start_ms": 500, "end_ms": 1000, "lag_ms": 2000, "strength": 0.912}], "broken repeats are dropped")


def check_word_alignment() -> None:
    """words.align_words on made-up letter probabilities (needs torch and torchaudio, not the models)."""
    try:
        import numpy as np
        from words import Letters, align_words
        import torchaudio.functional  # noqa: F401
    except ImportError:
        print("skip word alignment checks (torch not installed)")
        return
    for alphabet, separator in (("-ab", None), ("-|ab", "|")):
        log_probs = np.full((50, len(alphabet)), -20.0)
        log_probs[:, 0] = 0.0
        for frame, c in ((10, "a"), (12, "b"), (20, "|"), (30, "b"), (33, "a")):
            if c in alphabet:
                log_probs[frame] = -20.0
                log_probs[frame, alphabet.index(c)] = 0.0
        letters = Letters("fake", log_probs, alphabet, separator)
        words = align_words([(0.0, 1.0, [(" Ab,", 0.0, 0.9, 0.8), (" 42", 0.5, 0.6, 0.7), (" ba", 0.1, 0.95, 0.6)])], letters, 0.02)
        check([(w, round(s, 3), round(e, 3), p) for w, s, e, p in words]
              == [(" Ab,", 0.2, 0.26, 0.8), (" 42", 0.5, 0.6, 0.7), (" ba", 0.6, 0.68, 0.6)],
              f"words are re-timed on the letters, digits keep Whisper's times (separator {separator!r})")
    words = align_words([(0.0, 0.02, [(" abab", 0.0, 0.02, 0.5)])], Letters("fake", log_probs, "-ab"), 0.02)
    check(words == [(" abab", 0.0, 0.02, 0.5)], "a segment with more letters than frames keeps Whisper's times")


def main() -> None:
    check_ffmpeg_decode()
    check_vocals_helpers()
    check_alignment_helpers()
    check_word_alignment()
    check(to_short_key("C# major") == "C#", "key: C# major -> C#")
    check(to_short_key("A minor") == "Am", "key: A minor -> Am")
    check(to_short_key("Bb minor") == "A#m", "key: Bb minor -> A#m")
    r = build_response("Techno/Dark", 130, 1500, "G major", VIBE)
    check(r["arousal"] == 0.70 and "energy" not in r, "energy is sent as arousal")
    check(set(r) == {"mood", "tempo", "brightness", "key", "arousal", "valence", "acousticness",
                     "instrumentalness", "liveness", "danceability", "speechiness"}, "response has exactly the contract fields")
    r = build_response("Techno/Dark", 130, 1500, "G major", VIBE, FEATURES, SCORES)
    check(r["rms_energy"] == 0.41 and len(r["mfccs"]) == 13 and len(r["chroma"]) == 12 and r["duration_ms"] == 214300
          and r["mood_scores"] == SCORES, "Mood-Detector's other features are returned")
    try:
        build_response("Techno/Dark", 130, 1500, "G major", VIBE, {**FEATURES, "mfccs": [1.0]})
        check(False, "a short MFCC list is a model failure")
    except ModelError:
        check(True, "a short MFCC list is a model failure")
    rhythm = build_rhythm_response(120.0004, [1.0, 0.5, 0.5, -1, float("nan")], 3.2, [120.1, 119.9, 120.1] * 200)
    check(rhythm["beats_ms"] == [500, 1000] and rhythm["bpm"] == 120.0, "beats are sorted, deduplicated milliseconds")
    check(rhythm["bpm_estimates"] == [119.9, 120.1], "one tempo estimate per window becomes the distinct tempos")
    words = build_words_response("fake", [(" Hello", 1.0004, 1.2, 0.91234), ("", 2, 3, 1), (" late", 0.5, float("nan"), 1),
                                          (" back", 0.4, 0.3, 1.5)])
    check(words["words"] == [{"text": "back", "start_ms": 400, "end_ms": 400, "probability": 1.0},
                             {"text": "Hello", "start_ms": 1000, "end_ms": 1200, "probability": 0.912}],
          "words are trimmed, ordered, clamped, and broken ones dropped")
    speech = build_speech_response([1.2, -0.1, 0.5004])
    check(speech["voice"] == [1.0, 0.0, 0.5] and speech["hop_ms"] == 32, "speech curve is clamped at a 32 ms hop")
    grid = build_beat_grid_response([1.0, 0.5, 0.5, float("nan")], [0.5, -1])
    check(grid["beats_ms"] == [500, 1000] and grid["downbeats_ms"] == [500], "beat grid is sorted, deduplicated milliseconds")
    try:
        validate_path({"path": "relative/x"})
        check(False, "relative path rejected")
    except BadRequest:
        check(True, "relative path rejected")

    gate = threading.Event()

    def slow_load():
        gate.wait(5)
        return FakeAnalyzer()

    httpd = serve(slow_load, "127.0.0.1", 0)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        check(request(base, "GET", "/health")[0] == 503, "health is 503 while loading")
        gate.set()
        for _ in range(50):
            if request(base, "GET", "/health")[0] == 200:
                break
            time.sleep(0.05)
        check(request(base, "GET", "/health")[0] == 200, "health is 200 once loaded")

        with tempfile.TemporaryDirectory() as d:
            good, bad, boom = (os.path.join(d, n) for n in ("good", "bad", "boom"))
            for p, content in ((good, b"RIFF...."), (bad, b"BAD!"), (boom, b"BOOM")):
                with open(p, "wb") as f:
                    f.write(content)
            status, body = request(base, "POST", "/analyze", {"path": good})
            check(status == 200 and body["key"] == "F#m" and body["mood"] == "House/Dance", "analyze returns combined JSON")
            check(os.path.exists(good), "input file is not deleted")
            check(request(base, "POST", "/analyze", {"path": os.path.join(d, "missing")})[0] == 400, "missing file -> 400")
            check(request(base, "POST", "/analyze", {})[0] == 400, "missing path -> 400")
            check(request(base, "POST", "/analyze", {"path": bad})[0] == 422, "undecodable -> 422")
            check(request(base, "POST", "/analyze", {"path": boom})[0] == 500, "model failure -> 500")
            status, body = request(base, "POST", "/vocals", {"path": good})
            check(status == 200 and body["voice"] == [0.9], "vocals returns probabilities")
            check(body["rhythm"]["beats_ms"] == [500, 1000], "vocals returns beat positions")
            check(body["words"]["words"][0]["text"] == "hello" and body["speech"]["voice"] == [0.2, 0.8]
                  and body["beat_grid"]["downbeats_ms"] == [500], "vocals returns words, speech and the beat grid")
            check(request(base, "POST", "/vocals", {"path": bad})[0] == 422, "vocals: undecodable -> 422")
            status, body = request(base, "POST", "/alignment", {"path": good})
            check(status == 200 and body["alphabet"] == ALPHABET and body["repeats"][0]["lag_ms"] == 2000
                  and body["words"]["words"][0]["text"] == "hello", "alignment returns letters, words and repeats")
            check(request(base, "POST", "/alignment", {"path": bad})[0] == 422, "alignment: undecodable -> 422")
            check(request(base, "POST", "/other", {"path": good})[0] == 404, "unknown route -> 404")
            check(all(os.path.exists(p) for p in (good, bad, boom)), "no input file deleted on errors")
    finally:
        httpd.shutdown()
    print("all checks passed")


if __name__ == "__main__":
    main()
