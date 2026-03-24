* This computer has `uv` installed, so use it to run Python scripts and manage dependencies. Prefer to use the `uv` "project" commands (e.g. `uv init`, `uv add`, `uv run`).
* Eventually I want to publish this on my personal free Github account, but at the start let's test this locally

## Polymarket API Notes

* Polymarket does NOT support deep-linking to individual submarkets within a grouped event. URLs like `polymarket.com/event/{event-slug}/{market-slug}` and query params like `?market={id}` or `?tid={token_id}` all just load the parent event page. The only usable link is to the parent event: `https://polymarket.com/event/iran-x-israelus-conflict-ends-by`
* Gamma API (`gamma-api.polymarket.com`): market metadata, no auth needed. Use `GET /events?slug=iran-x-israelus-conflict-ends-by` to get all submarkets.
* CLOB API (`clob.polymarket.com`): price history, no auth needed. Use `GET /prices-history?market={token_id}&interval=max&fidelity=60` for historical data.
* `outcomePrices` and `clobTokenIds` are JSON-encoded strings in the API response — must `json.loads()` them.
* The `endDate` field on a market does NOT always match the question deadline date. Parse the actual date from the question text instead.
* Plotly 6.x `add_vline()` with `annotation_text` crashes when x is an ISO date string (TypeError in `shapeannotation.py`). Use `add_shape()` + `add_annotation()` separately instead.
* Polymarket API rate limits (from docs): Gamma /events 4,000 req/10s, Gamma /markets 300 req/10s, CLOB general 1,500-9,000 req/10s. Very generous for read-only use, but we still want to minimize calls when serving thousands of users.

## Low-Volume Market Filtering

New Polymarket markets open with ~$0 volume and a default 50% price, which is noise — not a real probability signal. Including them in the CDF interpolation causes the probability curve and median prediction to jump dramatically (e.g. the median suddenly drops by months when a new far-future market appears at 50%).

Two defenses in `data.js`, controlled by constants in `config.js`:

1. **Volume floor** (`MIN_VOLUME_FOR_INTERPOLATION = $1,000`): `buildCdfPoints()` skips any market below this volume. This excludes brand-new markets from the CDF/PDF curves, key statistics, and timeline chart. The market table still shows all markets (it iterates over `markets` directly).

2. **Age gate in timeline** (`NEW_MARKET_HOURS = 48h`): `buildMedianTimeline()` skips a market from any historical snapshot within 48h of its first price history entry. This prevents the early unreliable prices (thin order book, ~50% default) from creating misleading spikes in the "Predicted End Date Over Time" chart.

## Timeline Chart Spike Prevention

The "Predicted End Date Over Time" chart had spikes when Polymarket added new markets for dates further in the future. When a new far-future market appears, the CDF suddenly extends to a much later date, causing the median/75th percentile to jump.

Fix: `buildMedianTimeline()` starts the timeline only after the farthest-deadline market has history data. This ensures the chart only shows periods where the full date range of markets was available, avoiding artificial jumps from market additions.

## Current App Architecture

Static site (GitHub Pages) + Cloudflare Workers caching proxy.

* `docs/index.html` — Page layout, stats section, controls, chart containers, info section
* `docs/js/config.js` — Constants: worker URL, volume thresholds, refresh interval
* `docs/js/api.js` — Polymarket API layer: fetches from Cloudflare Worker proxy, parses market dates, classifies markets
* `docs/js/data.js` — PCHIP interpolation for CDF, central differences for PDF, historical snapshot reconstruction, monotonicity enforcement, median timeline builder
* `docs/js/charts.js` — Plotly.js chart rendering: main CDF/PDF chart, timeline chart, market table, key statistics
* `docs/js/app.js` — State management, event listeners, render loop
* `docs/css/styles.css` — All styles
* `worker/worker.js` — Cloudflare Worker caching proxy (~80 lines): wraps Polymarket Gamma + CLOB APIs, 60s/300s cache TTLs
* `dev_server.py` — Local dev server: serves `docs/` static files + proxies `/api/*` to Polymarket with in-memory caching. Also serves `/api/all` bundle endpoint for faster local loads.
* `screenshot.py` — Playwright helper for taking dashboard screenshots (used for development iteration)
* Key Plotly pattern: `uirevision="stable"` preserves zoom/pan across callback updates
* Zoom buttons use Plotly `updatemenus` with `method="relayout"` to set `xaxis.range`

## Deployment

* Static site: push to `main`, GitHub Pages deploys from `docs/`
* Cloudflare Worker: `cd worker && npx wrangler deploy`
* For local dev: set `WORKER_URL = ""` in `config.js`, run `uv run python dev_server.py`
* **Remember to set `WORKER_URL` back to the production URL before committing**
