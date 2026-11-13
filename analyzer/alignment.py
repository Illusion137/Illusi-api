"""Evidence for lining up plain lyrics on the device, from the separated vocals (`POST /alignment`).

Nothing here depends on the lyrics: the app aligns whatever lyrics it shows against this evidence itself, so the
server never stores (or vouches for) a synced version.

- Stems: Demucs `htdemucs` (MIT) splits the mix; the vocals stem is heard, the drums stem gives the beat grid.
- Letters: the MMS forced-alignment model (torchaudio's `MMS_FA`, weights CC BY-NC 4.0) gives, every ~20 ms frame of
  the vocals stem, the log-probability of each letter and of CTC's blank. The app force-aligns lyrics on them.
- Loudness of the vocals stem per frame (where singing is, and near-silence no lyric can be placed on).
- Words: Whisper on the vocals stem (words.py), anchors for long songs where letters alone drift.
- Beat grid: Beat This! on the drums stem (beat_grid.py).
- Repeats: vocal passages that are sung again (beat-synchronous self-similarity of the vocals stem), so anchors in
  one chorus can place the same lines in another.

The pure encoders (`encode_letters`, `encode_loudness`, `build_alignment_response`) only need numpy.
"""

from __future__ import annotations

import base64
import math
import os
from pathlib import Path
from typing import Any, Sequence

SAMPLE_RATE = 16000
STEM_MODEL = "htdemucs"
LETTERS_MODEL = "mms-fa"
MODEL = f"{STEM_MODEL}+{LETTERS_MODEL}"
# MMS_FA's labels without its star token: blank first, then the letters. The app rebuilds the star itself.
ALPHABET = "-aienoutsrmkldghybpwcvjzf'qx"
# Letters are sent as round(-log p * LETTER_SCALE), capped at 255: quarter-nat steps lose nothing measurable.
LETTER_SCALE = 4
# Loudness is sent as round(127.5 * sqrt(min(4, rms / p90))): fine steps near silence, where the thresholds are.
LOUDNESS_CAP = 4.0
EMISSION_WINDOW_S = 20.0
EMISSION_CONTEXT_S = 2.0
REPEAT_MIN_BEATS = 8


def encode_letters(log_probs: Any) -> str:
    """`log_probs`: [frames, len(ALPHABET)] natural-log probabilities. Base64 of frame-major bytes."""
    import numpy as np

    q = np.clip(np.round(-np.asarray(log_probs, dtype=np.float32) * LETTER_SCALE), 0, 255).astype(np.uint8)
    return base64.b64encode(q.tobytes()).decode()


def frame_rms(audio: Any, frames: int) -> Any:
    """RMS of the audio under each of `frames` equal frames."""
    import numpy as np

    x = np.asarray(audio, dtype=np.float32)
    edges = np.linspace(0, len(x), frames + 1).astype(int)
    sq = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    n = np.maximum(1, np.diff(edges))
    return np.sqrt((sq[edges[1:]] - sq[edges[:-1]]) / n)


def encode_loudness(rms: Any) -> str:
    """Per-frame RMS relative to its 90th percentile, square-rooted into one byte each."""
    import numpy as np

    rms = np.asarray(rms, dtype=np.float64)
    p90 = float(np.percentile(rms, 90)) if len(rms) else 0.0
    rel = np.minimum(LOUDNESS_CAP, rms / p90) if p90 > 0 else np.zeros_like(rms)
    return base64.b64encode(np.round(127.5 * np.sqrt(rel)).astype(np.uint8).tobytes()).decode()


def build_alignment_response(duration_ms: int, log_probs: Any, rms: Any, words: dict, beat_grid: dict,
                             repeats: Sequence[Sequence[float]]) -> dict:
    """`repeats`: (start_s, end_s, lag_s, strength): the vocals in [start, end] are sung again lag_s later."""
    frames = len(log_probs)
    out_repeats = []
    for start, end, lag, strength in repeats:
        if not all(math.isfinite(float(x)) for x in (start, end, lag, strength)) or end <= start or lag <= 0:
            continue
        out_repeats.append({"start_ms": round(start * 1000), "end_ms": round(end * 1000), "lag_ms": round(lag * 1000),
                            "strength": round(float(strength), 3)})
    return {
        "model": MODEL,
        "duration_ms": int(duration_ms),
        "frame_ms": duration_ms / frames if frames else 0.0,
        "alphabet": ALPHABET,
        "letter_scale": LETTER_SCALE,
        "letters": encode_letters(log_probs) if frames else "",
        "loudness": encode_loudness(rms) if frames else "",
        "words": words,
        "beat_grid": beat_grid,
        "repeats": out_repeats,
    }


def vocal_repeats(vocals: Any, beats_s: Sequence[float]) -> list:
    """Repeated vocal passages, at least REPEAT_MIN_BEATS beats long: (start_s, end_s, lag_s, strength).

    Chroma and MFCCs of the vocals stem, averaged per beat, compared beat against beat; a run of similar beats along
    one lag (a stripe off the diagonal) is a passage sung again that many beats later.
    """
    import librosa
    import numpy as np
    from scipy.ndimage import uniform_filter1d

    b = np.asarray(beats_s, dtype=np.float64)
    if len(b) < 3 * REPEAT_MIN_BEATS:
        return []
    hop = 512
    frames = librosa.time_to_frames(b, sr=SAMPLE_RATE, hop_length=hop)
    chroma = librosa.feature.chroma_stft(y=vocals, sr=SAMPLE_RATE, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=vocals, sr=SAMPLE_RATE, hop_length=hop, n_mfcc=20)[1:]
    rms = librosa.feature.rms(y=vocals, hop_length=hop)[0]
    mfcc = (mfcc - mfcc.mean(1, keepdims=True)) / (mfcc.std(1, keepdims=True) + 1e-8)
    feat = np.vstack([chroma / (np.linalg.norm(chroma, axis=0, keepdims=True) + 1e-8), 0.25 * mfcc])
    sync = librosa.util.sync(feat, frames, aggregate=np.mean)
    energy = librosa.util.sync(rms[None], frames, aggregate=np.mean)[0]
    sync = sync / (np.linalg.norm(sync, axis=0, keepdims=True) + 1e-8)
    voiced = energy > 0.25 * np.percentile(energy, 90)
    sim = sync.T @ sync
    n = sim.shape[0]
    upper = np.triu_indices(n, k=REPEAT_MIN_BEATS)
    off = sim[upper][np.outer(voiced, voiced)[upper]]
    thr = np.percentile(off, 85) if len(off) else 1.0
    stripes = []
    for lag in range(REPEAT_MIN_BEATS, n - REPEAT_MIN_BEATS):
        d = np.diagonal(sim, lag) * voiced[:n - lag] * voiced[lag:]
        sm = uniform_filter1d(d, REPEAT_MIN_BEATS)
        on = sm >= thr
        i = 0
        while i < len(on):
            if not on[i]:
                i += 1
                continue
            j = i
            while j < len(on) and on[j]:
                j += 1
            if j - i >= REPEAT_MIN_BEATS:
                stripes.append((i, j, lag, float(sm[i:j].mean())))
            i = j
    # the strongest stripe among near-duplicates (neighbouring lags over the same beats)
    stripes.sort(key=lambda s: -(s[1] - s[0]) * s[3])
    kept = []
    for s in stripes:
        if any(abs(s[2] - k[2]) <= 4 and min(s[1], k[1]) - max(s[0], k[0]) > 0.5 * (s[1] - s[0]) for k in kept):
            continue
        kept.append(s)
    at = lambda i: float(b[min(i, len(b) - 1)])
    return [(at(i), at(j), at(i + lag) - at(i), st) for i, j, lag, st in kept]


class AlignmentAnalyzer:
    """Holds Demucs and the MMS model. Not thread-safe on its own: callers serialize (models.py holds the lock)."""

    def __init__(self, models_dir: str) -> None:
        import fractions

        import numpy as np
        import torch
        import torchaudio
        from demucs.htdemucs import HTDemucs
        from demucs.pretrained import get_model

        # The Docker image ships both; elsewhere they are downloaded once into the torch hub cache
        local_stems = os.path.join(models_dir, "demucs")
        # Demucs checkpoints pickle the model class and a few numpy types, which torch.load refuses unless allowed
        safe = [HTDemucs, fractions.Fraction, (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"), np.dtype,
                np.dtypes.Float64DType]
        with torch.serialization.safe_globals(safe):
            self._demucs = (get_model(STEM_MODEL, repo=Path(local_stems)) if os.path.isdir(local_stems) else get_model(STEM_MODEL)).eval()
        local_letters = os.path.join(models_dir, "mms_fa")
        bundle = torchaudio.pipelines.MMS_FA
        self._mms = bundle.get_model(with_star=True, dl_kwargs={"model_dir": local_letters} if os.path.isdir(local_letters) else None).eval()
        labels = bundle.get_labels(star="*")
        self._columns = [labels.index(c) for c in ALPHABET]

    @property
    def stem_rate(self) -> int:
        return int(self._demucs.samplerate)

    def stems(self, stereo: Any) -> tuple:
        """`stereo`: [2, samples] float32 at `stem_rate`. Returns (vocals at 16 kHz, drums at the beat grid's rate)."""
        import torch
        import torchaudio
        from beat_grid import SAMPLE_RATE as BEAT_GRID_SAMPLE_RATE
        from demucs.apply import apply_model

        wav = torch.as_tensor(stereo, dtype=torch.float32)
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        with torch.inference_mode():
            sources = apply_model(self._demucs, ((wav - mean) / std)[None], device="cpu", shifts=0, split=True, overlap=0.1,
                                  progress=False)[0]
        names = list(self._demucs.sources)
        mono = lambda name: (sources[names.index(name)] * std + mean).mean(0)
        vocals = torchaudio.functional.resample(mono("vocals"), self.stem_rate, SAMPLE_RATE).numpy()
        drums = torchaudio.functional.resample(mono("drums"), self.stem_rate, BEAT_GRID_SAMPLE_RATE).numpy()
        return vocals, drums

    def letters(self, vocals: Any) -> Any:
        """Log-probabilities [frames, len(ALPHABET)] over overlapping windows of the vocals stem."""
        import torch

        x = torch.as_tensor(vocals, dtype=torch.float32)
        hop, ctx = int(EMISSION_WINDOW_S * SAMPLE_RATE), int(EMISSION_CONTEXT_S * SAMPLE_RATE)
        parts = []
        with torch.inference_mode():
            for s in range(0, len(x), hop):
                a, b = max(0, s - ctx), min(len(x), s + hop + ctx)
                if b - a < 400:
                    break
                e, _ = self._mms(x[a:b][None])
                e = torch.log_softmax(e[0], dim=-1)
                fps = e.shape[0] / ((b - a) / SAMPLE_RATE)
                lo = int(round((s - a) / SAMPLE_RATE * fps))
                hi = lo + int(round(min(hop, len(x) - s) / SAMPLE_RATE * fps))
                parts.append(e[lo:hi])
        return torch.cat(parts)[:, self._columns].numpy() if parts else torch.zeros((0, len(ALPHABET))).numpy()

