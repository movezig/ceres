// Zero-dependency persistent store: NDJSON append log + JSON state file.
// Everything is held in memory (fine for years of this data volume).
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

const DATA = CONFIG.dataDir;
const TRADES_F = path.join(DATA, "trades.ndjson");
const ALERTS_F = path.join(DATA, "alerts.ndjson");
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
*/

class Store {
  constructor() {
    fs.mkdirSync(DATA, { recursive: true });
    this.trades = [];
    this.byId = new Set();
    this.alerts = [];
    this.alertIds = new Set();
    this.state = { seenAccessions: [], snapshots13F: {}, lastPoll: {}, cycle: 0 };
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
    if (fs.existsSync(STATE_F)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(STATE_F, "utf8")) }; } catch {}
    }
    this.seenAcc = new Set(this.state.seenAccessions);
    this.trades.sort((a, b) => (a.filedDate < b.filedDate ? 1 : -1));
    this.alerts.sort((a, b) => (a.ts < b.ts ? 1 : -1)); // newest first; file is an oldest-first append log
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

  purgeDemo() {
    this.trades = this.trades.filter((t) => !t.demo);
    this.alerts = this.alerts.filter((a) => !a.demo);
    this.byId = new Set(this.trades.map((t) => t.id));
    this.alertIds = new Set(this.alerts.map((a) => a.id));
    fs.writeFileSync(TRADES_F, this.trades.map((t) => JSON.stringify(t)).join("\n") + (this.trades.length ? "\n" : ""));
    fs.writeFileSync(ALERTS_F, this.alerts.map((a) => JSON.stringify(a)).join("\n") + (this.alerts.length ? "\n" : ""));
  }
}

export const store = new Store();
