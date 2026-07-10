// Ceres server — zero-dependency Node http server: static dashboard + JSON API + hourly poller.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./src/config.js";
import { store } from "./src/store.js";
import { pollAll } from "./src/collectors.js";
import { daysAgoISO } from "./src/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, "public");
const SECTORS = JSON.parse(fs.readFileSync(path.join(PUB, "sectors.json"), "utf8"));
const sectorOf = (t) => SECTORS[t] || "Other";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

/* ------------------------------ helpers ------------------------------ */

const json = (res, obj, code = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};

function windowCutoff(q) {
  const w = q.get("window") || "30d";
  const n = Number(w.replace(/\D/g, "")) || 30;
  return daysAgoISO(n);
}

function filteredTrades(q) {
  const cutoff = windowCutoff(q);
  const src = q.get("source");
  const ticker = q.get("ticker")?.toUpperCase();
  const trader = q.get("trader")?.toLowerCase();
  const type = q.get("type");
  const sector = q.get("sector");
  const minUsd = Number(q.get("minUsd") || 0);
  return store.trades.filter((t) =>
    t.filedDate >= cutoff &&
    (!src || t.source === src) &&
    (!ticker || t.ticker === ticker) &&
    (!trader || (t.trader || "").toLowerCase().includes(trader)) &&
    (!type || t.type === type) &&
    (!sector || sectorOf(t.ticker) === sector) &&
    (!minUsd || (t.estUsd || 0) >= minUsd)
  );
}

/* ------------------------------ API ------------------------------ */

const routes = {
  "/api/summary": (q) => {
    const day = daysAgoISO(1), week = daysAgoISO(7), month = daysAgoISO(30);
    const tiers = {};
    for (const [src, meta] of Object.entries(CONFIG.sources)) {
      const rows = store.trades.filter((t) => t.source === src);
      const d = rows.filter((t) => t.filedDate >= day).length;
      const w = rows.filter((t) => t.filedDate >= week).length;
      const m = rows.filter((t) => t.filedDate >= month).length;
      tiers[src] = {
        ...meta, last24h: d, last7d: w, last30d: m,
        dailyBaseline: Math.max(1, Math.round(m / 30)),
        lastPoll: store.state.lastPoll[src] || null,
        alerts24h: store.alerts.filter((a) => a.source === src && a.ts >= new Date(Date.now() - 864e5).toISOString()).length
      };
    }
    return { tiers, totalTrades: store.trades.length, totalAlerts: store.alerts.length, now: new Date().toISOString() };
  },

  "/api/alerts": (q) => {
    const since = q.get("since") || "";
    const before = q.get("before") || ""; // cursor: return alerts older than this ts
    const limit = Math.min(Number(q.get("limit") || 100), 500);
    return store.alerts.filter((a) => a.ts > since && (!before || a.ts < before)).slice(0, limit);
  },

  "/api/trade": (q) => {
    const t = store.trades.find((x) => x.id === q.get("id"));
    return t ? { ...t, sector: sectorOf(t.ticker) } : { error: "not found" };
  },

  "/api/trades": (q) => {
    const rows = filteredTrades(q);
    const sort = q.get("sort") || "filedDate";
    const dir = q.get("dir") === "asc" ? 1 : -1;
    rows.sort((a, b) => ((a[sort] ?? "") < (b[sort] ?? "") ? -dir : dir));
    const offset = Number(q.get("offset") || 0);
    const limit = Math.min(Number(q.get("limit") || 100), 1000);
    return { total: rows.length, rows: rows.slice(offset, offset + limit).map((t) => ({ ...t, sector: sectorOf(t.ticker) })) };
  },

  "/api/aggregate": (q) => {
    const rows = filteredTrades(q);
    const agg = {};
    for (const t of rows) {
      if (!t.ticker || t.ticker === "?") continue;
      const a = (agg[t.ticker] ||= {
        ticker: t.ticker, company: t.company, sector: sectorOf(t.ticker),
        traders: new Set(), buyUsd: 0, sellUsd: 0, count: 0, sources: {}, lastFiled: ""
      });
      a.traders.add(t.trader);
      a.count++;
      a.sources[t.source] = (a.sources[t.source] || 0) + 1;
      if (t.filedDate > a.lastFiled) { a.lastFiled = t.filedDate; a.company = t.company || a.company; }
      const usd = t.estUsd || 0;
      if (["buy", "new_stake", "add"].includes(t.type)) a.buyUsd += usd;
      else if (["sell", "trim", "exit"].includes(t.type)) a.sellUsd += usd;
    }
    return Object.values(agg)
      .map((a) => ({ ...a, traders: a.traders.size, netUsd: a.buyUsd - a.sellUsd, grossUsd: a.buyUsd + a.sellUsd }))
      .sort((x, y) => y.grossUsd - x.grossUsd);
  },

  "/api/sectors": (q) => {
    const rows = routes["/api/aggregate"](q);
    const by = {};
    for (const r of rows) {
      const s = (by[r.sector] ||= { sector: r.sector, tickers: 0, traders: 0, buyUsd: 0, sellUsd: 0, count: 0 });
      s.tickers++; s.traders += r.traders; s.buyUsd += r.buyUsd; s.sellUsd += r.sellUsd; s.count += r.count;
    }
    return Object.values(by).map((s) => ({ ...s, netUsd: s.buyUsd - s.sellUsd })).sort((a, b) => (b.buyUsd + b.sellUsd) - (a.buyUsd + a.sellUsd));
  },

  "/api/traders": (q) => {
    const rows = filteredTrades(q);
    const by = {};
    for (const t of rows) {
      const k = t.trader || "?";
      const a = (by[k] ||= { trader: k, role: t.traderRole, source: t.source, count: 0, buyUsd: 0, sellUsd: 0, tickers: new Set(), lastFiled: "" });
      a.count++;
      a.tickers.add(t.ticker);
      if (t.filedDate > a.lastFiled) a.lastFiled = t.filedDate;
      const usd = t.estUsd || 0;
      if (["buy", "new_stake", "add"].includes(t.type)) a.buyUsd += usd; else a.sellUsd += usd;
    }
    return Object.values(by).map((a) => ({ ...a, tickers: a.tickers.size })).sort((x, y) => (y.buyUsd + y.sellUsd) - (x.buyUsd + x.sellUsd));
  },

  "/api/meta": () => ({
    managers: CONFIG.managers, sources: CONFIG.sources, alerts: CONFIG.alerts,
    pollIntervalMs: CONFIG.pollIntervalMs, port: CONFIG.port
  })
};

/* ------------------------------ server ------------------------------ */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const q = u.searchParams;

  try {
    if (u.pathname === "/api/poll" && req.method === "POST") {
      pollAll({ force: true }).catch((e) => console.error(e));
      return json(res, { started: true });
    }
    if (u.pathname === "/api/purge-demo" && req.method === "POST") {
      store.purgeDemo();
      return json(res, { ok: true, remaining: store.trades.length });
    }
    if (routes[u.pathname]) return json(res, routes[u.pathname](q));

    // static
    let p = u.pathname === "/" ? "/index.html" : u.pathname;
    const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // SPA fallback
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(fs.readFileSync(path.join(PUB, "index.html")));
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } catch (e) {
    console.error("[server]", e);
    json(res, { error: e.message }, 500);
  }
});

server.listen(CONFIG.port, () => {
  console.log(`\n  ⬡ CERES — smart-money flow intelligence`);
  console.log(`  Dashboard:  http://localhost:${CONFIG.port}`);
  console.log(`  Trades in store: ${store.trades.length} | Alerts: ${store.alerts.length}\n`);
  if (process.env.CERES_NO_POLL !== "1") {
    pollAll({ force: true }).catch((e) => console.error("[boot poll]", e.message));
    setInterval(() => pollAll().catch((e) => console.error("[cron poll]", e.message)), CONFIG.pollIntervalMs);
  } else {
    console.log("  (CERES_NO_POLL=1 — collector disabled)");
  }
});
