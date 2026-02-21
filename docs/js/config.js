/**
 * Configuration constants.
 */

// For local dev: use "" (same origin, dev_server.py proxies /api/*).
// For production with Cloudflare Worker: set to your worker URL, e.g.
//   "https://iran-polymarket-proxy.<your-subdomain>.workers.dev"
const WORKER_URL = "https://iran-polymarket-proxy.iran-polymarket-tracker.workers.dev";

const LOW_VOLUME_THRESHOLD = 100_000; // $100K
const NEW_MARKET_HOURS = 48;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
