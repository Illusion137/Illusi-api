"""Beats and downbeats: Beat This! (CPJKU, MIT), a transformer beat tracker, without its DBN post-processing.

Essentia's RhythmExtractor2013 (rhythm.py) assumes one steady tempo; Beat This! follows tempo changes and finds the
downbeats, which the lyrics aligner snaps rap lines to. The checkpoint is `final0` (ANALYZER_MODELS_DIR in the Docker
image, otherwise downloaded once into the torch hub cache).

`build_beat_grid_response` only needs the standard library.
"""

from __future__ import annotations

import math
import os
from typing import Any, Sequence

SAMPLE_RATE = 22050
CHECKPOINT = "final0"
MODEL = f"beat-this-{CHECKPOINT}"


def _ms(times_s: Sequence[Any]) -> list:
    return sorted({round(float(t) * 1000) for t in times_s if math.isfinite(float(t)) and float(t) >= 0})


def build_beat_grid_response(beats_s: Sequence[Any], downbeats_s: Sequence[Any]) -> dict:
    return {"model": MODEL, "beats_ms": _ms(beats_s), "downbeats_ms": _ms(downbeats_s)}


class BeatTracker:
    """Not thread-safe on its own: callers serialize (models.py holds the lock)."""

    def __init__(self, models_dir: str) -> None:
        from beat_this.inference import Audio2Beats

        local = os.path.join(models_dir, f"beat_this-{CHECKPOINT}.ckpt")
        self._track = Audio2Beats(checkpoint_path=local if os.path.isfile(local) else CHECKPOINT, device="cpu", dbn=False)

    def detect(self, audio: Any) -> dict:
        """`audio`: mono float32 at 22.05 kHz."""
        import numpy as np

        beats, downbeats = self._track(np.ascontiguousarray(audio, dtype=np.float32), SAMPLE_RATE)
        return build_beat_grid_response(list(beats), list(downbeats))
