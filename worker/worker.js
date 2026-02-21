/**
 * Cloudflare Worker: caching proxy for Polymarket APIs.
 *
 * Endpoints:
 *   GET /api/markets      → gamma-api.polymarket.com/events?slug=us-strikes-iran-by  (60s cache)
 *   GET /api/history/:tid → clob.polymarket.com/prices-history?market={tid}           (300s cache)
 */

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const EVENT_SLUG = "us-strikes-iran-by";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body, status = 200, cacheTtl = 0) {
  const headers = { ...CORS_HEADERS, "Content-Type": "application/json" };
  if (cacheTtl > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheTtl}`;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function corsResponse() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function fetchWithCache(request, upstreamUrl, cacheTtl) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });

  let response = await cache.match(cacheKey);
  if (response) return response;

  const upstream = await fetch(upstreamUrl);
  if (!upstream.ok) {
    return jsonResponse({ error: "Upstream error", status: upstream.status }, 502);
  }

  const data = await upstream.json();
  const resp = jsonResponse(data, 200, cacheTtl);

  // Clone before caching since body can only be read once
  const respToCache = resp.clone();
  await cache.put(cacheKey, respToCache);

  return resp;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return corsResponse();

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/markets") {
      const upstream = `${GAMMA_API}/events?slug=${EVENT_SLUG}`;
      return fetchWithCache(request, upstream, 60);
    }

    const historyMatch = path.match(/^\/api\/history\/(.+)$/);
    if (historyMatch) {
      const tokenId = decodeURIComponent(historyMatch[1]);
      const upstream = `${CLOB_API}/prices-history?market=${encodeURIComponent(tokenId)}&interval=max&fidelity=60`;
      return fetchWithCache(request, upstream, 300);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
