/**
 * Polymarket API layer — fetches from Cloudflare Worker proxy.
 *
 * Ports iran_dashboard/api.py to browser JS.
 */

/**
 * Parse deadline date from market question text.
 * Returns a Date (midnight UTC) or null.
 */
function parseMarketDate(market) {
  const question = market.question || "";

  // "by June 30, 2026" → Date (UTC midnight)
  const match = question.match(/by\s+(\w+ \d{1,2},\s*\d{4})/);
  if (match) {
    const parsed = new Date(match[1]);
    if (!isNaN(parsed)) {
      // Force to UTC midnight using LOCAL date components, so "March 1, 2026"
      // always becomes 2026-03-01T00:00Z regardless of the user's timezone.
      return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
    }
  }

  // Fallback: groupItemTitle like "March 31" → assume 2026
  const title = market.groupItemTitle || "";
  if (title) {
    const parsed = new Date(title + ", 2026");
    if (!isNaN(parsed)) {
      return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
    }
  }

  return null;
}

/**
 * Classify a raw market object. Returns enriched object or null.
 */
function classifyMarket(market) {
  const deadline = parseMarketDate(market);
  if (!deadline) return null;

  // Parse JSON-encoded string fields
  let outcomePrices = market.outcomePrices || "[]";
  if (typeof outcomePrices === "string") outcomePrices = JSON.parse(outcomePrices);

  let clobTokenIds = market.clobTokenIds || "[]";
  if (typeof clobTokenIds === "string") clobTokenIds = JSON.parse(clobTokenIds);

  const volume = parseFloat(market.volume || "0") || 0;
  const yesPrice = outcomePrices.length > 0 ? parseFloat(outcomePrices[0]) : 0;
  const yesTokenId = clobTokenIds.length > 0 ? clobTokenIds[0] : null;

  let isNew = false;
  const createdAt = market.createdAt || "";
  if (createdAt) {
    const createdMs = new Date(createdAt).getTime();
    if (!isNaN(createdMs)) {
      const hoursOld = (Date.now() - createdMs) / (1000 * 3600);
      isNew = hoursOld < NEW_MARKET_HOURS;
    }
  }

  return {
    id: market.id,
    question: market.question || "",
    deadlineDate: deadline,
    yesPrice,
    yesTokenId,
    volume,
    isLowVolume: volume < LOW_VOLUME_THRESHOLD,
    isNew,
    isClosed: !!market.closed,
  };
}

/**
 * Fetch everything in a single request via /api/all (dev server bundles
 * markets + all histories server-side). Falls back to individual endpoints
 * if /api/all is not available (e.g. Cloudflare Worker).
 *
 * Returns {markets: [...], histories: {tokenId: [{t,p},...], ...}}.
 */
async function fetchAllData() {
  // Try bundled endpoint first (dev server)
  try {
    const resp = await fetch(`${WORKER_URL}/api/all`);
    if (resp.ok) {
      const data = await resp.json();
      const events = data.events || [];
      if (!events.length) return { markets: [], histories: {} };

      const rawMarkets = events[0].markets || [];
      const classified = rawMarkets.map(classifyMarket).filter(Boolean);
      classified.sort((a, b) => a.deadlineDate - b.deadlineDate);

      // Flatten histories: server returns {tid: {history: [...]}}
      const histories = {};
      for (const [tid, hData] of Object.entries(data.histories || {})) {
        histories[tid] = hData.history || hData || [];
      }

      return { markets: classified, histories };
    }
  } catch (e) {
    // /api/all not available, fall back
  }

  // Fallback: individual endpoints (Cloudflare Worker)
  const markets = await fetchMarkets();
  const histories = await fetchAllHistories(markets);
  return { markets, histories };
}

/**
 * Fetch and classify all markets. Returns sorted array.
 */
async function fetchMarkets() {
  const resp = await fetch(`${WORKER_URL}/api/markets`);
  if (!resp.ok) throw new Error(`Markets fetch failed: ${resp.status}`);

  const events = await resp.json();
  if (!events || !events.length) return [];

  const markets = events[0].markets || [];
  const classified = markets.map(classifyMarket).filter(Boolean);
  classified.sort((a, b) => a.deadlineDate - b.deadlineDate);
  return classified;
}

/**
 * Fetch price history for a single token.
 */
async function fetchHistory(tokenId) {
  const resp = await fetch(`${WORKER_URL}/api/history/${encodeURIComponent(tokenId)}`);
  if (!resp.ok) return [];

  const data = await resp.json();
  return data.history || [];
}

/**
 * Fetch histories for all markets in parallel.
 */
async function fetchAllHistories(markets) {
  const histories = {};
  const promises = [];

  for (const m of markets) {
    if (!m.yesTokenId) continue;
    const tid = m.yesTokenId;
    promises.push(
      fetchHistory(tid).then(
        hist => { histories[tid] = hist; },
        () => { histories[tid] = []; }
      )
    );
  }

  await Promise.all(promises);
  return histories;
}

/**
 * Get the min/max timestamps across all histories.
 * Returns {min: Date, max: Date}.
 */
function getHistoryTimeRange(histories) {
  let minT = Infinity;
  let maxT = -Infinity;

  for (const hist of Object.values(histories)) {
    for (const entry of hist) {
      if (entry.t < minT) minT = entry.t;
      if (entry.t > maxT) maxT = entry.t;
    }
  }

  if (minT === Infinity) {
    const now = new Date();
    return { min: new Date(now - 7 * 86400 * 1000), max: now };
  }

  return { min: new Date(minT * 1000), max: new Date(maxT * 1000) };
}
