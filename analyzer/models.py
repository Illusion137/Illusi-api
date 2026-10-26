"""Model loading and inference. Everything that touches Mood-Detector or VibeNet lives here.

If either library's API changes, this is the only file to adjust:
- Mood-Detector (https://github.com/usr-wwelsh/Mood-Detector), `mood_detector` package:
  `features.extract_features(path)` -> dict (incl. `spectral_centroid` in Hz) and
  `mood_classifier.classify_mood(features)` -> MoodResult(mood, energy, tempo, key, similarity_scores, explanation).
  We call these two directly instead of `analyze_audio()` because (a) `analyze_audio` rejects files without an
  audio extension (media files are bare UUIDs) and (b) MoodResult doesn't carry brightness. It is rule-based:
  there are no weights to load, importing it is the "load".
- VibeNet (https://github.com/jaeheonshim/vibenet), `vibenet` package: `load_model()` -> EfficientNetModel
  (ONNX); `model.predict(path)` -> [InferenceResult(acousticness, danceability, energy, instrumentalness,
  liveness, speechiness, valence)], all 0-1.

Both read a temporary WAV that ffmpeg decodes from the input (audio.py), so any container ffmpeg understands works
(.m4a, .webm, .ogg, .mp3, .flac, ...), with or without an extension. Nothing writes or deletes the input file.
"""

from __future__ import annotations

import tempfile
import threading
from typing import Any, Protocol

from audio import decode_to_wav, ffmpeg_binary
from contract import ModelError, build_response


class Analyzer(Protocol):
    def analyze(self, path: str) -> dict: ...


class RealAnalyzer:
    """Holds both loaded models. Inference is serialized: CPU-heavy, and the ONNX session is shared."""

    def __init__(self) -> None:
        # --- model loading (adjust here) -------------------------------------------------------------
        import librosa  # noqa: F401  (pulled in by both libraries; fail fast if missing)
        from mood_detector.features import extract_features
        from mood_detector.mood_classifier import classify_mood
        from vibenet import load_model

        self._extract_features = extract_features
        self._classify_mood = classify_mood
        self._vibenet = load_model()
        # ----------------------------------------------------------------------------------------------
        self._ffmpeg = ffmpeg_binary()  # fail the load (health = 503) rather than every request
        self._lock = threading.Lock()

    def analyze(self, path: str) -> dict:
        with self._lock, tempfile.TemporaryDirectory(prefix="illusi-analyzer-") as tmp:
            wav = decode_to_wav(path, tmp, self._ffmpeg)  # DecodeError -> 422
            try:
                features: dict[str, Any] = self._extract_features(wav)
                mood = self._classify_mood(features)
                vibe = self._vibenet.predict(wav)[0]
            except Exception as e:
                raise ModelError(f"{type(e).__name__}: {e}") from e
            return build_response(
                mood=mood.mood,
                tempo=mood.tempo,  # BPM, after Mood-Detector's half-tempo correction
                brightness_hz=features["spectral_centroid"],  # mean spectral centroid, Hz
                key=mood.key,  # "C# major" / "A minor"
                vibenet=vibe.to_dict(),
            )


def load_analyzer() -> Analyzer:
    return RealAnalyzer()
