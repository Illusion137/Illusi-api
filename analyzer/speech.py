"""Voice activity at a fine hop: Silero VAD (ONNX, MIT) over the full mix.

Silero is a speech detector, so on sung pop it can hear nothing at all; it complements the EffNet voice curve rather
than replacing it, and the lyrics aligner judges which one fits. One probability per 512-sample frame (32 ms).

`build_speech_response` only needs the standard library.
"""

from __future__ import annotations

from typing import Any, Sequence

SAMPLE_RATE = 16000
FRAME = 512
HOP_MS = FRAME * 1000 // SAMPLE_RATE  # 32 ms
MODEL = "silero-vad-6"


def build_speech_response(probabilities: Sequence[Any]) -> dict:
    return {
        "model": MODEL,
        "hop_ms": HOP_MS,
        "voice": [round(min(1.0, max(0.0, float(p))), 3) for p in probabilities],
    }


class SpeechDetector:
    """Not thread-safe on its own (the model keeps state between frames): callers serialize (models.py holds the lock)."""

    def __init__(self) -> None:
        from silero_vad import load_silero_vad

        self._model = load_silero_vad(onnx=True)

    def detect(self, audio: Any) -> dict:
        """`audio`: mono float32 at 16 kHz."""
        import numpy as np
        import torch

        samples = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))
        self._model.reset_states()
        probabilities = [float(self._model(samples[start:start + FRAME], SAMPLE_RATE))
                         for start in range(0, len(samples) - FRAME, FRAME)]
        return build_speech_response(probabilities)
