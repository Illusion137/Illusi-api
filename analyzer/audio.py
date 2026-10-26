"""Audio decoding through ffmpeg. No third-party imports.

Inputs arrive in whatever container the source used: iTunes previews are .m4a (AAC), uploads may be mp3, m4a/aac,
flac, ogg/opus, webm (opus/vorbis), wav, ... and media files have no extension at all. Rather than rely on
soundfile/audioread guessing, every input is decoded once by ffmpeg into a temporary mono PCM WAV, which both
models read natively. ffmpeg detects the format from the content, so file names don't matter.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Optional

from contract import DecodeError, ModelError

# 44.1 kHz keeps full bandwidth for both models (Mood-Detector loads at 22.05 kHz, VibeNet resamples to 16 kHz).
SAMPLE_RATE = 44100
DECODE_TIMEOUT_S = float(os.environ.get("ANALYZER_DECODE_TIMEOUT_S", "300"))
_WAV_HEADER = 44


def ffmpeg_binary() -> str:
    """Path to ffmpeg (ANALYZER_FFMPEG overrides PATH lookup). Raises ModelError if it isn't installed."""
    binary = os.environ.get("ANALYZER_FFMPEG") or shutil.which("ffmpeg")
    if not binary or not os.access(binary, os.X_OK):
        raise ModelError("ffmpeg is not installed (set ANALYZER_FFMPEG or add it to PATH)")
    return binary


def decode_to_wav(src: str, out_dir: str, ffmpeg: Optional[str] = None) -> str:
    """Decodes the first audio stream of `src` into `<out_dir>/decoded.wav` (mono, 16-bit, SAMPLE_RATE).

    Never touches `src`. Raises DecodeError if ffmpeg can't read it or it has no audio.
    """
    out = os.path.join(out_dir, "decoded.wav")
    cmd = [
        ffmpeg or ffmpeg_binary(),
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src,
        "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav",
        out,
    ]
    try:
        proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              timeout=DECODE_TIMEOUT_S)
    except subprocess.TimeoutExpired as e:
        raise DecodeError(f"ffmpeg timed out after {DECODE_TIMEOUT_S:.0f}s") from e
    if proc.returncode != 0:
        lines = proc.stderr.decode(errors="replace").strip().splitlines()
        raise DecodeError(f"cannot decode audio: {lines[-1] if lines else f'ffmpeg exited {proc.returncode}'}")
    if not os.path.isfile(out) or os.path.getsize(out) <= _WAV_HEADER:
        raise DecodeError("audio is empty")
    return out
