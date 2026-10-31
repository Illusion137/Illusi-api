"""Vocal activity over time: Essentia's Discogs-EffNet embeddings + its voice/instrumental head, both as ONNX.

The models (https://essentia.upf.edu/models.html, CC BY-NC-SA 4.0) are run with onnxruntime; Essentia itself is not
installed. The input features are a numpy port of Essentia's `TensorflowInputMusiCNN` (16 kHz, 512-sample Hann
frames, 256 hop, 96 Slaney mel bands of the power spectrum, log10(1 + 10000 x)), which matches Essentia's output to
float precision. EffNet reads 128-frame patches (2.048 s); a patch every `hop_frames` frames gives one voice
probability per hop.

The pure helpers (`mel_frames`, `patch_starts`, `segments`) only need numpy.
"""

from __future__ import annotations

import os
from typing import Any, Optional, Sequence

import numpy as np

SAMPLE_RATE = 16000
FRAME_SIZE = 512
FRAME_HOP = 256
MEL_BANDS = 96
PATCH_FRAMES = 128
FRAME_MS = FRAME_HOP * 1000 / SAMPLE_RATE  # 16 ms
WINDOW_MS = round(PATCH_FRAMES * FRAME_MS)  # 2048 ms
MODEL = "discogs-effnet-bsdynamic-1+voice_instrumental-discogs-effnet-1"
BATCH = 64

# Segments: a window with voice probability >= ENTER starts or extends a segment, one below EXIT ends it; gaps up to
# MERGE_GAP_MS are bridged and segments shorter than MIN_SEGMENT_MS are dropped.
ENTER, EXIT = 0.6, 0.4
MERGE_GAP_MS = 1000
MIN_SEGMENT_MS = 1000


def _hz_to_mel(f: np.ndarray) -> np.ndarray:
    f = np.asarray(f, dtype=np.float64)
    log_start = 1000.0 / (200.0 / 3)
    with np.errstate(divide="ignore"):
        log_part = log_start + np.log(np.maximum(f, 1e-12) / 1000.0) / (np.log(6.4) / 27.0)
    return np.where(f >= 1000.0, log_part, f / (200.0 / 3))


def _mel_to_hz(m: np.ndarray) -> np.ndarray:
    log_start = 1000.0 / (200.0 / 3)
    return np.where(m >= log_start, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - log_start)), m * (200.0 / 3))


def _filterbank() -> np.ndarray:
    """Slaney mel triangles, each scaled by 2 / bandwidth, over the 257 FFT bins."""
    edges = _mel_to_hz(np.linspace(_hz_to_mel(np.array(0.0)), _hz_to_mel(np.array(SAMPLE_RATE / 2)), MEL_BANDS + 2))
    bins = np.arange(FRAME_SIZE // 2 + 1) * SAMPLE_RATE / FRAME_SIZE
    lo, centre, hi = edges[:-2, None], edges[1:-1, None], edges[2:, None]
    tri = np.maximum(0.0, np.minimum((bins - lo) / (centre - lo), (hi - bins) / (hi - centre)))
    return tri * (2.0 / (hi - lo))


_FILTERBANK = _filterbank()
# Essentia's Hann is the symmetric one.
_WINDOW = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FRAME_SIZE) / (FRAME_SIZE - 1))


def mel_frames(audio: np.ndarray) -> np.ndarray:
    """(frames, 96) float32 log-mel. Frame i is centred on sample i * 256, like Essentia's FrameCutter."""
    audio = np.asarray(audio, dtype=np.float64)
    padded = np.concatenate([np.zeros(FRAME_HOP), audio, np.zeros(FRAME_SIZE)])
    count = len(audio) // FRAME_HOP + 1
    out = np.empty((count, MEL_BANDS), dtype=np.float32)
    step = 2048  # frames per chunk, bounds memory on long files
    for start in range(0, count, step):
        idx = np.arange(start, min(count, start + step))[:, None] * FRAME_HOP + np.arange(FRAME_SIZE)
        power = np.abs(np.fft.rfft(padded[idx] * _WINDOW, axis=1)) ** 2
        out[start:start + len(idx)] = np.log10(1 + 10000 * power @ _FILTERBANK.T)
    return out


def patch_starts(frame_count: int, hop_frames: int) -> list:
    """Patch start frames covering every frame; the last patch may run past the end (padded with silence)."""
    starts = list(range(0, max(1, frame_count - PATCH_FRAMES + 1), hop_frames))
    last_end = starts[-1] + PATCH_FRAMES
    while last_end < frame_count:
        starts.append(starts[-1] + hop_frames)
        last_end += hop_frames
    return starts


def segments(voice: Sequence[float], hop_ms: float, duration_ms: float) -> list:
    """Voiced spans [{start_ms, end_ms}] from per-window probabilities (window i centred at i * hop + WINDOW_MS / 2)."""
    spans: list = []
    open_at: Optional[int] = None
    for i, p in enumerate(voice):
        if open_at is None and p >= ENTER:
            open_at = i
        elif open_at is not None and p < EXIT:
            spans.append([open_at, i - 1])
            open_at = None
    if open_at is not None:
        spans.append([open_at, len(voice) - 1])

    def bounds(first: int, last: int) -> tuple:
        start = first * hop_ms + WINDOW_MS / 2 - hop_ms / 2
        end = last * hop_ms + WINDOW_MS / 2 + hop_ms / 2
        return max(0.0, start), min(float(duration_ms), end)

    merged: list = []
    for first, last in spans:
        start, end = bounds(first, last)
        if merged and start - merged[-1][1] <= MERGE_GAP_MS:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [{"start_ms": round(s), "end_ms": round(e)} for s, e in merged if e - s >= MIN_SEGMENT_MS]


def build_vocals_response(voice: Sequence[float], hop_frames: int, duration_ms: float) -> dict:
    hop_ms = hop_frames * FRAME_MS
    probs = [round(min(1.0, max(0.0, float(p))), 4) for p in voice]
    return {
        "model": MODEL,
        "hop_ms": round(hop_ms),
        "window_ms": WINDOW_MS,
        "duration_ms": round(duration_ms),
        "voice": probs,
        "segments": segments(probs, hop_ms, duration_ms),
    }


class VocalDetector:
    """Holds both ONNX sessions. Not thread-safe on its own: callers serialize (models.py holds the lock)."""

    def __init__(self, models_dir: str, hop_frames: int, threads: int) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self._effnet = ort.InferenceSession(os.path.join(models_dir, "discogs-effnet-bsdynamic-1.onnx"), opts, providers=["CPUExecutionProvider"])
        self._head = ort.InferenceSession(os.path.join(models_dir, "voice_instrumental-discogs-effnet-1.onnx"), opts, providers=["CPUExecutionProvider"])
        self._hop_frames = hop_frames
        # Output 1 of the head is "voice" (classes: instrumental, voice).
        self._voice_index = 1

    def detect(self, audio: np.ndarray) -> dict:
        mel = mel_frames(audio)
        starts = patch_starts(len(mel), self._hop_frames)
        need = starts[-1] + PATCH_FRAMES
        if need > len(mel):
            # log10(1 + 0) = 0 is what silence looks like.
            mel = np.concatenate([mel, np.zeros((need - len(mel), MEL_BANDS), dtype=np.float32)])
        voice: list[Any] = []
        for i in range(0, len(starts), BATCH):
            batch = np.stack([mel[s:s + PATCH_FRAMES] for s in starts[i:i + BATCH]])
            embeddings = self._effnet.run(["embeddings"], {"melspectrogram": batch})[0]
            probs = self._head.run(None, {"embeddings": embeddings})[0]
            voice.extend(probs[:, self._voice_index].tolist())
        return build_vocals_response(voice, self._hop_frames, len(audio) * 1000 / SAMPLE_RATE)
