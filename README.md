# ⬡ Ceres — Smart-Money Flow Intelligence

A self-hosted, zero-dependency dashboard that polls public disclosure sources **every hour**, aggregates reported trades by ticker, and surfaces alerts, a flow heatmap, and drill-down tables for tickers, traders, and sectors.

**▶ Live POC: <https://movezig.github.io/ceres/>** — the dashboard on GitHub Pages, fed by a GitHub Actions cron (`.github/workflows/poll.yml`) that re-polls the disclosure sources hourly and republishes `docs/` whenever new filings land. Desktop notifications and the manual poll button need the self-hosted server below.

## Quick start

```bash
cd ceres
export CERES_CONTACT="you@example.com"   # SEC requires contact info in the User-Agent
npm run seed    # optional: populate demo data so the UI is instantly reviewable
npm start       # starts server + hourly collector → http://localhost:8321
```

Requires **Node 18+**. No npm install needed — zero dependencies.

When you're done reviewing the demo data, click **"purge demo data"** in the dashboard footer (or `curl -X POST localhost:8321/api/purge-demo`). Real data accumulates from the first poll.

## Data sources (all free)

| Tier | Source | What | Disclosure lag | Poll cadence |
|---|---|---|---|---|
| 1 | SEC EDGAR — Form 4 | Insider open-market buys/sells (codes P/S) | ~2 business days | hourly |
| 2 | SEC EDGAR — SC 13D | Activist stakes >5% | ≤5 days | hourly |
| 3 | SEC EDGAR — 13F-HR | Quarterly holdings of 12 tracked managers (Berkshire, Pershing, Duquesne, Appaloosa, Scion, Baupost, Himalaya, Icahn, ValueAct, Starboard, Elliott, Third Point) — diffed vs prior quarter into new/add/trim/exit events | ≤45 days after quarter end | hourly (new filings are rare) |
| 4 | House/Senate Stock Watcher datasets | Congressional PTR trades | ≤45 days | every 6 hours |

⚠️ **Known limitation:** the House/Senate Stock Watcher S3 datasets are community-maintained and have had gaps. If the Congress tier stays empty, the dataset is stale — swap in a paid source (Quiver Quantitative or Unusual Whales API) in `src/collectors.js → collectCongress()`; the row shape to map to is documented in `src/store.js`.

## Alert rules (thresholds in `src/config.js`)

- `insider_big_buy` — single open-market insider buy ≥ **$250K** (high)
- `insider_cluster` — **3+ distinct insiders** buy the same ticker within **14 days** (critical — the strongest signal in the academic literature)
- `activist_13d` — any new SC 13D (high)
- `fund_conviction` — tracked 13F manager opens a new position or adds ≥ $50M (medium)
- `congress_big_buy` — congressional buy with range midpoint ≥ **$100K** (medium)

Alerts appear in the feed, badge the tier gauges, and (if you allow browser notifications via the 🔔) fire a desktop notification.

## Dashboard views

- **Overview** — 4 tier gauges (24h activity vs 30-day baseline), the **highest-probability list gauge** (top 3 buy-side trades to follow, scored by a transparent heuristic — signal type + consensus + size + freshness; expand a pick to see the itemized "why"), alert feed with "new since last visit" highlighting, and the **flow heatmap**: a treemap of the top 60 tickers sized by gross reported dollars, colored green/red by net buy/sell intensity. Click any cell to drill in.
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
src/config.js        thresholds, tracked 13F managers, endpoints, SEC User-Agent
src/collectors.js    Form 4 / 13D / 13F / Congress pollers + alert engine
src/store.js         NDJSON append-log persistence (data/), in-memory indexes
src/util.js          polite rate-limited fetch, mini XML parser, range parsing
src/seed.js          demo data (rows flagged demo:true)
src/build-site.js    builds docs/ (static Pages build: SPA + client-side API shim + snapshot)
public/              SPA dashboard (vanilla JS, hand-rolled treemap + SVG gauges)
docs/                GitHub Pages POC, republished hourly by .github/workflows/poll.yml
```

- Storage is `data/trades.ndjson` + `data/state.json` — human-readable, trivially backed up, no database to install. Delete the `data/` folder to reset.
- SEC politeness: descriptive User-Agent (contact comes from the `CERES_CONTACT` env var; in CI it's the repo secret of the same name), ≥150ms between requests, 80-filing cap per Form 4 poll.
- Run just the collector without the server: `npm run poll` (works with system cron if you prefer).
- Change port: `PORT=9000 npm start`. Disable polling: `CERES_NO_POLL=1 npm start`.

## Honest caveats

- **$ figures are estimates.** Congress reports ranges (midpoint used); 13F diffs are value deltas (mix of flows + price moves); 13D filings often lack a dollar figure and count toward consensus, not magnitude.
- **Every source lags reality** — 2 days at best (Form 4), 45 at worst. Ceres shows the lag per row; respect it.
- **Return-since-disclosure** needs a market-data key (deliberately left out of the free v1). Wire prices into `/api/aggregate` from Finnhub/Polygon if you want that column.
- Not investment advice; disclosure parsing is best-effort against messy filings.
