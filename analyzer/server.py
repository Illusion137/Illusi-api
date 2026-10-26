"""Illusi music analyzer: a small localhost HTTP API around Mood-Detector + VibeNet.

GET  /health   -> 200 {"status":"ok"} once both models are loaded, 503 while loading / if loading failed.
POST /analyze  {"path": "/abs/file"} -> 200 combined JSON | 400 bad path | 422 undecodable | 500 model failure
               | 503 models not loaded yet.

Env: ANALYZER_URL (host/port to bind, default http://127.0.0.1:8765), or ANALYZER_HOST / ANALYZER_PORT;
ANALYZER_PATH_ROOTS (optional, os.pathsep-separated dirs requests may point into);
ANALYZER_ALLOW_REMOTE=1 to allow binding a non-loopback address (don't).
The input file is never deleted or modified.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional
from urllib.parse import urlparse

from contract import BadRequest, DecodeError, ModelError, parse_roots, validate_path

log = logging.getLogger("analyzer")
MAX_BODY = 64 * 1024


class State:
    def __init__(self) -> None:
        self.analyzer = None
        self.error: Optional[str] = None
        self.roots = parse_roots(os.environ.get("ANALYZER_PATH_ROOTS"))


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        server_version = "illusi-analyzer"

        def log_message(self, fmt: str, *args) -> None:  # route through logging
            log.info("%s %s", self.address_string(), fmt % args)

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path != "/health":
                return self._send(404, {"error": "not found"})
            if state.analyzer is not None:
                return self._send(200, {"status": "ok"})
            return self._send(503, {"status": "error" if state.error else "loading", "error": state.error})

        def do_POST(self) -> None:
            if self.path != "/analyze":
                return self._send(404, {"error": "not found"})
            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY:
                return self._send(400, {"error": "missing or oversized body"})
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError):
                return self._send(400, {"error": "invalid JSON"})
            if state.analyzer is None:
                return self._send(503, {"error": "models not loaded"})
            started = time.monotonic()
            try:
                path = validate_path(body, state.roots)
                result = state.analyzer.analyze(path)
            except BadRequest as e:
                return self._send(400, {"error": str(e)})
            except DecodeError as e:
                return self._send(422, {"error": str(e)})
            except ModelError as e:
                log.exception("model failure")
                return self._send(500, {"error": str(e)})
            except Exception as e:  # anything else is a model/runtime failure, never the caller's fault
                log.exception("unexpected failure")
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})
            log.info("analyzed %s in %.1fs", path, time.monotonic() - started)
            return self._send(200, result)

    return Handler


def bind_address() -> tuple[str, int]:
    url = urlparse(os.environ.get("ANALYZER_URL", "http://127.0.0.1:8765"))
    host = os.environ.get("ANALYZER_HOST") or url.hostname or "127.0.0.1"
    port = int(os.environ.get("ANALYZER_PORT") or url.port or 8765)
    if host == "localhost":
        host = "127.0.0.1"
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback and os.environ.get("ANALYZER_ALLOW_REMOTE") != "1":
        raise SystemExit(f"refusing to bind non-loopback host {host!r} (set ANALYZER_ALLOW_REMOTE=1 to override)")
    return host, port


def serve(load: Callable[[], object], host: str, port: int, state: Optional[State] = None) -> ThreadingHTTPServer:
    """Starts serving immediately (health = 503) and loads the models once in the background."""
    state = state or State()
    httpd = ThreadingHTTPServer((host, port), make_handler(state))
    httpd.daemon_threads = True

    def load_models() -> None:
        try:
            started = time.monotonic()
            state.analyzer = load()
            log.info("models loaded in %.1fs", time.monotonic() - started)
        except Exception as e:
            state.error = f"{type(e).__name__}: {e}"
            log.exception("failed to load models")

    threading.Thread(target=load_models, name="load-models", daemon=True).start()
    return httpd


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    host, port = bind_address()
    from models import load_analyzer

    httpd = serve(load_analyzer, host, port)
    log.info("listening on http://%s:%d", host, port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
