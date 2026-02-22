/**
 * Data processing: PCHIP interpolation, CDF/PDF computation, snapshots.
 *
 * Ports iran_dashboard/data.py to browser JS.
 * Uses days-since-epoch as the numeric x-axis for interpolation.
 */

// ─── Date ↔ ordinal helpers ────────────────────────────────────────────

const MS_PER_DAY = 86400000;
const EPOCH = Date.UTC(1970, 0, 1); // 0

/** Date → days since Unix epoch (float, UTC midnight = integer). */
function dateToOrdinal(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS_PER_DAY;
}

/** Days since epoch → Date (UTC midnight). */
function ordinalToDate(ord) {
  return new Date(Math.round(ord) * MS_PER_DAY);
}

/** Format a Date as "YYYY-MM-DD" for Plotly x-axis. */
function ordinalToIso(ord) {
  const d = ordinalToDate(ord);
  return d.toISOString().slice(0, 10);
}

// ─── PCHIP interpolation (Fritsch–Carlson) ─────────────────────────────

/**
 * PCHIP (Piecewise Cubic Hermite Interpolating Polynomial).
 *
 * Given (x, y) data, compute slopes using the Fritsch–Carlson method
 * and evaluate the cubic at arbitrary points.
 *
 * Monotonicity-preserving: if the data is monotone, so is the interpolant.
 */
function pchipSlopes(x, y) {
  const n = x.length;
  const d = new Float64Array(n); // slopes to compute

  if (n < 2) return d;
  if (n === 2) {
    const s = (y[1] - y[0]) / (x[1] - x[0]);
    d[0] = s;
    d[1] = s;
    return d;
  }

  // Secant slopes between consecutive points
  const delta = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    delta[i] = (y[i + 1] - y[i]) / (x[i + 1] - x[i]);
  }

  // Interior points: Fritsch–Carlson
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      // Local extremum or flat → zero slope
      d[i] = 0;
    } else {
      // Weighted harmonic mean
      const w1 = 2 * (x[i + 1] - x[i]) + (x[i] - x[i - 1]);
      const w2 = (x[i + 1] - x[i]) + 2 * (x[i] - x[i - 1]);
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  // Endpoints: one-sided shape-preserving
  d[0] = endpointSlope(x[0], x[1], x[2], delta[0], delta[1]);
  d[n - 1] = endpointSlope(
    x[n - 1], x[n - 2], x[n - 3],
    delta[n - 2], delta[n - 3]
  );

  return d;
}

/** Endpoint slope using non-centered three-point formula, clamped for monotonicity. */
function endpointSlope(x0, x1, x2, d0, d1) {
  const h0 = x1 - x0;
  const h1 = x2 - x1;
  let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);

  // Clamp to preserve monotonicity
  if (Math.sign(s) !== Math.sign(d0)) {
    s = 0;
  } else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > 3 * Math.abs(d0)) {
    s = 3 * d0;
  }
  return s;
}

/**
 * Evaluate the PCHIP interpolant at points in `xNew`.
 *
 * @param {Float64Array|number[]} x  — knot x coordinates (sorted, ascending)
 * @param {Float64Array|number[]} y  — knot y values
 * @param {Float64Array|number[]} xNew — evaluation points
 * @returns {Float64Array} interpolated y values
 */
function pchipInterpolate(x, y, xNew) {
  const n = x.length;
  const slopes = pchipSlopes(x, y);
  const out = new Float64Array(xNew.length);

  let seg = 0; // current segment index
  for (let j = 0; j < xNew.length; j++) {
    const xv = xNew[j];

    // Advance segment pointer
    while (seg < n - 2 && xv > x[seg + 1]) seg++;

    const h = x[seg + 1] - x[seg];
    const t = (xv - x[seg]) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    // Hermite basis functions
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    out[j] = h00 * y[seg] + h10 * h * slopes[seg] + h01 * y[seg + 1] + h11 * h * slopes[seg + 1];
  }

  return out;
}

// ─── CDF / PDF building (ports data.py) ────────────────────────────────

/**
 * Build CDF data points from classified markets.
 *
 * @param {Object[]} markets — classified market objects
 * @param {Object|null} prices — {tokenId: price} overrides (historical). null = use current.
 * @param {Date|null} anchorDate — prepend P=0 anchor. Defaults to today.
 * @returns {{dates: number[], cdfValues: number[], usedMarkets: (Object|null)[]}}
 */
function buildCdfPoints(markets, prices = null, anchorDate = null) {
  if (!anchorDate) anchorDate = new Date();
  const anchorOrd = dateToOrdinal(anchorDate);

  const points = [];
  for (const m of markets) {
    const deadlineOrd = dateToOrdinal(m.deadlineDate);
    if (deadlineOrd <= anchorOrd) continue; // skip past-due

    let p;
    if (prices !== null) {
      if (!(m.yesTokenId in prices)) continue;
      p = prices[m.yesTokenId];
    } else {
      if (m.isClosed) continue;
      p = m.yesPrice;
    }

    points.push({ ord: deadlineOrd, p, market: m });
  }

  if (points.length === 0) {
    return { dates: [], cdfValues: [], usedMarkets: [] };
  }

  // Sort by date
  points.sort((a, b) => a.ord - b.ord);

  // Prepend anchor at P=0
  const dates = [anchorOrd, ...points.map(pt => pt.ord)];
  const cdfValues = [0, ...points.map(pt => pt.p)];
  const usedMarkets = [null, ...points.map(pt => pt.market)];

  // Enforce monotonicity via forward-clipping
  for (let i = 1; i < cdfValues.length; i++) {
    cdfValues[i] = Math.max(cdfValues[i], cdfValues[i - 1]);
  }

  return { dates, cdfValues, usedMarkets };
}

/**
 * Interpolate CDF using PCHIP on a daily grid.
 *
 * @returns {{fineDates: Float64Array, fineCdf: Float64Array}}
 */
function interpolateCdf(dates, cdfValues) {
  if (dates.length < 2) {
    return { fineDates: Float64Array.from(dates), fineCdf: Float64Array.from(cdfValues) };
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  const nDays = Math.ceil(last - first) + 1;
  const fineDates = new Float64Array(nDays);
  for (let i = 0; i < nDays; i++) fineDates[i] = first + i;

  let fineCdf = pchipInterpolate(
    Float64Array.from(dates),
    Float64Array.from(cdfValues),
    fineDates
  );

  // Clip to [0, 1]
  for (let i = 0; i < fineCdf.length; i++) {
    fineCdf[i] = Math.max(0, Math.min(1, fineCdf[i]));
  }

  return { fineDates, fineCdf };
}

/**
 * Compute PDF by central differences of the CDF (matches np.gradient).
 */
function computePdf(fineDates, fineCdf) {
  const n = fineDates.length;
  const pdf = new Float64Array(n);

  if (n < 2) return pdf;

  // First point: forward difference
  pdf[0] = (fineCdf[1] - fineCdf[0]) / (fineDates[1] - fineDates[0]);

  // Interior: central differences
  for (let i = 1; i < n - 1; i++) {
    pdf[i] = (fineCdf[i + 1] - fineCdf[i - 1]) / (fineDates[i + 1] - fineDates[i - 1]);
  }

  // Last point: backward difference
  pdf[n - 1] = (fineCdf[n - 1] - fineCdf[n - 2]) / (fineDates[n - 1] - fineDates[n - 2]);

  // Clip negatives to 0
  for (let i = 0; i < n; i++) {
    if (pdf[i] < 0) pdf[i] = 0;
  }

  return pdf;
}

/**
 * Build CDF + PDF curves for a historical point in time.
 *
 * @param {Object[]} markets
 * @param {Object} histories — {tokenId: [{t, p}, ...]}
 * @param {Date} asOf
 * @returns {{fineDates, fineCdf, finePdf, usedMarkets} | null}
 */
function buildSnapshot(markets, histories, asOf) {
  const asOfTs = asOf.getTime() / 1000;
  const anchor = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));

  // Look up each market's price at asOf
  const prices = {};
  for (const m of markets) {
    const tid = m.yesTokenId;
    if (!tid || !histories[tid]) continue;

    const history = histories[tid];
    if (!history.length) continue;

    let bestEntry = null;
    for (const entry of history) {
      if (entry.t <= asOfTs) {
        if (!bestEntry || entry.t > bestEntry.t) {
          bestEntry = entry;
        }
      }
    }

    if (bestEntry) prices[tid] = bestEntry.p;
  }

  if (Object.keys(prices).length === 0) return null;

  const { dates, cdfValues, usedMarkets } = buildCdfPoints(markets, prices, anchor);
  if (dates.length < 2) return null;

  const { fineDates, fineCdf } = interpolateCdf(dates, cdfValues);
  const finePdf = computePdf(fineDates, fineCdf);

  return { fineDates, fineCdf, finePdf, usedMarkets };
}

/**
 * Find the date (as ordinal float) where the CDF crosses a given percentile.
 * Linearly interpolates between grid points for sub-day precision.
 *
 * @param {Float64Array} fineDates — daily grid ordinals
 * @param {Float64Array} fineCdf — CDF values on that grid
 * @param {number} percentile — target CDF value (e.g. 0.25, 0.50, 0.75)
 * @returns {number|null} ordinal (float) or null if CDF never reaches the percentile
 */
function getPercentileDate(fineDates, fineCdf, percentile) {
  for (let i = 0; i < fineCdf.length; i++) {
    if (fineCdf[i] >= percentile) {
      if (i === 0) return fineDates[0];
      // Linear interpolation between [i-1] and [i]
      const frac = (percentile - fineCdf[i - 1]) / (fineCdf[i] - fineCdf[i - 1]);
      return fineDates[i - 1] + frac * (fineDates[i] - fineDates[i - 1]);
    }
  }
  return null;
}

/**
 * Build the median timeline: for each historical timestamp, compute the
 * predicted strike date at percentiles 25, 50, 75.
 *
 * @param {Object[]} markets — classified market objects
 * @param {Object} histories — {tokenId: [{t, p}, ...]} sorted by t
 * @returns {{times: Date[], p25: (string|null)[], p50: (string|null)[], p75: (string|null)[]}}
 */
function buildMedianTimeline(markets, histories) {
  // Find the overall time range from all histories
  let minTs = Infinity, maxTs = -Infinity;
  for (const tid of Object.keys(histories)) {
    for (const entry of histories[tid]) {
      if (entry.t < minTs) minTs = entry.t;
      if (entry.t > maxTs) maxTs = entry.t;
    }
  }

  if (minTs === Infinity) {
    return { times: [], p25: [], p50: [], p75: [] };
  }

  // Generate evenly-spaced hourly grid (forward-fills prices across gaps)
  const HOUR = 3600;
  const gridTimestamps = [];
  for (let ts = minTs; ts <= maxTs; ts += HOUR) {
    gridTimestamps.push(ts);
  }

  // Pre-sort each history for binary search
  const sortedHistories = {};
  for (const tid of Object.keys(histories)) {
    sortedHistories[tid] = histories[tid].slice().sort((a, b) => a.t - b.t);
  }

  const times = [];
  const p25Arr = [];
  const p50Arr = [];
  const p75Arr = [];

  for (const ts of gridTimestamps) {
    const asOfDate = new Date(ts * 1000);
    const anchor = new Date(Date.UTC(
      asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), asOfDate.getUTCDate()
    ));

    // Binary search for each market's price at this timestamp
    const prices = {};
    for (const m of markets) {
      const tid = m.yesTokenId;
      if (!tid || !sortedHistories[tid]) continue;
      const hist = sortedHistories[tid];
      if (hist.length === 0) continue;

      // Binary search: find largest t <= ts
      let lo = 0, hi = hist.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (hist[mid].t <= ts) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best >= 0) prices[tid] = hist[best].p;
    }

    if (Object.keys(prices).length === 0) continue;

    const { dates, cdfValues } = buildCdfPoints(markets, prices, anchor);
    if (dates.length < 2) continue;

    const { fineDates, fineCdf } = interpolateCdf(dates, cdfValues);

    const q25 = getPercentileDate(fineDates, fineCdf, 0.25);
    const q50 = getPercentileDate(fineDates, fineCdf, 0.50);
    const q75 = getPercentileDate(fineDates, fineCdf, 0.75);

    // Fallback: when CDF doesn't reach a percentile, use end-of-year
    const FALLBACK = "2026-12-31";
    times.push(asOfDate);
    p25Arr.push(q25 !== null ? ordinalToIso(q25) : null);
    p50Arr.push(q50 !== null ? ordinalToIso(q50) : FALLBACK);
    p75Arr.push(q75 !== null ? ordinalToIso(q75) : FALLBACK);
  }

  // Append one "live" point using current market prices
  const { dates: liveDates, cdfValues: liveCdf } = buildCdfPoints(markets);
  if (liveDates.length >= 2) {
    const { fineDates: liveFd, fineCdf: liveFc } = interpolateCdf(liveDates, liveCdf);
    const liveQ25 = getPercentileDate(liveFd, liveFc, 0.25);
    const liveQ50 = getPercentileDate(liveFd, liveFc, 0.50);
    const liveQ75 = getPercentileDate(liveFd, liveFc, 0.75);

    const FALLBACK = "2026-12-31";
    times.push(new Date());
    p25Arr.push(liveQ25 !== null ? ordinalToIso(liveQ25) : null);
    p50Arr.push(liveQ50 !== null ? ordinalToIso(liveQ50) : FALLBACK);
    p75Arr.push(liveQ75 !== null ? ordinalToIso(liveQ75) : FALLBACK);
  }

  return { times, p25: p25Arr, p50: p50Arr, p75: p75Arr };
}

/**
 * Look up each market's price at a given historical time.
 * Returns {tokenId: price}.
 */
function getHistoricalPrices(markets, histories, asOf) {
  const asOfTs = asOf.getTime() / 1000;
  const prices = {};

  for (const m of markets) {
    const tid = m.yesTokenId;
    if (!tid || !histories[tid]) continue;
    const history = histories[tid];
    if (!history.length) continue;

    let bestEntry = null;
    for (const entry of history) {
      if (entry.t <= asOfTs) {
        if (!bestEntry || entry.t > bestEntry.t) bestEntry = entry;
      }
    }
    if (bestEntry) prices[tid] = bestEntry.p;
  }

  return prices;
}
