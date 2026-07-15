// Ceres server — zero-dependency Node http server: static dashboard + JSON API + hourly poller.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONFIG, sourceConfigured } from "./src/config.js";
import { store } from "./src/store.js";
import { pollAll } from "./src/collectors.js";
import { daysAgoISO } from "./src/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, "public");
const SECTORS = JSON.parse(fs.readFileSync(path.join(PUB, "sectors.json"), "utf8"));
const sectorOf = (t) => SECTORS[t] || "Other";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

/* ------------------------------ helpers ------------------------------ */

// Applied to every response. CSP allows only same-origin resources ('unsafe-inline'
// is required by the SPA's inline handlers/styles; all rendered data is HTML-escaped).
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

const json = (res, obj, code = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC_HEADERS });
  res.end(body);
};

/* Auth for mutating endpoints: Bearer token checked against a stored SHA-256 hash
   (constant-time). No plaintext secret ever lives on disk or in config. Requests
   from the loopback interface are trusted unless CERES_REQUIRE_AUTH=1 — the socket
   address is used, never spoofable proxy headers. */
const isLoopback = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

function authorized(req) {
  if (!CONFIG.requireAuth && isLoopback(req)) return true;
  if (!/^[0-9a-f]{64}$/.test(CONFIG.adminTokenHash)) return false; // no valid hash configured → remote mutations always denied
  const m = (req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  const presented = crypto.createHash("sha256").update(m[1]).digest();
  return crypto.timingSafeEqual(presented, Buffer.from(CONFIG.adminTokenHash, "hex"));
}

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
    const day24 = new Date(Date.now() - 864e5).toISOString();
    const signalTiers = {};
    for (const [key, meta] of Object.entries(CONFIG.signalSources)) {
      const rows = store.signals.filter((s) => s.source === key);
      signalTiers[key] = {
        label: meta.label, configured: sourceConfigured(key),
        last24h: rows.filter((s) => s.ts >= day24).length,
        lastPoll: store.state.lastPoll[key] || null
      };
    }
    return { tiers, signalTiers, totalTrades: store.trades.length, totalSignals: store.signals.length, totalAlerts: store.alerts.length, now: new Date().toISOString() };
  },

  "/api/signals": (q) => {
    const cutoff = windowCutoff(q);
    const ticker = q.get("ticker")?.toUpperCase();
    const src = q.get("source"), kind = q.get("kind");
    const limit = Math.min(Number(q.get("limit") || 200), 2000);
    return store.signals.filter((s) =>
      s.date >= cutoff &&
      (!ticker || s.ticker === ticker) &&
      (!src || s.source === src) &&
      (!kind || s.kind === kind)
    ).slice(0, limit);
  },

  // Per-ticker rollup of the signal feeds for the crowd-attention panel. Values are
  // per-source (units differ: watchers vs mentions vs posts), never summed across sources.
  "/api/attention": (q) => {
    const cutoff = windowCutoff(q);
    const by = {};
    for (const s of store.signals) {
      if (!s.ticker || s.date < cutoff) continue;
      const a = (by[s.ticker] ||= { ticker: s.ticker, sources: {}, sentiment: null, shortPct: null, pump: false, lastTs: "", _sent: "", _sv: "" });
      if (s.ts > a.lastTs) a.lastTs = s.ts;
      if (s.kind === "attention") {
        const cur = a.sources[s.source];
        if (!cur || s.ts > cur.ts) a.sources[s.source] = { value: s.value, rank: s.meta?.rank ?? null, ts: s.ts };
      } else if (s.kind === "sentiment" && s.ts > a._sent) { a.sentiment = s.value; a._sent = s.ts; }
      else if (s.kind === "short_vol" && s.ts > a._sv) { a.shortPct = s.value; a._sv = s.ts; }
      else if (s.kind === "pump_mention") a.pump = true;
    }
    const smartCutoff = daysAgoISO(CONFIG.alerts.confluenceWindowDays);
    return Object.values(by).map(({ _sent, _sv, ...a }) => ({
      ...a,
      sourcesActive: Object.keys(a.sources).length,
      smartBuyers: new Set(store.trades
        .filter((t) => t.ticker === a.ticker && t.filedDate >= smartCutoff && ["buy", "new_stake", "add"].includes(t.type))
        .map((t) => t.trader)).size
    })).sort((x, y) => (y.sourcesActive - x.sourcesActive) || (y.lastTs < x.lastTs ? -1 : 1));
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
    signalSources: Object.fromEntries(Object.entries(CONFIG.signalSources)
      .map(([k, v]) => [k, { label: v.label, configured: sourceConfigured(k) }])),
    pollIntervalMs: CONFIG.pollIntervalMs, port: CONFIG.port
  })
};

/* ------------------------------ server ------------------------------ */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const q = u.searchParams;

  try {
    if (u.pathname === "/api/poll" && req.method === "POST") {
      if (!authorized(req)) return json(res, { error: "unauthorized" }, 401);
      pollAll({ force: true }).catch((e) => console.error(e));
      return json(res, { started: true });
    }
    if (u.pathname === "/api/purge-demo" && req.method === "POST") {
      if (!authorized(req)) return json(res, { error: "unauthorized" }, 401);
      store.purgeDemo();
      return json(res, { ok: true, remaining: store.trades.length });
    }
    if (routes[u.pathname]) return json(res, routes[u.pathname](q));

    // static
    let p = u.pathname === "/" ? "/index.html" : u.pathname;
    const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // SPA fallback
      res.writeHead(200, { "Content-Type": "text/html", ...SEC_HEADERS });
      return res.end(fs.readFileSync(path.join(PUB, "index.html")));
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", ...SEC_HEADERS });
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
