"""Sung words over time: faster-whisper (Whisper converted to CTranslate2, run int8 on the CPU) with word timestamps.

The words are only used as anchors for lining up lyrics that are already known, so the small English model with
greedy decoding is enough: a few confidently heard words per line pin the lines down. No vocal separation runs first;
Whisper hears the full mix. Whisper and faster-whisper are MIT licensed.

`build_words_response` only needs the standard library.
"""

from __future__ import annotations

import math
import os
from typing import Any, Iterable

SAMPLE_RATE = 16000
COMPUTE_TYPE = "int8"


def model_name(size: str) -> str:
    return f"faster-whisper-{size}-{COMPUTE_TYPE}"


def build_words_response(model: str, words: Iterable[Any]) -> dict:
    """`words`: (text, start_s, end_s, probability) in order. Empty words and broken timings are dropped."""
    out = []
    for text, start, end, probability in words:
        text = str(text).strip()
        if not text or not all(math.isfinite(float(x)) for x in (start, end, probability)):
            continue
        start_ms = max(0, round(float(start) * 1000))
        end_ms = max(start_ms, round(float(end) * 1000))
        out.append({"text": text[:64], "start_ms": start_ms, "end_ms": end_ms,
                    "probability": round(min(1.0, max(0.0, float(probability))), 3)})
    out.sort(key=lambda w: w["start_ms"])
    return {"model": model, "words": out}


class WordRecognizer:
    """Holds the Whisper model. Not thread-safe on its own: callers serialize (models.py holds the lock)."""

    def __init__(self, models_dir: str, size: str, threads: int) -> None:
        from faster_whisper import WhisperModel

        # The Docker image ships the model; elsewhere it is downloaded once into the Hugging Face cache
        local = os.path.join(models_dir, f"faster-whisper-{size}")
        self._model = WhisperModel(local if os.path.isdir(local) else size, device="cpu", compute_type=COMPUTE_TYPE,
                                   cpu_threads=threads)
        self._name = model_name(size)
        self._language = "en" if size.endswith(".en") else None

    def detect(self, audio: Any) -> dict:
        """`audio`: mono float32 at 16 kHz (a file path would go through PyAV, which the decode already did)."""
        segments, _info = self._model.transcribe(audio, language=self._language, word_timestamps=True, vad_filter=False,
                                                 beam_size=1, condition_on_previous_text=False)
        return build_words_response(self._name, ((w.word, w.start, w.end, w.probability)
                                                 for segment in segments for w in (segment.words or [])))
