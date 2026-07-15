# ⬡ Ceres — Smart-Money Flow Intelligence

A self-hosted, zero-dependency dashboard that polls public disclosure sources **every hour**, aggregates reported trades by ticker, and surfaces alerts, a flow heatmap, and drill-down tables for tickers, traders, and sectors.

**▶ Live: <https://benphillips.xyz/ceres/>** — the dashboard on GitHub Pages, fed by a GitHub Actions cron (`.github/workflows/poll.yml`) that re-polls the disclosure sources hourly and republishes `docs/` whenever new filings land. The public site is static (read-only snapshot — no server, no credentials in reach); desktop notifications and the manual poll button need the self-hosted server below.

## Quick start

```bash
cd ceres
cp .env.example .env   # fill in CERES_CONTACT (required) + optional social-feed credentials
npm run seed    # optional: populate demo data so the UI is instantly reviewable
npm start       # starts server + hourly collector → http://localhost:8321
```

Requires **Node 18+**. No npm install needed — zero dependencies.

When you're done reviewing the demo data, click **"purge demo data"** in the dashboard footer (or `curl -X POST localhost:8321/api/purge-demo`). Real data accumulates from the first poll.

## Credentials (`.env` — never committed)

All secrets live in `<repo>/.env` (gitignored; template in `.env.example`) or, for the GitHub Actions poller, in **repo secrets** (Settings → Secrets and variables → Actions — `poll.yml` already forwards them). Sources missing their credentials simply stay dormant; the crowd-attention panel lists which feeds are live vs dormant.

| Env var | Feed | Where to get it |
|---|---|---|
| `CERES_CONTACT` | SEC EDGAR (required) | your email — SEC wants contact info in the User-Agent |
| `CERES_X_BEARER`, `CERES_X_HANDLES` | X tracked accounts | bearer token from <https://developer.x.com> — note this is the **API tier**, a separate paid product from an X Premium subscription |
| `CERES_REDDIT_CLIENT_ID`, `CERES_REDDIT_CLIENT_SECRET` | Reddit direct | free "script" app at <https://www.reddit.com/prefs/apps> |
| `CERES_BSKY_HANDLE`, `CERES_BSKY_APP_PASSWORD` | Bluesky | app password (Settings → Privacy and security) — never your real password |
| `CERES_TG_CHANNELS` | Telegram pump-watch | public channel names to monitor (comma-separated) |

## Data sources

### Disclosure tiers → trades (all free)

| Tier | Source | What | Disclosure lag | Poll cadence |
|---|---|---|---|---|
| 1 | SEC EDGAR — Form 4 | Insider open-market buys/sells (codes P/S) | ~2 business days | hourly |
| 2 | SEC EDGAR — Form 144 | **Advance notice** of insider sales of restricted stock — leading, not lagging | 0 days (filed pre-sale) | hourly |
| 3 | SEC EDGAR — SC 13D | Activist stakes >5% | ≤5 days | hourly |
| 4 | SEC EDGAR — SC 13G | Passive stakes >5% — quiet accumulation; a later 13D on the same ticker fires a **13G→13D conversion** alert | ≤45 days | hourly |
| 5 | SEC EDGAR — 13F-HR | Quarterly holdings of 12 tracked managers (Berkshire, Pershing, Duquesne, Appaloosa, Scion, Baupost, Himalaya, Icahn, ValueAct, Starboard, Elliott, Third Point) — diffed vs prior quarter into new/add/trim/exit events | ≤45 days after quarter end | hourly (new filings are rare) |
| 6 | House/Senate Stock Watcher datasets | Congressional PTR trades | ≤45 days | every 6 hours |

⚠️ **Known limitation:** the House/Senate Stock Watcher S3 datasets are community-maintained and have had gaps. Ceres cross-checks them against the **official House Clerk PTR index** (below) and raises a `congress_dataset_stale` alert when they fall behind. Trade-level congressional detail still needs a paid source (Quiver Quantitative or Unusual Whales API) in `src/collectors.js → collectCongress()`; the row shape to map to is documented in `src/store.js`.

Form 144 caveat: a 144 notice and its later Form 4 execution are separate disclosures of the same economic sale — expect overlap between tiers 1 and 2 on the sell side.

### Signal feeds → per-ticker time series (attention / sentiment / short volume)

These don't produce trade rows; they answer *"is the crowd catching on to what smart money already did?"* Rollup in the **Crowd attention** panel and `/api/attention`; raw series via `/api/signals`.

| Source | Auth | What | Cadence |
|---|---|---|---|
| Stocktwits | none | trending symbols + bull/bear sentiment streams for the most active smart-money tickers | hourly |
| Apewisdom | none | pre-aggregated Reddit ticker mentions with 24h deltas | hourly |
| Reddit (direct) | free OAuth | cashtag/ticker mention counts across configurable subreddits (`CERES_SUBREDDITS`) | hourly |
| Telegram | none | **pump-watch**: cashtags pushed in monitored public channels → manipulation warnings, not buy signals | hourly |
| X | paid API | cashtags posted by your curated high-signal accounts | every 3h (quota-friendly) |
| Bluesky | free account | cashtag post counts for the most active smart-money tickers | hourly |
| FINRA Reg SHO | none | daily short-sale volume % for tickers with smart-money flow | daily |
| House Clerk | none | official House PTR filing index — freshness cross-check + links to filing PDFs | every 6h |

## Alert rules (thresholds in `src/config.js`)

- `insider_big_buy` — single open-market insider buy ≥ **$250K** (high)
- `insider_cluster` — **3+ distinct insiders** buy the same ticker within **14 days** (critical — the strongest signal in the academic literature)
- `activist_13d` — any new SC 13D (high)
- `passive_stake_13g` — any new SC 13G (medium)
- `activist_conversion` — 13D lands on a ticker with a prior 13G: passive holder turning activist (critical)
- `form144_big_sale` — insider files advance notice to sell ≥ **$1M** (medium)
- `fund_conviction` — tracked 13F manager opens a new position or adds ≥ $50M (medium)
- `congress_big_buy` — congressional buy with range midpoint ≥ **$100K** (medium)
- `congress_dataset_stale` — official House PTRs run > **10 days** ahead of the community dataset (medium)
- `attention_spike` — social mentions ≥ **2.5×** the prior reading (per-source floors) (medium)
- `social_confluence` — attention spike on a ticker smart money bought within **14 days** — crowd late to the trade (high)
- `pump_watch` — ticker pushed in a monitored Telegram pump channel (high — contra signal)
- `short_squeeze_setup` — Reg SHO short volume ≥ **60%** while smart money bought within 14 days (medium)

Alerts appear in the feed, badge the tier gauges, and (if you allow browser notifications via the 🔔) fire a desktop notification.

## Dashboard views

- **Overview** — 6 tier gauges (24h activity vs 30-day baseline), the **highest-probability list gauge** (top 3 buy-side trades to follow, scored by a transparent heuristic — signal type + consensus + size + freshness; expand a pick to see the itemized "why"), alert feed with "new since last visit" highlighting, the **crowd-attention panel** (per-ticker social attention by source, bull/bear sentiment, short-volume %, smart-money-first badges, pump warnings — plus which signal feeds are live vs dormant), and the **flow heatmap**: a treemap of the top 60 tickers sized by gross reported dollars, colored green/red by net buy/sell intensity. Click any cell to drill in.
- **Alert feed** — each alert leads with a datetime bubble, rule label, and ticker; hover for the full description and rule explanation; click to jump to the underlying trade (`#trade/<id>`, falls back to the ticker view for alerts without a linked trade).
- **Trades** — every disclosure, filterable by source / type / ticker / trader / min $, paginated, each row linking to the original SEC filing. The **Lag** column shows trade-date → filed-date delay (red if >30d — that's your staleness warning).
- **Tickers** — the aggregation table: distinct traders, trade count, buy/sell/net/gross $ per ticker.
- **Traders** — leaderboard by reported dollar volume; click through for a trader's history + **average disclosure lag** (how followable they actually are). The trader page has a profile card (role, company, source, active span) and the trader's name links out to an external profile (web search for insiders/funds, congress.gov for members), plus an EDGAR full-text-search link for their filings.
- **Sectors** — flows bucketed by sector (static mapping in `public/sectors.json`; extend it freely).
- **Every table sorts** — click a column header to toggle asc/desc (the paginated Trades view sorts server-side across the full result set).
- The lookback window selector (7d/30d/90d/1y) applies to every view.

## Architecture

```
server.js            zero-dep Node http server: static UI + JSON API + hourly setInterval poller
src/config.js        thresholds, tracked 13F managers, endpoints, credentials (via src/env.js)
src/env.js           tiny .env loader — shell env always wins over the file
src/collectors.js    disclosure pollers (Form 4/144, 13D/13G, 13F, Congress + House Clerk, Reg SHO) + alert engine
src/social.js        attention pollers (Stocktwits, Apewisdom, Reddit, Telegram, X, Bluesky) + spike/confluence alerts
src/store.js         NDJSON append-log persistence (data/), in-memory indexes
src/util.js          polite rate-limited fetch, mini XML parser, ZIP extractor, cashtag extraction
src/seed.js          demo data (rows flagged demo:true)
src/build-site.js    builds docs/ (static Pages build: SPA + client-side API shim + snapshot)
public/              SPA dashboard (vanilla JS, hand-rolled treemap + SVG gauges)
docs/                GitHub Pages POC, republished hourly by .github/workflows/poll.yml
```

- Storage is `data/trades.ndjson` + `data/signals.ndjson` + `data/state.json` — human-readable, trivially backed up, no database to install. Delete the `data/` folder to reset.
- SEC politeness: descriptive User-Agent (contact comes from the `CERES_CONTACT` env var; in CI it's the repo secret of the same name), ≥150ms between requests, 80-filing cap per Form 4 poll.
- Run just the collector without the server: `npm run poll` (works with system cron if you prefer).
- Change port: `PORT=9000 npm start`. Disable polling: `CERES_NO_POLL=1 npm start`.

## Honest caveats

- **$ figures are estimates.** Congress reports ranges (midpoint used); 13F diffs are value deltas (mix of flows + price moves); 13D filings often lack a dollar figure and count toward consensus, not magnitude.
- **Every source lags reality** — 2 days at best (Form 4), 45 at worst. Ceres shows the lag per row; respect it.
- **Return-since-disclosure** needs a market-data key (deliberately left out of the free v1). Wire prices into `/api/aggregate` from Finnhub/Polygon if you want that column.
- **Social attention is crowd noise, not smart money.** The signal feeds exist to time and cross-check the disclosure tiers (and to flag pumps) — never to generate buy ideas on their own. Ticker extraction from free text is best-effort: cashtags are validated against the SEC ticker list and common finance slang is stoplisted, but expect occasional false counts.
- A Form 144 notice and its later Form 4 execution can double-count one economic sale across tiers.
- Not investment advice; disclosure parsing is best-effort against messy filings.
