"""Beat positions over the whole track: Essentia's RhythmExtractor2013 (multifeature) on the 44.1 kHz decode.

Mood-Detector's tempo comes from 30 s in the middle of the track and keeps no beat positions; this tracks every beat.
Essentia (https://essentia.upf.edu, AGPL-3.0) is installed from PyPI for this. `build_rhythm_response` only needs the
standard library.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

SAMPLE_RATE = 44100
MODEL = "essentia-rhythmextractor2013-multifeature"


def _finite(value: Any) -> float:
    f = float(value)
    return f if math.isfinite(f) else 0.0


def build_rhythm_response(bpm: Any, beats_s: Sequence[Any], confidence: Any, estimates: Sequence[Any]) -> dict:
    """`beats_ms`: every beat in milliseconds, increasing. `confidence`: Essentia's multifeature score, 0 to ~5.32.
    `bpm_estimates`: the distinct tempos Essentia considered, increasing (it gives one per analysis window, hundreds a
    track, but only a handful of values)."""
    beats = sorted({round(float(b) * 1000) for b in beats_s if math.isfinite(float(b)) and float(b) >= 0})
    return {
        "model": MODEL,
        "bpm": max(0.0, round(_finite(bpm), 3)),
        "confidence": max(0.0, round(_finite(confidence), 4)),
        "beats_ms": beats,
        "bpm_estimates": sorted({round(_finite(e), 3) for e in estimates}),
    }


class RhythmExtractor:
    """Not thread-safe on its own: callers serialize (models.py holds the lock)."""

    def __init__(self) -> None:
        import essentia
        import essentia.standard as es

        essentia.log.warningActive = False
        essentia.log.infoActive = False
        self._extract = es.RhythmExtractor2013(method="multifeature")

    def detect(self, audio: Any) -> dict:
        import numpy as np

        bpm, beats, confidence, estimates, _intervals = self._extract(np.ascontiguousarray(audio, dtype=np.float32))
        return build_rhythm_response(bpm, list(beats), confidence, list(estimates))
