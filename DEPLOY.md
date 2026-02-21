# Deployment Guide

Three things to set up: Node.js (for Cloudflare tooling), Cloudflare Workers (API proxy), and GitHub Pages (static site).

## 1. Install Node.js

Needed for the `wrangler` CLI that deploys Cloudflare Workers.

1. Download the LTS installer from https://nodejs.org/ (Windows x64)
2. Run the installer with default settings
3. Restart your terminal, then verify:
   ```
   node --version
   npm --version
   npx --version
   ```

## 2. Deploy the Cloudflare Worker

The worker proxies Polymarket API requests with caching so thousands of users only generate ~1 API call per minute.

### Create a Cloudflare account

1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with email (free tier is plenty — 100K requests/day)
3. No domain needed, no payment info needed for Workers free tier

### Deploy the worker

```bash
cd worker

# First time: this opens a browser to authenticate with your Cloudflare account
npx wrangler login

# Deploy
npx wrangler deploy
```

After deploy, wrangler prints the worker URL. It will look like:
```
https://iran-polymarket-proxy.<your-subdomain>.workers.dev
```

Copy this URL — you'll need it in step 3.

### Test it

```bash
curl https://iran-polymarket-proxy.<your-subdomain>.workers.dev/api/markets
```

Should return JSON with market data.

## 3. Update the static site config

Edit `docs/js/config.js` and set `WORKER_URL` to your deployed worker URL:

```javascript
const WORKER_URL = "https://iran-polymarket-proxy.<your-subdomain>.workers.dev";
```

## 4. Create the GitHub repo and enable Pages

### Create the repo

1. Go to https://github.com/new
2. Repository name: `iran_polymarket` (or whatever you prefer)
3. Set to **Public** (required for GitHub Pages on free accounts)
4. Don't initialize with README (we already have code)
5. Click **Create repository**

### Push the code

```bash
cd C:\Users\ilayl\claude\iran_polymarket

git init
git add docs/ worker/ dev_server.py CLAUDE.md DEPLOY.md pyproject.toml
# Also add any other files you want (iran_dashboard/, etc.)
git commit -m "Static site + Cloudflare Worker for Polymarket dashboard"

git remote add origin https://github.com/<your-username>/iran_polymarket.git
git branch -M main
git push -u origin main
```

### Enable GitHub Pages

1. Go to your repo on GitHub → **Settings** → **Pages** (left sidebar)
2. Under **Source**, select **Deploy from a branch**
3. Branch: **main**, folder: **/docs**
4. Click **Save**
5. Wait 1-2 minutes, then your site is live at:
   ```
   https://<your-username>.github.io/iran_polymarket/
   ```

## 5. Lock down CORS (optional)

Once your GitHub Pages site is live, edit `worker/worker.js` to restrict CORS to your domain:

```javascript
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://<your-username>.github.io",
  // ...
};
```

Then redeploy: `cd worker && npx wrangler deploy`

## Summary

| Component | Where | Cost | URL |
|-----------|-------|------|-----|
| Static site | GitHub Pages | Free | `https://<user>.github.io/iran_polymarket/` |
| API proxy | Cloudflare Workers | Free (100K req/day) | `https://iran-polymarket-proxy.<sub>.workers.dev` |
| Polymarket API | Their servers | Free | Proxied through worker |

## Local development

No Cloudflare/GitHub needed for local dev:

```bash
uv run python dev_server.py
```

Opens http://localhost:8000 with the dev server proxying API calls directly to Polymarket.
