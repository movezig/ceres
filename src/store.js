// Zero-dependency persistent store: NDJSON append log + JSON state file.
// Everything is held in memory (fine for years of this data volume).
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

const DATA = CONFIG.dataDir;
const TRADES_F = path.join(DATA, "trades.ndjson");
const ALERTS_F = path.join(DATA, "alerts.ndjson");
const SIGNALS_F = path.join(DATA, "signals.ndjson");
const STATE_F = path.join(DATA, "state.json");

/*
Trade row shape:
{
  id, source: form4|sc13d|fund13f|congress, ticker, company,
  trader,               // person or fund or member of congress
  traderRole,           // "CEO", "Director", "Rep. (D-CA)", "13F manager", ...
  type: buy|sell|new_stake|add|trim|exit,
  shares, price,
  estUsd,               // best-effort dollar estimate (range midpoint / shares*price / 13F delta)
  usdMin, usdMax,
  tradeDate, filedDate, // ISO dates
  url,                  // link to source filing
  demo: bool
}
Alert row: { id, ts, rule, severity, source, ticker, trader, message, tradeIds:[] }

Signal row (per-ticker time series from attention/market feeds — NOT trades):
{
  id, ts, date,         // daily grain: one row per source+ticker+date
  source,               // stocktwits|apewisdom|reddit|telegram|x|bluesky|regsho|houseclerk
  ticker,               // null allowed (e.g. houseclerk PTR filings carry no ticker)
  kind,                 // attention|sentiment|short_vol|ptr_filed|pump_mention
  value,                // mentions / bullish % / short-vol % / 1
  meta,                 // source-specific extras (rank, snippet, url, ...)
  demo: bool
}
*/

class Store {
  constructor() {
    fs.mkdirSync(DATA, { recursive: true });
    this.trades = [];
    this.byId = new Set();
    this.alerts = [];
    this.alertIds = new Set();
    this.signals = [];
    this.signalIds = new Set();
    this.state = { seenAccessions: [], snapshots13F: {}, lastPoll: {}, cycle: 0, socialPrev: {} };
    this._load();
  }

  _loadNdjson(file, into, idSet) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!idSet.has(row.id)) { idSet.add(row.id); into.push(row); }
      } catch { /* skip corrupt line */ }
    }
  }

  _load() {
    this._loadNdjson(TRADES_F, this.trades, this.byId);
    this._loadNdjson(ALERTS_F, this.alerts, this.alertIds);
    this._loadNdjson(SIGNALS_F, this.signals, this.signalIds);
    if (fs.existsSync(STATE_F)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(STATE_F, "utf8")) }; } catch {}
    }
    this.seenAcc = new Set(this.state.seenAccessions);
    this.trades.sort((a, b) => (a.filedDate < b.filedDate ? 1 : -1));
    this.alerts.sort((a, b) => (a.ts < b.ts ? 1 : -1)); // newest first; file is an oldest-first append log
    this.signals.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  saveState() {
    // cap accession memory to most recent 20k
    this.state.seenAccessions = [...this.seenAcc].slice(-20_000);
    fs.writeFileSync(STATE_F, JSON.stringify(this.state));
  }

  addTrade(row) {
    if (this.byId.has(row.id)) return false;
    this.byId.add(row.id);
    this.trades.unshift(row);
    fs.appendFileSync(TRADES_F, JSON.stringify(row) + "\n");
    return true;
  }

  addAlert(row) {
    if (this.alertIds.has(row.id)) return false;
    this.alertIds.add(row.id);
    this.alerts.unshift(row);
    fs.appendFileSync(ALERTS_F, JSON.stringify(row) + "\n");
    return true;
  }

  addSignal(row) {
    if (this.signalIds.has(row.id)) return false;
    this.signalIds.add(row.id);
    this.signals.unshift(row);
    fs.appendFileSync(SIGNALS_F, JSON.stringify(row) + "\n");
    return true;
  }

  /** Most recent signal for source+ticker+kind strictly before `date` (for spike ratios). */
  prevSignal(source, ticker, kind, date) {
    return this.signals.find((s) =>
      s.source === source && s.ticker === ticker && s.kind === kind && s.date < date);
  }

  /** Tickers with trade flow in the last N days, most active first — the watchlist
      that bounds per-ticker signal collectors (Reg SHO, sentiment streams, searches). */
  tickersOfInterest(days = 30, cap = 300) {
    const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const counts = {};
    for (const t of this.trades) {
      if (t.filedDate < cutoff || !t.ticker || t.ticker === "?") continue;
      counts[t.ticker] = (counts[t.ticker] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, cap).map(([t]) => t);
  }

  /** True if the ticker has buy-side smart-money trades filed in the last N days. */
  smartBuyersOf(ticker, days) {
    const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    return [...new Set(this.trades
      .filter((t) => t.ticker === ticker && t.filedDate >= cutoff && ["buy", "new_stake", "add"].includes(t.type))
      .map((t) => t.trader))];
  }

  /** Enforce the publicly-traded mandate retroactively: drop trades/alerts/signals
      whose ticker fails `valid` (canonicalizing survivors, e.g. BRK.B → BRK-B).
      Ticker-less alerts/signals (dataset-health, PTR index) are kept. */
  pruneInvalid(valid) {
    let dropped = 0;
    const fix = (rows, getT, setT) => rows.filter((r) => {
      const t = getT(r);
      if (t == null) return true;
      const c = valid(t);
      if (!c) { dropped++; return false; }
      if (c !== t) setT(r, c);
      return true;
    });
    this.trades = fix(this.trades, (r) => r.ticker, (r, c) => { r.ticker = c; });
    this.alerts = fix(this.alerts, (r) => r.ticker, (r, c) => { r.ticker = c; });
    this.signals = fix(this.signals, (r) => r.ticker, (r, c) => { r.ticker = c; });
    if (!dropped) return 0;
    this.byId = new Set(this.trades.map((t) => t.id));
    this.alertIds = new Set(this.alerts.map((a) => a.id));
    this.signalIds = new Set(this.signals.map((s) => s.id));
    fs.writeFileSync(TRADES_F, this.trades.map((t) => JSON.stringify(t)).join("\n") + (this.trades.length ? "\n" : ""));
    fs.writeFileSync(ALERTS_F, this.alerts.map((a) => JSON.stringify(a)).join("\n") + (this.alerts.length ? "\n" : ""));
    fs.writeFileSync(SIGNALS_F, this.signals.map((s) => JSON.stringify(s)).join("\n") + (this.signals.length ? "\n" : ""));
    return dropped;
  }

  purgeDemo() {
    this.trades = this.trades.filter((t) => !t.demo);
    this.alerts = this.alerts.filter((a) => !a.demo);
    this.signals = this.signals.filter((s) => !s.demo);
    this.byId = new Set(this.trades.map((t) => t.id));
    this.alertIds = new Set(this.alerts.map((a) => a.id));
    this.signalIds = new Set(this.signals.map((s) => s.id));
    fs.writeFileSync(TRADES_F, this.trades.map((t) => JSON.stringify(t)).join("\n") + (this.trades.length ? "\n" : ""));
    fs.writeFileSync(ALERTS_F, this.alerts.map((a) => JSON.stringify(a)).join("\n") + (this.alerts.length ? "\n" : ""));
    fs.writeFileSync(SIGNALS_F, this.signals.map((s) => JSON.stringify(s)).join("\n") + (this.signals.length ? "\n" : ""));
  }
}

export const store = new Store();
