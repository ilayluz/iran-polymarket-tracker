"""
Local dev server: serves docs/ static files + proxies /api/* to Polymarket.

Usage:
    uv run python dev_server.py

Opens http://localhost:8000 in your browser. The server proxies API requests
to Polymarket so no Cloudflare Worker is needed for local development.
Responses are cached in memory so page refreshes are instant.
Press Ctrl+C to stop.
"""

import http.server
import json
import os
import socketserver
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests as req_lib

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
EVENT_SLUG = "us-strikes-iran-by"
DOCS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")
PORT = 8000

# In-memory cache: {key: (timestamp, data)}
_cache = {}
_cache_lock = threading.Lock()
MARKETS_TTL = 60       # 1 minute
HISTORY_TTL = 300      # 5 minutes
ALL_TTL = 60           # 1 minute (for /api/all bundle)


def _get_cached(key, ttl):
    with _cache_lock:
        if key in _cache:
            ts, data = _cache[key]
            if time.time() - ts < ttl:
                return data
    return None


def _set_cached(key, data):
    with _cache_lock:
        _cache[key] = (time.time(), data)


def _fetch_url(url):
    """Fetch a URL, return bytes or None on error."""
    try:
        resp = req_lib.get(url, timeout=30)
        resp.raise_for_status()
        return resp.content
    except Exception:
        return None


def _build_all_data():
    """Fetch markets + all histories server-side, return combined JSON bytes."""
    cached = _get_cached("__all__", ALL_TTL)
    if cached is not None:
        return cached

    # Fetch markets
    markets_url = f"{GAMMA_API}/events?slug={EVENT_SLUG}"
    markets_data = _fetch_url(markets_url)
    if not markets_data:
        return json.dumps({"events": [], "histories": {}}).encode()

    events = json.loads(markets_data)
    if not events:
        return json.dumps({"events": [], "histories": {}}).encode()

    # Extract token IDs from all markets
    all_markets = events[0].get("markets", [])
    token_ids = []
    for m in all_markets:
        clob_ids = m.get("clobTokenIds", "[]")
        if isinstance(clob_ids, str):
            clob_ids = json.loads(clob_ids)
        if clob_ids:
            token_ids.append(clob_ids[0])

    # Fetch all histories in parallel
    histories = {}

    def fetch_history(tid):
        cache_key = f"history:{tid}"
        cached = _get_cached(cache_key, HISTORY_TTL)
        if cached is not None:
            return tid, json.loads(cached)
        url = f"{CLOB_API}/prices-history?market={tid}&interval=max&fidelity=60"
        data = _fetch_url(url)
        if data:
            _set_cached(cache_key, data)
            return tid, json.loads(data)
        return tid, {"history": []}

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(fetch_history, tid): tid for tid in token_ids}
        for future in as_completed(futures):
            tid, hist_data = future.result()
            histories[tid] = hist_data

    result = json.dumps({"events": events, "histories": histories}).encode()
    _set_cached("__all__", result)
    return result


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DOCS_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/all":
            self._serve_all()
        elif parsed.path == "/api/markets":
            upstream = f"{GAMMA_API}/events?slug={EVENT_SLUG}"
            self._proxy(upstream, MARKETS_TTL)
        elif parsed.path.startswith("/api/history/"):
            token_id = parsed.path.split("/api/history/", 1)[1]
            upstream = f"{CLOB_API}/prices-history?market={token_id}&interval=max&fidelity=60"
            self._proxy(upstream, HISTORY_TTL)
        else:
            super().do_GET()

    def _serve_all(self):
        """Serve markets + all histories in a single response."""
        data = _build_all_data()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _proxy(self, upstream_url, ttl):
        cached = _get_cached(upstream_url, ttl)
        if cached is not None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(cached)
            return

        try:
            resp = req_lib.get(upstream_url, timeout=30)
            resp.raise_for_status()
            data = resp.content
            _set_cached(upstream_url, data)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        if self.path.startswith("/api/"):
            print(f"  {self.path[:80]}")


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Handle each request in a separate thread — parallel API proxying."""
    daemon_threads = True


if __name__ == "__main__":
    server = ThreadedServer(("127.0.0.1", PORT), DevHandler)

    url = f"http://localhost:{PORT}"
    print(f"Dev server running at {url}")
    print(f"Serving docs/ + proxying /api/* to Polymarket")
    print(f"Cache: markets={MARKETS_TTL}s, histories={HISTORY_TTL}s, all={ALL_TTL}s")
    print(f"Press Ctrl+C to stop\n")

    threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()
