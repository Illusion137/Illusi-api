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
from server import serve  # noqa: E402

VIBE = {"acousticness": 0.34, "danceability": 0.62, "energy": 0.70, "instrumentalness": 0.71,
        "liveness": 0.16, "speechiness": 0.04, "valence": 0.88}


class FakeAnalyzer:
    def analyze(self, path: str) -> dict:
        with open(path, "rb") as f:
            head = f.read(4)
        if head == b"BAD!":
            raise DecodeError("not audio")
        if head == b"BOOM":
            raise ModelError("model crashed")
        return build_response("House/Dance", 124.5, 2810.0, "F# minor", VIBE)


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


def main() -> None:
    check_ffmpeg_decode()
    check(to_short_key("C# major") == "C#", "key: C# major -> C#")
    check(to_short_key("A minor") == "Am", "key: A minor -> Am")
    check(to_short_key("Bb minor") == "A#m", "key: Bb minor -> A#m")
    r = build_response("Techno/Dark", 130, 1500, "G major", VIBE)
    check(r["arousal"] == 0.70 and "energy" not in r, "energy is sent as arousal")
    check(set(r) == {"mood", "tempo", "brightness", "key", "arousal", "valence", "acousticness",
                     "instrumentalness", "liveness", "danceability", "speechiness"}, "response has exactly the contract fields")
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
            check(all(os.path.exists(p) for p in (good, bad, boom)), "no input file deleted on errors")
    finally:
        httpd.shutdown()
    print("all checks passed")


if __name__ == "__main__":
    main()
