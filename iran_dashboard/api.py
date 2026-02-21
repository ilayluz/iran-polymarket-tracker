"""Polymarket API fetching layer for US-Iran strike markets."""

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date, timezone

import requests

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
EVENT_SLUG = "us-strikes-iran-by"

LOW_VOLUME_THRESHOLD = 100_000  # $100K
NEW_MARKET_HOURS = 48


class TTLCache:
    """Simple in-memory cache with time-to-live expiry."""

    def __init__(self, ttl_seconds: int = 300):
        self._store: dict[str, tuple[float, object]] = {}
        self._ttl = ttl_seconds

    def get(self, key: str):
        if key in self._store:
            ts, val = self._store[key]
            if time.time() - ts < self._ttl:
                return val
            del self._store[key]
        return None

    def set(self, key: str, value: object):
        self._store[key] = (time.time(), value)


_market_cache = TTLCache(ttl_seconds=300)
_history_cache = TTLCache(ttl_seconds=3600)


def fetch_event_markets() -> list[dict]:
    """Fetch all submarkets for the US-Iran strike event from Gamma API."""
    cached = _market_cache.get("markets")
    if cached is not None:
        return cached

    resp = requests.get(
        f"{GAMMA_API}/events",
        params={"slug": EVENT_SLUG},
        timeout=30,
    )
    resp.raise_for_status()
    events = resp.json()
    if not events:
        return []

    event = events[0]
    markets = event.get("markets", [])
    _market_cache.set("markets", markets)
    return markets


def parse_market_date(market: dict) -> date | None:
    """Extract the deadline date from the market question text."""
    question = market.get("question", "")
    match = re.search(r"by\s+(\w+ \d{1,2},\s*\d{4})", question)
    if match:
        date_str = match.group(1)
        try:
            return datetime.strptime(date_str, "%B %d, %Y").date()
        except ValueError:
            pass

    # Fallback: try groupItemTitle (e.g. "March 31") + assume 2026
    title = market.get("groupItemTitle", "")
    if title:
        try:
            return datetime.strptime(f"{title}, 2026", "%B %d, %Y").date()
        except ValueError:
            pass

    return None


def classify_market(market: dict) -> dict | None:
    """Augment a raw market dict with parsed fields. Returns None if unparseable."""
    deadline = parse_market_date(market)
    if deadline is None:
        return None

    # Parse JSON-encoded fields
    outcome_prices = market.get("outcomePrices", "[]")
    if isinstance(outcome_prices, str):
        outcome_prices = json.loads(outcome_prices)

    clob_token_ids = market.get("clobTokenIds", "[]")
    if isinstance(clob_token_ids, str):
        clob_token_ids = json.loads(clob_token_ids)

    volume_str = market.get("volume", "0")
    volume = float(volume_str) if volume_str else 0.0

    yes_price = float(outcome_prices[0]) if outcome_prices else 0.0
    yes_token_id = clob_token_ids[0] if clob_token_ids else None

    created_at = market.get("createdAt", "")
    is_new = False
    if created_at:
        try:
            created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            hours_old = (datetime.now(timezone.utc) - created_dt).total_seconds() / 3600
            is_new = hours_old < NEW_MARKET_HOURS
        except (ValueError, TypeError):
            pass

    is_closed = market.get("closed", False)

    return {
        "id": market.get("id"),
        "question": market.get("question", ""),
        "deadline_date": deadline,
        "yes_price": yes_price,
        "yes_token_id": yes_token_id,
        "volume": volume,
        "is_low_volume": volume < LOW_VOLUME_THRESHOLD,
        "is_new": is_new,
        "is_closed": is_closed,
    }


def fetch_price_history(token_id: str, interval: str = "max", fidelity: int = 60) -> list[dict]:
    """Fetch historical price data for a token from the CLOB API."""
    cache_key = f"history:{token_id}:{interval}:{fidelity}"
    cached = _history_cache.get(cache_key)
    if cached is not None:
        return cached

    resp = requests.get(
        f"{CLOB_API}/prices-history",
        params={"market": token_id, "interval": interval, "fidelity": fidelity},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    history = data.get("history", [])
    _history_cache.set(cache_key, history)
    return history


def get_classified_markets() -> list[dict]:
    """Fetch and classify all markets, sorted by deadline date."""
    raw_markets = fetch_event_markets()
    classified = []
    for m in raw_markets:
        c = classify_market(m)
        if c is not None:
            classified.append(c)
    classified.sort(key=lambda m: m["deadline_date"])
    return classified


def fetch_all_histories(markets: list[dict], max_workers: int = 8) -> dict[str, list[dict]]:
    """Fetch price histories for all markets in parallel. Returns {token_id: history}."""
    histories = {}
    tokens_to_fetch = []

    for m in markets:
        tid = m["yes_token_id"]
        if tid:
            cached = _history_cache.get(f"history:{tid}:max:60")
            if cached is not None:
                histories[tid] = cached
            else:
                tokens_to_fetch.append(tid)

    if tokens_to_fetch:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_to_tid = {
                pool.submit(fetch_price_history, tid): tid for tid in tokens_to_fetch
            }
            for future in as_completed(future_to_tid):
                tid = future_to_tid[future]
                try:
                    histories[tid] = future.result()
                except Exception:
                    histories[tid] = []

    return histories
