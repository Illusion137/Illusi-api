"""Model loading and inference. Everything that touches Mood-Detector, VibeNet or the vocal models lives here.

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

- Vocals (vocals.py): Essentia's Discogs-EffNet + voice/instrumental head as ONNX files in ANALYZER_MODELS_DIR.
- Rhythm (rhythm.py): Essentia's RhythmExtractor2013, beat positions over the whole track; returned with `/vocals`
  since both describe the full media file over time.
- For lining up lyrics, also with `/vocals`: Whisper word timestamps (words.py, faster-whisper), Silero's voice
  activity (speech.py) and Beat This! beats and downbeats (beat_grid.py).
- `/alignment` (alignment.py): Demucs stems, the MMS model's letter probabilities and loudness of the vocals stem,
  with Whisper and Beat This! run again on the stems. Minutes of CPU per track, so the API only asks for it on
  tracks users play whose lyrics are all unsynced.

All read a temporary WAV that ffmpeg decodes from the input (audio.py), so any container ffmpeg understands works
(.m4a, .webm, .ogg, .mp3, .flac, ...), with or without an extension. Nothing writes or deletes the input file.
"""

from __future__ import annotations

import os
import tempfile
import threading
from typing import Any, Protocol

from audio import decode_to_wav, ffmpeg_binary
from contract import ModelError, build_response

MODELS_DIR = os.environ.get("ANALYZER_MODELS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
# Patch hop in 16 ms frames: 16 = one voice probability every 256 ms.
VOCALS_HOP_FRAMES = int(os.environ.get("ANALYZER_VOCALS_HOP_FRAMES", "16"))
VOCALS_THREADS = int(os.environ.get("ANALYZER_VOCALS_THREADS", "2"))
# faster-whisper model size; the English-only small model is ~0.5 GB in memory and about 0.15x real time on 2 threads.
WHISPER_MODEL = os.environ.get("ANALYZER_WHISPER_MODEL", "small.en")


class Analyzer(Protocol):
    def analyze(self, path: str) -> dict: ...

    def vocals(self, path: str) -> dict: ...

    def alignment(self, path: str) -> dict: ...


class RealAnalyzer:
    """Holds every loaded model. Inference is serialized: CPU-heavy, and the ONNX sessions are shared."""

    def __init__(self) -> None:
        # --- model loading (adjust here) -------------------------------------------------------------
        import librosa  # noqa: F401  (pulled in by both libraries; fail fast if missing)
        from mood_detector.features import extract_features
        from mood_detector.mood_classifier import classify_mood
        from vibenet import load_model

        self._extract_features = extract_features
        self._classify_mood = classify_mood
        self._vibenet = load_model()
        from vocals import VocalDetector

        self._vocals = VocalDetector(MODELS_DIR, VOCALS_HOP_FRAMES, VOCALS_THREADS)
        from rhythm import RhythmExtractor

        self._rhythm = RhythmExtractor()
        import torch

        torch.set_num_threads(VOCALS_THREADS)
        from beat_grid import BeatTracker
        from speech import SpeechDetector
        from words import WordRecognizer

        self._words = WordRecognizer(MODELS_DIR, WHISPER_MODEL, VOCALS_THREADS)
        self._speech = SpeechDetector()
        self._beat_grid = BeatTracker(MODELS_DIR)
        from alignment import AlignmentAnalyzer

        self._alignment = AlignmentAnalyzer(MODELS_DIR)
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
                features=features,
                mood_scores=mood.similarity_scores,
            )


    def vocals(self, path: str) -> dict:
        import soundfile
        from beat_grid import SAMPLE_RATE as BEAT_GRID_SAMPLE_RATE
        from rhythm import SAMPLE_RATE as RHYTHM_SAMPLE_RATE
        from vocals import SAMPLE_RATE

        with self._lock, tempfile.TemporaryDirectory(prefix="illusi-analyzer-") as tmp:
            wav = decode_to_wav(path, tmp, self._ffmpeg, SAMPLE_RATE)  # DecodeError -> 422
            rhythm_wav = decode_to_wav(path, tmp, self._ffmpeg, RHYTHM_SAMPLE_RATE)
            beat_grid_wav = decode_to_wav(path, tmp, self._ffmpeg, BEAT_GRID_SAMPLE_RATE)
            try:
                # Whisper, Silero and EffNet all read the 16 kHz decode
                audio, _ = soundfile.read(wav, dtype="float32")
                result = self._vocals.detect(audio)
                result["speech"] = self._speech.detect(audio)
                result["words"] = self._words.detect(audio)
                rhythm_audio, _ = soundfile.read(rhythm_wav, dtype="float32")
                result["rhythm"] = self._rhythm.detect(rhythm_audio)
                beat_grid_audio, _ = soundfile.read(beat_grid_wav, dtype="float32")
                result["beat_grid"] = self._beat_grid.detect(beat_grid_audio)
                return result
            except Exception as e:
                raise ModelError(f"{type(e).__name__}: {e}") from e


    def alignment(self, path: str) -> dict:
        import soundfile
        from alignment import build_alignment_response, frame_rms, vocal_repeats

        with self._lock, tempfile.TemporaryDirectory(prefix="illusi-analyzer-") as tmp:
            wav = decode_to_wav(path, tmp, self._ffmpeg, self._alignment.stem_rate, channels=2)  # DecodeError -> 422
            try:
                stereo, _ = soundfile.read(wav, dtype="float32", always_2d=True)
                vocals, drums = self._alignment.stems(stereo.T)
                log_probs = self._alignment.letters(vocals)
                beat_grid = self._beat_grid.detect(drums)
                beats_s = [ms / 1000 for ms in beat_grid["beats_ms"]]
                return build_alignment_response(round(stereo.shape[0] * 1000 / self._alignment.stem_rate), log_probs,
                                                frame_rms(vocals, len(log_probs)), self._words.detect(vocals), beat_grid,
                                                vocal_repeats(vocals, beats_s))
            except Exception as e:
                raise ModelError(f"{type(e).__name__}: {e}") from e


def load_analyzer() -> Analyzer:
    return RealAnalyzer()
