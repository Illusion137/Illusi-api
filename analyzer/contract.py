"""Pure helpers for the analyzer API contract (REQUIREMENTS.md §2.2). No third-party imports."""

from __future__ import annotations

import math
import os
import re
from typing import Any, Mapping, Optional, Sequence

# VibeNet attribute -> response field. VibeNet `energy` is stored as `arousal` (§2.9).
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


def build_response(mood: str, tempo: Any, brightness_hz: Any, key: str, vibenet: Mapping[str, Any]) -> dict:
    """Combines Mood-Detector and VibeNet output into the §2.2 response body."""
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
