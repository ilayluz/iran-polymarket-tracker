* This computer has `uv` installed, so use it to run Python scripts and manage dependencies. Prefer to use the `uv` "project" commands (e.g. `uv init`, `uv add`, `uv run`).
* Eventually I want to publish this on my personal free Github account, but at the start let's test this locally

## Polymarket API Notes

* Polymarket does NOT support deep-linking to individual submarkets within a grouped event. URLs like `polymarket.com/event/{event-slug}/{market-slug}` and query params like `?market={id}` or `?tid={token_id}` all just load the parent event page. The only usable link is to the parent event: `https://polymarket.com/event/us-strikes-iran-by`
* Gamma API (`gamma-api.polymarket.com`): market metadata, no auth needed. Use `GET /events?slug=us-strikes-iran-by` to get all submarkets.
* CLOB API (`clob.polymarket.com`): price history, no auth needed. Use `GET /prices-history?market={token_id}&interval=max&fidelity=60` for historical data.
* `outcomePrices` and `clobTokenIds` are JSON-encoded strings in the API response — must `json.loads()` them.
* The `endDate` field on a market does NOT always match the question deadline date. Parse the actual date from the question text instead.
* Plotly 6.x `add_vline()` with `annotation_text` crashes when x is an ISO date string (TypeError in `shapeannotation.py`). Use `add_shape()` + `add_annotation()` separately instead.
* Polymarket API rate limits (from docs): Gamma /events 4,000 req/10s, Gamma /markets 300 req/10s, CLOB general 1,500-9,000 req/10s. Very generous for read-only use, but we still want to minimize calls when serving thousands of users.

## Deployment Architecture Analysis

The current app is Dash (server-side Python/Flask). **Dash CANNOT be deployed to GitHub Pages** since it requires a running Python process. This is the fundamental constraint.

### Recommended: Option C — Static Site + Cloudflare Workers Cache Proxy

* Rewrite frontend to static HTML + Plotly.js (Plotly.js is the same charting library Dash uses under the hood — charts translate directly, main work is replacing Dash callbacks with vanilla JS event handlers)
* Deploy static site to GitHub Pages (free, scales to millions of users)
* Deploy a tiny caching proxy (~20 lines) on Cloudflare Workers free tier (100K req/day) that wraps Polymarket API and caches responses for 60 seconds
* All users hit the Cloudflare proxy — cache means only ~1 real Polymarket API call per minute regardless of user count (~1,440 calls/day)
* "Update" button = client-side `fetch()` from the proxy
* New market detection happens on every fetch automatically

### Alternative: Option A — Static Site + GitHub Actions (no proxy)

* GitHub Actions cron (every 5 min minimum) fetches Polymarket data and commits JSON files to repo
* Static site on GitHub Pages loads pre-built JSON
* Only ~288 Polymarket API calls/day from Actions
* Simpler (no Cloudflare dependency) but data is 5 min stale minimum
* Client-side "Update" button would need CORS access to Polymarket (uncertain)
* Historical data accumulates in repo JSON files over time

### Quickest path: Option B — Keep Dash, Deploy to Render/Fly.io Free Tier

* Minimal code changes, just deploy
* Server-side cache: 1 API call serves all users
* BUT: Render free tier sleeps after 15 min inactivity (30s cold start), limited CPU/RAM for thousands of concurrent Dash WebSocket connections
* Dash sends full figure JSON on every update — bandwidth-heavy at scale
* Free server hosting tiers could be discontinued

### Hybrid Option D — GitHub Actions for History + Cloudflare for Live

* Best of both worlds but most complex
* Actions builds historical JSON archive, Cloudflare proxy provides live prices
* Static site loads historical JSON + supplements with live data

## Current App Architecture

* `iran_dashboard/api.py` — Polymarket API layer (Gamma + CLOB), in-memory TTL caches (5min markets, 1hr histories), parallel fetching with ThreadPoolExecutor
* `iran_dashboard/data.py` — PCHIP interpolation for CDF, np.gradient for PDF, historical snapshot reconstruction, monotonicity enforcement via forward-clipping
* `iran_dashboard/callbacks.py` — Dash callbacks: data fetch (triggered by dcc.Interval), chart render (CDF/PDF toggle, time slider, joy plot), market table
* `iran_dashboard/joy_plot.py` — TensorBoard-style ridge plot: global normalization, 30 tightly-packed ridges, opaque fills for 3D layered effect, drawn oldest-first so newest occludes
* `iran_dashboard/layout.py` — Dash layout with controls, chart, market table
* `iran_dashboard/app.py` — Entry point, `uv run iran-dashboard` starts server on port 8050
* `screenshot.py` — Playwright helper for taking dashboard screenshots (used for development iteration)
* Key Dash pattern: `uirevision="stable"` preserves zoom/pan across callback updates
* Zoom buttons use Plotly `updatemenus` with `method="relayout"` to set `xaxis.range`