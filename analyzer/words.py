"""Sung words over time: faster-whisper (Whisper converted to CTranslate2, run int8 on the CPU) with word timestamps.

The words are only used as anchors for lining up lyrics that are already known, so the small English model with
greedy decoding is enough: a few confidently heard words per line pin the lines down. Whisper and faster-whisper are
MIT licensed.

Whisper's own word times are loose (often a few hundred ms off), so when a CTC model's letter probabilities over the
same audio are at hand, each segment's words are force-aligned on them (`align_words`), as WhisperX does. The words
and their probabilities stay Whisper's; only the times change.

`build_words_response` only needs the standard library.
"""

from __future__ import annotations

import math
import os
from typing import Any, Iterable, NamedTuple, Optional

SAMPLE_RATE = 16000
COMPUTE_TYPE = "int8"


class Letters(NamedTuple):
    """A CTC model's output over the audio Whisper hears."""

    model: str
    log_probs: Any  # [frames, len(alphabet)], natural log
    alphabet: str  # blank first
    separator: Optional[str] = None  # the word boundary token, if the model has one


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


def align_words(segments: Iterable[tuple], letters: Letters, frame_s: float) -> list:
    """Re-times Whisper's words by forced alignment on `letters`, one segment at a time, within the segment's own
    times (widening them by even 0.25 s placed lines measurably worse).

    `segments`: (start_s, end_s, [(text, start_s, end_s, probability), ...]) per Whisper segment. A word with no letter
    in the alphabet (digits, symbols), or a segment whose letters don't fit its frames, keeps Whisper's times.
    Returns the words of every segment, flattened.
    """
    import torch
    import torchaudio.functional as F

    index = {c: i for i, c in enumerate(letters.alphabet) if i}
    log_probs = torch.as_tensor(letters.log_probs, dtype=torch.float32)
    out = []
    for seg_start, seg_end, words in segments:
        words = list(words)
        ids = [[index[c] for c in str(w[0]).lower().replace("’", "'") if c in index] for w in words]
        spelled = [i for i, x in enumerate(ids) if x]
        lo = max(0, int(seg_start / frame_s))
        hi = min(len(log_probs), math.ceil(seg_end / frame_s))
        targets = []
        for n, i in enumerate(spelled):
            if n and letters.separator:
                targets.append(index[letters.separator])
            targets += ids[i]
        if targets and hi > lo:
            try:
                labels, scores = F.forced_align(log_probs[lo:hi][None], torch.tensor([targets], dtype=torch.int32), blank=0)
            except RuntimeError:  # more letters than frames
                labels = None
            if labels is not None:
                spans = [s for s in F.merge_tokens(labels[0], scores[0].exp(), blank=0)
                         if not letters.separator or s.token != index[letters.separator]]
                k = 0
                for i in spelled:
                    first, last = spans[k], spans[k + len(ids[i]) - 1]
                    k += len(ids[i])
                    words[i] = (words[i][0], (lo + first.start) * frame_s, (lo + last.end) * frame_s, words[i][3])
        out += words
    return out


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

    def detect(self, audio: Any, letters: Optional[Letters] = None) -> dict:
        """`audio`: mono float32 at 16 kHz (a file path would go through PyAV, which the decode already did).
        `letters`, over the same audio, re-times the words (`align_words`)."""
        segments, _info = self._model.transcribe(audio, language=self._language, word_timestamps=True, vad_filter=False,
                                                 beam_size=1, condition_on_previous_text=False)
        segments = [(s.start, s.end, [(w.word, w.start, w.end, w.probability) for w in (s.words or [])]) for s in segments]
        if letters is None or not len(letters.log_probs):
            return build_words_response(self._name, (w for _start, _end, words in segments for w in words))
        frame_s = len(audio) / SAMPLE_RATE / len(letters.log_probs)
        return build_words_response(f"{self._name}+{letters.model}", align_words(segments, letters, frame_s))
