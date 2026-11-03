"""Pure helpers for the analyzer API contract. No third-party imports."""

from __future__ import annotations

import math
import os
import re
from typing import Any, Mapping, Optional, Sequence

# VibeNet attribute -> response field. VibeNet `energy` is stored as `arousal`.
VIBENET_FIELDS = {
    "acousticness": "acousticness",
    "instrumentalness": "instrumentalness",
    "liveness": "liveness",
    "danceability": "danceability",
    "speechiness": "speechiness",
    "valence": "valence",
    "energy": "arousal",
}

_KEY_RE = re.compile(r"^\s*([A-Ga-g])([#b]?)\s*(major|minor|maj|min|m)?\s*$", re.IGNORECASE)
_PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_NATURAL = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


class BadRequest(Exception):
    """-> 400: path missing, not absolute, outside the allowed roots, or unreadable."""


class DecodeError(Exception):
    """-> 422: the file exists but can't be decoded as audio."""


class ModelError(Exception):
    """-> 500: a model failed or produced unusable output."""


def to_short_key(key: str) -> str:
    """Mood-Detector returns e.g. "C# major" / "A minor"; the DB stores varchar(5) "C#" / "Am"."""
    m = _KEY_RE.match(key or "")
    if not m:
        raise ModelError(f"unrecognised key {key!r}")
    letter, accidental, mode = m.group(1).upper(), m.group(2), (m.group(3) or "major").lower()
    pc = _NATURAL[letter] + (1 if accidental == "#" else -1 if accidental == "b" else 0)
    minor = mode in ("minor", "min", "m")
    return _PITCHES[pc % 12] + ("m" if minor else "")


def _finite(name: str, value: Any) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError) as e:
        raise ModelError(f"{name} is not a number: {value!r}") from e
    if not math.isfinite(f):
        raise ModelError(f"{name} is not finite")
    return f


def _unit(name: str, value: Any) -> float:
    # VibeNet clips descriptors and sigmoids likelihoods, so values are already 0-1; clamp float noise.
    return min(1.0, max(0.0, _finite(name, value)))


MFCC_COUNT = 13
CHROMA_COUNT = 12


def feature_fields(features: Mapping[str, Any]) -> dict:
    """The rest of what Mood-Detector's `extract_features` measures (on its 30 s excerpt, like `tempo`)."""
    mfccs = list(features.get("mfccs") or [])
    chroma = list(features.get("chroma") or [])
    if len(mfccs) != MFCC_COUNT or len(chroma) != CHROMA_COUNT:
        raise ModelError(f"expected {MFCC_COUNT} MFCCs and {CHROMA_COUNT} chroma bins")
    return {
        "tempo_confidence": max(0.0, _finite("tempo_confidence", features.get("tempo_confidence"))),
        "rms_energy": _unit("energy", features.get("energy")),
        "spectral_rolloff": max(0.0, _finite("spectral_rolloff", features.get("spectral_rolloff"))),
        "zero_crossing_rate": _unit("zero_crossing_rate", features.get("zero_crossing_rate")),
        "mfccs": [_finite("mfcc", v) for v in mfccs],
        "chroma": [_unit("chroma", v) for v in chroma],
        "duration_ms": round(max(0.0, _finite("duration", features.get("duration"))) * 1000),
    }


def build_response(mood: str, tempo: Any, brightness_hz: Any, key: str, vibenet: Mapping[str, Any],
                   features: Optional[Mapping[str, Any]] = None, mood_scores: Optional[Mapping[str, Any]] = None) -> dict:
    """Combines Mood-Detector and VibeNet output into the response body."""
    if not isinstance(mood, str) or not mood.strip():
        raise ModelError("empty mood")
    out = {
        "mood": mood.strip(),
        "tempo": max(0.0, _finite("tempo", tempo)),
        "brightness": max(0.0, _finite("brightness", brightness_hz)),
        "key": to_short_key(key),
    }
    for src, dst in VIBENET_FIELDS.items():
        if src not in vibenet:
            raise ModelError(f"VibeNet result missing {src}")
        out[dst] = _unit(src, vibenet[src])
    if features is not None:
        out.update(feature_fields(features))
    if mood_scores is not None:
        out["mood_scores"] = {str(name): _finite("mood score", score) for name, score in mood_scores.items()}
    return out


def validate_path(body: Any, allowed_roots: Sequence[str] = ()) -> str:
    """Checks the request body and returns the absolute, readable file path. Raises BadRequest."""
    if not isinstance(body, dict) or not isinstance(body.get("path"), str) or not body["path"]:
        raise BadRequest('body must be {"path": "/abs/path"}')
    path = body["path"]
    if not os.path.isabs(path):
        raise BadRequest("path must be absolute")
    real = os.path.realpath(path)
    if allowed_roots and not any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in allowed_roots):
        raise BadRequest("path is outside the allowed directories")
    if not os.path.isfile(real):
        raise BadRequest("path does not exist or is not a file")
    if not os.access(real, os.R_OK):
        raise BadRequest("path is not readable")
    return real


def parse_roots(value: Optional[str]) -> list:
    """ANALYZER_PATH_ROOTS: os.pathsep-separated directories requests may point into (optional)."""
    if not value:
        return []
    return [os.path.realpath(p) for p in value.split(os.pathsep) if p.strip()]
