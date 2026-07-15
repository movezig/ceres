/* Ceres static API shim for the GitHub Pages build.
   Pages can't run server.js, so this script (loaded before app.js)
   intercepts fetch() calls to /api/* and answers them in the browser from
   snapshot.json — the store as of the last `npm run build:site` (an hourly
   GitHub Actions poll republishes it, keeping the hosted POC live).
   Route logic mirrors server.js; keep the two in sync when routes change.
   "Now" is pinned to the snapshot timestamp so gauges/baselines stay coherent. */
(() => {
  const routesFor = (snap) => {
    const SECTORS = snap.sectors;
    const sectorOf = (t) => SECTORS[t] || "Other";
    const NOW = new Date(snap.generatedAt).getTime();
    const daysAgoISO = (n) => new Date(NOW - n * 864e5).toISOString().slice(0, 10);
    const { trades, alerts } = snap;
    const signals = snap.signals || [];
    const confluenceDays = snap.meta.confluenceWindowDays || 14;

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
      return trades.filter((t) =>
        t.filedDate >= cutoff &&
        (!src || t.source === src) &&
        (!ticker || t.ticker === ticker) &&
        (!trader || (t.trader || "").toLowerCase().includes(trader)) &&
        (!type || t.type === type) &&
        (!sector || sectorOf(t.ticker) === sector) &&
        (!minUsd || (t.estUsd || 0) >= minUsd)
      );
    }

    const routes = {
      "/api/summary": (q) => {
        const day = daysAgoISO(1), week = daysAgoISO(7), month = daysAgoISO(30);
        const tiers = {};
        for (const [src, meta] of Object.entries(snap.meta.sources)) {
          const rows = trades.filter((t) => t.source === src);
          const d = rows.filter((t) => t.filedDate >= day).length;
          const w = rows.filter((t) => t.filedDate >= week).length;
          const m = rows.filter((t) => t.filedDate >= month).length;
          tiers[src] = {
            ...meta, last24h: d, last7d: w, last30d: m,
            dailyBaseline: Math.max(1, Math.round(m / 30)),
            lastPoll: snap.lastPoll[src] || null,
            alerts24h: alerts.filter((a) => a.source === src && a.ts >= new Date(NOW - 864e5).toISOString()).length
          };
        }
        const day24 = new Date(NOW - 864e5).toISOString();
        const signalTiers = {};
        for (const [key, meta] of Object.entries(snap.meta.signalSources || {})) {
          signalTiers[key] = {
            label: meta.label, configured: meta.configured,
            last24h: signals.filter((s) => s.source === key && s.ts >= day24).length,
            lastPoll: snap.lastPoll[key] || null
          };
        }
        return { tiers, signalTiers, totalTrades: trades.length, totalSignals: signals.length, totalAlerts: alerts.length, now: new Date(NOW).toISOString() };
      },

      "/api/signals": (q) => {
        const cutoff = windowCutoff(q);
        const ticker = q.get("ticker")?.toUpperCase();
        const src = q.get("source"), kind = q.get("kind");
        const limit = Math.min(Number(q.get("limit") || 200), 2000);
        return signals.filter((s) =>
          s.date >= cutoff &&
          (!ticker || s.ticker === ticker) &&
          (!src || s.source === src) &&
          (!kind || s.kind === kind)
        ).slice(0, limit);
      },

      "/api/attention": (q) => {
        const cutoff = windowCutoff(q);
        const by = {};
        for (const s of signals) {
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
        const smartCutoff = daysAgoISO(confluenceDays);
        return Object.values(by).map(({ _sent, _sv, ...a }) => ({
          ...a,
          sourcesActive: Object.keys(a.sources).length,
          smartBuyers: new Set(trades
            .filter((t) => t.ticker === a.ticker && t.filedDate >= smartCutoff && ["buy", "new_stake", "add"].includes(t.type))
            .map((t) => t.trader)).size
        })).sort((x, y) => (y.sourcesActive - x.sourcesActive) || (y.lastTs < x.lastTs ? -1 : 1));
      },

      "/api/alerts": (q) => {
        const since = q.get("since") || "";
        const before = q.get("before") || "";
        const limit = Math.min(Number(q.get("limit") || 100), 500);
        return alerts.filter((a) => a.ts > since && (!before || a.ts < before)).slice(0, limit);
      },

      "/api/trade": (q) => {
        const t = trades.find((x) => x.id === q.get("id"));
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

      "/api/meta": () => snap.meta
    };

    return routes;
  };

  const handlerFor = (snap) => {
    const routes = routesFor(snap);
    return (pathname, q, method = "GET") => {
      if (pathname === "/api/poll" && method === "POST") return { started: false, static: true };
      if (pathname === "/api/purge-demo" && method === "POST") return { ok: true, remaining: snap.trades.length };
      if (routes[pathname]) return routes[pathname](q);
      return { error: "not found" };
    };
  };

  globalThis.CeresDemo = { routesFor, handlerFor };

  if (typeof window === "undefined" || !window.document) return; // Node (build/tests): expose logic only

  const ready = fetch(new URL("./snapshot.json", document.baseURI))
    .then((r) => r.json())
    .then(handlerFor);

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const u = typeof input === "string" ? new URL(input, location.origin)
      : input instanceof URL ? input : new URL(input.url, location.origin);
    if (!u.pathname.startsWith("/api/")) return realFetch(input, init);
    const handle = await ready;
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const body = handle(u.pathname, u.searchParams, method);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
})();
