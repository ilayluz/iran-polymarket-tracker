"""Data processing: CDF/PDF interpolation from Polymarket data."""

from datetime import date, datetime, timedelta, timezone

import numpy as np
from scipy.interpolate import PchipInterpolator


def _date_to_ordinal(d: date) -> float:
    """Convert a date to a float ordinal for interpolation."""
    return d.toordinal()


def _ordinal_to_date(o: float) -> date:
    """Convert a float ordinal back to a date."""
    return date.fromordinal(int(round(o)))


def build_cdf_points(
    markets: list[dict],
    prices: dict[str, float] | None = None,
    anchor_date: date | None = None,
) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """
    Build CDF data points from classified markets.

    Args:
        markets: list of classified market dicts (from api.classify_market)
        prices: optional {token_id: price} override (for historical snapshots).
                If None, uses market['yes_price'] (current prices).
        anchor_date: date to prepend as P=0 anchor. Defaults to today.

    Returns:
        dates: array of ordinal values
        cdf_values: array of probabilities [0, 1]
        used_markets: the market dicts that were used (for marker display)
    """
    if anchor_date is None:
        anchor_date = date.today()

    points = []
    used_markets = []

    for m in markets:
        deadline = m["deadline_date"]
        if deadline <= anchor_date:
            continue  # skip past-due markets

        if prices is not None:
            tid = m["yes_token_id"]
            if tid not in prices:
                continue
            p = prices[tid]
        else:
            if m["is_closed"]:
                continue  # skip closed markets for current view
            p = m["yes_price"]

        points.append((_date_to_ordinal(deadline), p, m))

    if not points:
        return np.array([]), np.array([]), []

    # Sort by date
    points.sort(key=lambda x: x[0])

    # Prepend anchor at anchor_date with P=0
    anchor_ord = _date_to_ordinal(anchor_date)
    dates = [anchor_ord] + [p[0] for p in points]
    values = [0.0] + [p[1] for p in points]
    used_markets = [None] + [p[2] for p in points]

    dates = np.array(dates, dtype=float)
    values = np.array(values, dtype=float)

    # Enforce monotonicity via forward-clipping
    for i in range(1, len(values)):
        values[i] = max(values[i], values[i - 1])

    return dates, values, used_markets


def interpolate_cdf(
    dates: np.ndarray, cdf_values: np.ndarray, fine_dates: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """
    Interpolate CDF using PCHIP (monotone-preserving cubic interpolation).

    Returns:
        fine_dates: daily grid
        fine_cdf: interpolated CDF values clipped to [0, 1]
    """
    if len(dates) < 2:
        return dates, cdf_values

    if fine_dates is None:
        fine_dates = np.arange(dates[0], dates[-1] + 1, 1.0)

    interp = PchipInterpolator(dates, cdf_values)
    fine_cdf = interp(fine_dates)
    fine_cdf = np.clip(fine_cdf, 0.0, 1.0)

    return fine_dates, fine_cdf


def compute_pdf(fine_dates: np.ndarray, fine_cdf: np.ndarray) -> np.ndarray:
    """
    Compute PDF by differentiating the CDF.

    Returns probability density per day, with negatives clipped to 0.
    """
    if len(fine_dates) < 2:
        return np.zeros_like(fine_dates)

    pdf = np.gradient(fine_cdf, fine_dates)
    pdf = np.clip(pdf, 0.0, None)
    return pdf


def build_snapshot(
    markets: list[dict],
    histories: dict[str, list[dict]],
    as_of: datetime,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
    """
    Build CDF and PDF curves for a historical point in time.

    Args:
        markets: all classified markets (open + closed)
        histories: {token_id: [{t: unix_ts, p: price}, ...]}
        as_of: the datetime to reconstruct

    Returns:
        fine_dates, fine_cdf, fine_pdf, used_markets
    """
    as_of_ts = as_of.timestamp()
    anchor = as_of.date()

    # Look up each market's price at as_of
    prices = {}
    for m in markets:
        tid = m["yes_token_id"]
        if tid is None or tid not in histories:
            continue

        history = histories[tid]
        if not history:
            continue

        # Find the entry closest to (but not after) as_of
        best_entry = None
        for entry in history:
            t = entry["t"]
            if t <= as_of_ts:
                if best_entry is None or t > best_entry["t"]:
                    best_entry = entry

        if best_entry is not None:
            prices[tid] = best_entry["p"]

    if not prices:
        empty = np.array([])
        return empty, empty, empty, []

    dates, cdf_values, used_markets = build_cdf_points(markets, prices=prices, anchor_date=anchor)

    if len(dates) < 2:
        return dates, cdf_values, np.zeros_like(cdf_values), used_markets

    fine_dates, fine_cdf = interpolate_cdf(dates, cdf_values)
    fine_pdf = compute_pdf(fine_dates, fine_cdf)

    return fine_dates, fine_cdf, fine_pdf, used_markets


def get_history_time_range(histories: dict[str, list[dict]]) -> tuple[datetime, datetime]:
    """Get the overall min/max timestamps across all histories."""
    min_t = float("inf")
    max_t = float("-inf")

    for hist in histories.values():
        for entry in hist:
            t = entry["t"]
            min_t = min(min_t, t)
            max_t = max(max_t, t)

    if min_t == float("inf"):
        now = datetime.now(timezone.utc)
        return now - timedelta(days=7), now

    return (
        datetime.fromtimestamp(min_t, tz=timezone.utc),
        datetime.fromtimestamp(max_t, tz=timezone.utc),
    )
