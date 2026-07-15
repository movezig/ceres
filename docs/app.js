/* Ceres dashboard — vanilla JS SPA */
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const state = {
  window: localStorage.getItem("ceres.window") || "30d",
  lastVisit: localStorage.getItem("ceres.lastVisit") || new Date(0).toISOString(),
  sessionStart: new Date().toISOString()
};
$("#windowSel").value = state.window;

const api = (path, params = {}) => {
  const u = new URL(path, location.origin);
  u.searchParams.set("window", state.window);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, v);
  return fetch(u).then((r) => r.json());
};

const fmtUsd = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  const s = a >= 1e9 ? (n / 1e9).toFixed(2) + "B" : a >= 1e6 ? (n / 1e6).toFixed(1) + "M" : a >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(Math.round(n));
  return "$" + s;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lagDays = (t) => (t.tradeDate && t.filedDate) ? Math.round((new Date(t.filedDate) - new Date(t.tradeDate)) / 864e5) : null;
const SRC_SHORT = {
  form4: "INSIDER", form144: "144", sc13d: "13D", sc13g: "13G", fund13f: "13F", congress: "CONGRESS",
  stocktwits: "STWITS", apewisdom: "APEWIS", reddit: "REDDIT", telegram: "TGRAM", x: "𝕏", bluesky: "BSKY",
  regsho: "SHORT%", houseclerk: "CLERK"
};
const SRC_LABEL = {
  form4: "Insiders (Form 4)", form144: "Sale notices (Form 144)", sc13d: "Activists (13D)",
  sc13g: "Passive whales (13G)", fund13f: "Superinvestors (13F)", congress: "Congress"
};

/* rule → [short label, explanation shown on hover] */
const RULE_META = {
  insider_big_buy: ["INSIDER BUY", "Single open-market insider buy ≥ $250K. Insiders buying with their own cash is one of the best-documented bullish signals."],
  insider_cluster: ["CLUSTER BUY", "3+ distinct insiders bought the same ticker within 14 days — the strongest signal in the academic literature."],
  activist_13d: ["ACTIVIST 13D", "New SC 13D — an activist crossed 5% ownership and typically pushes for value-unlocking change."],
  fund_conviction: ["FUND CONVICTION", "A tracked 13F superinvestor opened a new position or added ≥ $50M."],
  congress_big_buy: ["CONGRESS BUY", "Congressional purchase with a disclosed range midpoint ≥ $100K."],
  form144_big_sale: ["SALE NOTICE", "Form 144 — an insider filed advance notice to sell ≥ $1M of restricted stock. Leading indicator, unlike the after-the-fact Form 4."],
  passive_stake_13g: ["PASSIVE 13G", "New SC 13G — a passive holder crossed 5% ownership. Quiet accumulation that often precedes 13F visibility by a quarter."],
  activist_conversion: ["13G→13D", "A previously passive >5% holder switched to an activist 13D — historically one of the strongest event signals."],
  congress_dataset_stale: ["DATA STALE", "The official House Clerk PTR index shows filings well ahead of the community dataset feeding the Congress tier — its trades are lagging reality."],
  attention_spike: ["ATTENTION", "Crowd attention on this ticker is spiking on a social feed. Attention is not smart money — check who got in first."],
  social_confluence: ["SMART→CROWD", "Crowd attention arrived AFTER disclosed smart-money buying — the crowd may be late to a trade insiders/funds already made."],
  pump_watch: ["PUMP RISK", "Ticker pushed in a monitored Telegram pump channel. Treat coordinated promotion as a manipulation warning, not a buy signal."],
  short_squeeze_setup: ["SQUEEZE?", "FINRA Reg SHO shows heavy short-sale volume while smart money is buying — the classic squeeze/conviction setup."],
  x_tracked_mention: ["𝕏 MENTION", "A tracked X account mentioned this ticker."]
};

const fmtAlertTime = (ts) => {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
};

/* best external "who is this person" link per disclosure source */
function traderProfileUrl(name, source, role, company) {
  if (source === "congress")
    return "https://www.congress.gov/members?q=" + encodeURIComponent(JSON.stringify({ search: name }));
  if (source === "form4")
    return "https://www.google.com/search?q=" + encodeURIComponent(`"${name}" ${company || ""} ${role || "insider"}`.trim());
  return "https://www.google.com/search?q=" + encodeURIComponent(name);
}

/* ---------------- gauges ---------------- */
function gaugeSVG(ratio, colorVar) {
  const r = 34, c = Math.PI * r; // semicircle
  const clamped = Math.max(0, Math.min(1, ratio / 3)); // 3x baseline = pegged
  return `<svg width="92" height="58" viewBox="0 0 92 58">
    <path d="M 8 50 A 38 38 0 0 1 84 50" fill="none" stroke="var(--line)" stroke-width="9" stroke-linecap="round"/>
    <path d="M 8 50 A 38 38 0 0 1 84 50" fill="none" stroke="var(${colorVar})" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${(clamped * c).toFixed(1)} ${c.toFixed(1)}"/>
    <text x="46" y="50" text-anchor="middle" fill="var(${colorVar})" font-size="14" font-weight="700" font-family="var(--mono)">${ratio >= 9.95 ? "10x+" : ratio.toFixed(1) + "x"}</text>
  </svg>`;
}

/* ---------------- squarified treemap ---------------- */
function treemap(items, W, H) {
  // items: [{value, ...}] sorted desc; returns [{x,y,w,h,item}]
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return [];
  const scaled = items.map((i) => ({ ...i, area: (i.value / total) * W * H }));
  const out = [];
  let x = 0, y = 0, w = W, h = H, row = [];
  const worst = (row, len) => {
    const s = row.reduce((a, b) => a + b.area, 0);
    let mx = 0;
    for (const r of row) {
      const ratio = Math.max((len * len * r.area) / (s * s), (s * s) / (len * len * r.area));
      mx = Math.max(mx, ratio);
    }
    return mx;
  };
  const layoutRow = (row) => {
    const s = row.reduce((a, b) => a + b.area, 0);
    const horiz = w >= h;
    const len = horiz ? h : w;
    const thick = s / len;
    let off = 0;
    for (const r of row) {
      const l = r.area / thick;
      out.push(horiz ? { x, y: y + off, w: thick, h: l, item: r } : { x: x + off, y, w: l, h: thick, item: r });
      off += l;
    }
    if (horiz) { x += thick; w -= thick; } else { y += thick; h -= thick; }
  };
  for (const it of scaled) {
    const len = Math.min(w, h);
    if (!row.length || worst([...row, it], len) <= worst(row, len)) row.push(it);
    else { layoutRow(row); row = [it]; }
  }
  if (row.length) layoutRow(row);
  return out;
}

function heatmapHTML(aggRows, containerW, containerH) {
  const items = aggRows.filter((r) => r.grossUsd > 0).slice(0, 60)
    .map((r) => ({ value: r.grossUsd, r }));
  const cells = treemap(items, containerW, containerH);
  return cells.map(({ x, y, w, h, item }) => {
    const r = item.r;
    const intensity = Math.min(1, Math.abs(r.netUsd) / (r.grossUsd || 1));
    const base = r.netUsd >= 0 ? [53, 192, 126] : [224, 85, 95];
    const bg = `rgba(${base[0]},${base[1]},${base[2]},${(0.18 + 0.55 * intensity).toFixed(2)})`;
    const fs = Math.max(9, Math.min(22, Math.sqrt(w * h) / 6));
    const showV = h > 34 && w > 60;
    return `<div class="hm-cell" style="left:${x}px;top:${y}px;width:${w - 2}px;height:${h - 2}px;background:${bg};font-size:${fs}px"
      onclick="location.hash='#ticker/${esc(r.ticker)}'" title="${esc(r.company || r.ticker)} — gross ${fmtUsd(r.grossUsd)}, net ${fmtUsd(r.netUsd)}, ${r.traders} traders, ${r.count} trades">
      <div class="t">${esc(r.ticker)}</div>${showV ? `<div class="v">${fmtUsd(r.grossUsd)} · ${r.traders}👤</div>` : ""}
    </div>`;
  }).join("");
}

/* ---------------- shared table renderer ---------------- */
function tradesTable(rows, { showTrader = true, serverSorted = false, highlightId = null } = {}) {
  if (!rows.length) return `<div class="empty">No trades in this window.</div>`;
  return `<div class="table-scroll"><table class="${serverSorted ? "server-sort" : ""}">
    <thead><tr>
      <th data-field="filedDate">Filed</th><th data-field="tradeDate">Traded</th><th>Lag</th><th data-field="source">Src</th>
      ${showTrader ? '<th data-field="trader">Trader</th>' : ""}
      <th data-field="ticker">Ticker</th><th data-field="type">Type</th><th class="num" data-field="estUsd">Est. $</th><th class="num" data-field="usdMin">Range</th><th>Sector</th><th></th>
    </tr></thead><tbody>
    ${rows.map((t) => {
      const lag = lagDays(t);
      return `<tr class="${t.id === highlightId ? "hl" : ""}">
        <td>${esc(t.filedDate)}</td><td class="muted">${esc(t.tradeDate)}</td>
        <td class="${lag > 30 ? "lag-warn" : "muted"}">${lag != null ? lag + "d" : "—"}</td>
        <td><span class="src-pill">${SRC_SHORT[t.source] || t.source}</span></td>
        ${showTrader ? `<td><span class="trader-link" onclick="location.hash='#trader/${encodeURIComponent(t.trader)}'">${esc(t.trader)}</span> <span class="muted">${esc(t.traderRole || "")}</span></td>` : ""}
        <td><span class="tick" onclick="location.hash='#ticker/${esc(t.ticker)}'">${esc(t.ticker)}</span></td>
        <td class="type-${esc(t.type)}">${esc(t.type.replace("_", " "))}</td>
        <td class="num">${fmtUsd(t.estUsd)}</td>
        <td class="num muted">${t.usdMin != null ? fmtUsd(t.usdMin) + "–" + fmtUsd(t.usdMax) : "—"}</td>
        <td class="muted">${esc(t.sector || "")}</td>
        <td>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">filing↗</a>` : ""}</td>
      </tr>`;
    }).join("")}
    </tbody></table></div>`;
}

/* bull (green) / bear (red) / "" — bearish keywords checked first since messages may contain both */
function alertDirection(a) {
  const m = (a.message || "").toLowerCase();
  if (/\b(sold|sell|sale|trim|exit|dump|short|pump|stale)/.test(m)) return "bear";
  if (["insider_big_buy", "insider_cluster", "activist_13d", "fund_conviction", "congress_big_buy"].includes(a.rule)
    || /\b(bought|buy|add|new position|stake|accumulat)/.test(m)) return "bull";
  return "";
}

function alertHTML(a) {
  const fresh = a.ts > state.lastVisit;
  const [label, desc] = RULE_META[a.rule] || [a.rule.replace(/_/g, " ").toUpperCase(), ""];
  const target = a.tradeIds?.length ? `#trade/${a.tradeIds[0]}` : a.ticker ? `#ticker/${a.ticker}` : "";
  const tip = [
    a.message,
    desc ? `${label} — ${desc}` : label,
    `Severity: ${a.severity} · Source: ${SRC_SHORT[a.source] || a.source}${a.trader ? ` · ${a.trader}` : ""}`,
    new Date(a.ts).toLocaleString(),
    target ? `Click to open ${a.tradeIds?.length ? "this trade" : a.ticker}` : ""
  ].filter(Boolean).join("\n");
  const dir = alertDirection(a);
  return `<div class="alert ${esc(a.severity)} ${dir} ${fresh ? "fresh" : ""} ${target ? "clickable" : ""}"
    ${target ? `onclick="location.hash='${esc(target)}'"` : ""} data-tip="${esc(tip)}">
    <div class="alert-top">
      <span class="alert-time">${esc(fmtAlertTime(a.ts))}</span>
      ${dir ? `<span class="dir-arrow">${dir === "bull" ? "▲" : "▼"}</span>` : ""}
      <span class="alert-rule sev-${esc(a.severity)}">${esc(label)}</span>
      ${a.ticker ? `<span class="tick">${esc(a.ticker)}</span>` : ""}
    </div>
    <div class="alert-msg">${esc(a.message)}</div>
  </div>`;
}

/* ---------------- hover tooltip (any element with data-tip) ---------------- */
const tipEl = document.createElement("div");
tipEl.id = "tooltip";
document.body.appendChild(tipEl);
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tipEl.style.display = "none"; return; }
  tipEl.textContent = t.dataset.tip;
  tipEl.style.display = "block";
  const r = t.getBoundingClientRect();
  let y = r.bottom + 8;
  if (y + tipEl.offsetHeight > innerHeight - 8) y = r.top - tipEl.offsetHeight - 8;
  tipEl.style.left = Math.max(8, Math.min(r.left, innerWidth - tipEl.offsetWidth - 12)) + "px";
  tipEl.style.top = Math.max(8, y) + "px";
});

/* ---------------- sortable table headers ---------------- */
let tradesServerSort = null; // set by renderTrades: paginated data must be sorted server-side

const cellSortVal = (s) => {
  s = s.trim();
  if (!s || s === "—") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s; // ISO dates: lexicographic
  const clean = s.replace(/[,$]/g, "");
  const m = clean.match(/^-?[\d.]+/);
  if (m) {
    const suf = clean.charAt(m[0].length).toUpperCase();
    return parseFloat(m[0]) * (suf === "K" ? 1e3 : suf === "M" ? 1e6 : suf === "B" ? 1e9 : 1);
  }
  return s.toLowerCase();
};

view.addEventListener("click", (e) => {
  const th = e.target.closest("th");
  const table = th?.closest("table");
  if (!table || !table.tBodies[0]) return;
  const dir = th.dataset.dir === "asc" ? "desc" : "asc";
  table.querySelectorAll("th").forEach((h) => { h.removeAttribute("data-dir"); h.classList.remove("sorted"); });
  th.dataset.dir = dir;
  th.classList.add("sorted");
  if (table.classList.contains("server-sort") && th.dataset.field && tradesServerSort)
    return tradesServerSort(th.dataset.field, dir);
  const tb = table.tBodies[0];
  const idx = [...th.parentNode.children].indexOf(th);
  const rows = [...tb.rows];
  const vals = new Map(rows.map((r) => [r, cellSortVal(r.cells[idx]?.textContent ?? "")]));
  const allNum = [...vals.values()].every((v) => v == null || typeof v === "number");
  rows.sort((r1, r2) => {
    let a = vals.get(r1), b = vals.get(r2);
    if (a == null || b == null) return (a == null) - (b == null); // empties last
    if (!allNum) { a = String(a); b = String(b); }
    const c = a < b ? -1 : a > b ? 1 : 0;
    return dir === "asc" ? c : -c;
  }).forEach((r) => tb.appendChild(r));
});

/* ---------------- "highest probability" follow picks ---------------- */
// Transparent heuristic: signal type + consensus + size + freshness. Not a true probability.
function topFollows(trades, agg) {
  const aggBy = Object.fromEntries(agg.map((a) => [a.ticker, a]));
  const scored = [];
  for (const t of trades) {
    if (!["buy", "new_stake", "add"].includes(t.type) || !t.ticker || t.ticker === "?") continue;
    const why = [];
    let s = 0;
    const pt = (pts, txt) => { s += pts; why.push([pts, txt]); };

    if (t.source === "form4") {
      const senior = /ceo|cfo|president|chair/i.test(t.traderRole || "");
      pt(senior ? 34 : 26, `Open-market insider buy by ${t.traderRole || "an insider"} — insiders buying with their own cash is the best-documented outperformance signal${senior ? ", and C-suite buys carry the most information" : ""}.`);
    } else if (t.source === "sc13d") {
      pt(30, "New activist 13D stake >5% — activists push for value-unlocking change, and 13D announcements historically see positive drift.");
    } else if (t.source === "fund13f") {
      pt(t.type === "new_stake" ? 24 : 16, `${t.trader} ${t.type === "new_stake" ? "opened a brand-new position" : "added to an existing position"} — a conviction move by a tracked superinvestor.`);
    } else if (t.source === "congress") {
      pt(14, "Congressional purchase — historically informative but noisy and slowly disclosed.");
    }

    const a = aggBy[t.ticker];
    if (a?.traders > 1) pt(Math.min(24, (a.traders - 1) * 6), `Consensus: ${a.traders} distinct smart-money traders are active in ${t.ticker} this window.`);
    if (a?.netUsd > 0) pt(6, `Net flow in ${t.ticker} is positive (${fmtUsd(a.netUsd)}) — buyers outweigh sellers.`);

    const usd = t.estUsd || 0;
    if (usd >= 1e6) pt(usd >= 1e8 ? 14 : usd >= 1e7 ? 11 : 8, `Meaningful size: ~${fmtUsd(usd)} reported.`);

    const lag = lagDays(t);
    if (lag != null) {
      if (lag <= 3) pt(14, `Fresh: disclosed only ${lag}d after the trade — the signal is still actionable.`);
      else if (lag <= 14) pt(7, `Disclosed ${lag}d after the trade — reasonably fresh.`);
      else if (lag > 30) pt(-15, `Stale: disclosed ${lag}d after the trade — much of the edge has likely decayed.`);
    }
    const ageD = Math.round((Date.now() - new Date(t.filedDate)) / 864e5);
    if (ageD <= 7) pt(8, `Filed ${ageD <= 0 ? "today" : ageD + "d ago"} — recent enough to act on.`);

    scored.push({ t, score: Math.max(1, Math.min(99, Math.round(s))), why });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set(), picks = [];
  for (const p of scored) {
    if (seen.has(p.t.ticker)) continue;
    seen.add(p.t.ticker);
    picks.push(p);
    if (picks.length === 3) break;
  }
  return picks;
}

function followCardHTML(picks) {
  if (!picks.length) return "";
  return `<div class="card follow-card">
    <h3>⚡ Highest probability — top 3 trades to follow <span class="badge">heuristic — click a pick for the why</span></h3>
    ${picks.map((p, i) => {
      const t = p.t;
      return `<details class="prob-item">
        <summary>
          <span class="rank">#${i + 1}</span>
          <span class="prob-gauge"><span style="width:${p.score}%"></span></span>
          <span class="prob-score">${p.score}</span>
          <span class="tick" onclick="event.preventDefault();event.stopPropagation();location.hash='#ticker/${esc(t.ticker)}'">${esc(t.ticker)}</span>
          <span class="type-${esc(t.type)}">${esc(t.type.replace("_", " "))}</span>
          <span class="muted prob-who">${esc(t.trader)}${t.traderRole ? " · " + esc(t.traderRole) : ""} · ${fmtUsd(t.estUsd)} · filed ${esc(t.filedDate)}</span>
        </summary>
        <div class="prob-why">
          <div class="why-title">Why this is pick #${i + 1} (score ${p.score}/100)</div>
          <ul>${p.why.map(([pts, txt]) => `<li><b class="${pts >= 0 ? "pos" : "neg"}">${pts >= 0 ? "+" : ""}${pts}</b> ${esc(txt)}</li>`).join("")}</ul>
          <div class="why-links">
            <a href="#trade/${esc(t.id)}">view this trade →</a>
            <a href="#ticker/${esc(t.ticker)}">${esc(t.ticker)} flow →</a>
            ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">original filing ↗</a>` : ""}
          </div>
          <div class="why-caveat">Score is a transparent heuristic (signal type + consensus + size + freshness), not a true probability. Disclosures lag reality — not investment advice.</div>
        </div>
      </details>`;
    }).join("")}
  </div>`;
}

/* ---------------- crowd attention panel ---------------- */
function attentionCardHTML(att, sig = {}) {
  const total = Object.keys(sig).length;
  const live = Object.values(sig).filter((s) => s.configured).length;
  const dormant = Object.values(sig).filter((s) => !s.configured).map((s) => s.label);
  const srcPill = (src, v) => {
    const what = src === "stocktwits"
      ? `trending #${v.rank ?? "?"} · ${Number(v.value).toLocaleString()} watchers`
      : `${v.value} mention${v.value === 1 ? "" : "s"} / posts (24h)`;
    return `<span class="src-pill" data-tip="${esc(sig[src]?.label || src)}: ${esc(what)}">${SRC_SHORT[src] || src}${src === "stocktwits" && v.rank ? " #" + v.rank : " " + v.value}</span>`;
  };
  const rows = att.filter((r) => Object.keys(r.sources).length || r.pump).slice(0, 12);
  return `<div class="card" style="margin-top:16px">
    <h3>Crowd attention — social &amp; short-volume signals <span class="badge">${live}/${total} feeds live</span></h3>
    ${rows.length ? `<div class="table-scroll" style="max-height:340px"><table>
      <thead><tr><th>Ticker</th><th>Attention by source</th><th class="num">Bull %</th><th class="num">Short vol %</th><th>Smart money first?</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="tick" onclick="location.hash='#ticker/${esc(r.ticker)}'">${esc(r.ticker)}</span></td>
        <td>${Object.entries(r.sources).map(([s, v]) => srcPill(s, v)).join(" ")}</td>
        <td class="num" style="color:var(${r.sentiment == null ? "--dim" : r.sentiment >= 50 ? "--buy" : "--sell"})">${r.sentiment == null ? "—" : r.sentiment + "%"}</td>
        <td class="num ${r.shortPct >= 60 ? "lag-warn" : "muted"}">${r.shortPct == null ? "—" : r.shortPct + "%"}</td>
        <td>${r.smartBuyers ? `<span class="badge hot" data-tip="${r.smartBuyers} smart-money buyer${r.smartBuyers > 1 ? "s" : ""} disclosed buying within 14d — the crowd may be late to their trade">◆ ${r.smartBuyers} buyer${r.smartBuyers > 1 ? "s" : ""} in first</span>` : `<span class="muted" style="font-size:11px">no disclosed buying</span>`}</td>
        <td>${r.pump ? `<span class="lag-warn" data-tip="Mentioned in a monitored Telegram pump channel — treat as manipulation risk, not a buy signal">⚠ pump</span>` : ""}</td>
      </tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">No social signals yet — attention data accumulates from the next poll.</div>`}
    ${dormant.length ? `<div class="muted" style="font-size:11px;margin-top:8px">dormant feeds (add credentials in .env — see .env.example): ${dormant.map(esc).join(" · ")}</div>` : ""}
  </div>`;
}

/* ---------------- views ---------------- */
async function renderOverview() {
  const [summary, agg, alerts, tr, att] = await Promise.all([
    api("/api/summary"), api("/api/aggregate"), api("/api/alerts"),
    api("/api/trades", { limit: 500 }), api("/api/attention")
  ]);
  const picks = topFollows(tr.rows, agg);
  const kpAgg = agg.slice(0, 5);
  const t = summary.tiers;
  view.innerHTML = `
    <div class="split">
      <div class="card">
        <h3>Flow heatmap — gross reported $ by ticker (green = net buying, red = net selling)</h3>
        <div id="heatmap"></div>
      </div>
      <div class="card">
        <h3>Alert feed ${alerts.filter((a) => a.ts > state.lastVisit).length ? `<span class="badge hot">new</span>` : ""}</h3>
        <div class="alert-feed">${alerts.length ? alerts.map(alertHTML).join("") : `<div class="empty">No alerts yet.</div>`}</div>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="v">${summary.totalTrades.toLocaleString()}</div><div class="l">trades in store</div></div>
      <div class="kpi"><div class="v">${agg.length}</div><div class="l">tickers active (${state.window})</div></div>
      ${kpAgg.slice(0, 3).map((r) => `<div class="kpi"><div class="v" style="color:var(--accent)">${esc(r.ticker)}</div><div class="l">${fmtUsd(r.grossUsd)} · ${r.traders} traders</div></div>`).join("")}
    </div>

    <div class="grid gauges">
      ${Object.entries(t).map(([src, m], i) => `
        <div class="card">
          <h3>${esc(m.label)} ${m.alerts24h ? `<span class="badge hot">${m.alerts24h} alerts</span>` : ""}</h3>
          <div class="gauge-wrap">
            ${gaugeSVG(m.last24h / m.dailyBaseline, ["--buy", "--crit", "--info", "--accent"][i % 4])}
            <div class="gauge-meta">
              <div class="big tier${(i % 4) + 1}">${m.last24h}</div>
              <div class="sub">filings 24h · baseline ${m.dailyBaseline}/d</div>
              <div class="sub">${m.last7d} 7d · ${m.last30d} 30d</div>
            </div>
          </div>
        </div>`).join("")}
    </div>

    ${followCardHTML(picks)}

    ${attentionCardHTML(att, summary.signalTiers)}

    <div class="card" style="margin-top:16px">
      <h3>Top tickers by consensus — who's crowding in (${state.window})</h3>
      <div class="table-scroll" style="max-height:420px"><table>
        <thead><tr><th>Ticker</th><th>Company</th><th>Sector</th><th class="num">Traders</th><th class="num">Trades</th>
        <th class="num">Buy $</th><th class="num">Sell $</th><th class="num">Net $</th><th>Sources</th></tr></thead>
        <tbody>${agg.slice(0, 25).map((r) => `<tr>
          <td><span class="tick" onclick="location.hash='#ticker/${esc(r.ticker)}'">${esc(r.ticker)}</span></td>
          <td class="muted">${esc((r.company || "").slice(0, 36))}</td><td class="muted">${esc(r.sector)}</td>
          <td class="num"><b>${r.traders}</b></td><td class="num">${r.count}</td>
          <td class="num" style="color:var(--buy)">${fmtUsd(r.buyUsd)}</td>
          <td class="num" style="color:var(--sell)">${fmtUsd(r.sellUsd)}</td>
          <td class="num" style="color:var(${r.netUsd >= 0 ? "--buy" : "--sell"})"><b>${fmtUsd(r.netUsd)}</b></td>
          <td class="muted">${Object.entries(r.sources).map(([s, n]) => `${SRC_SHORT[s]}:${n}`).join(" ")}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>`;

  const hm = $("#heatmap");
  hm.innerHTML = heatmapHTML(agg, hm.clientWidth, hm.clientHeight || 460);
  updateBell(alerts);

  // infinite scroll: page older alerts into the feed for a full chronological history
  const feed = $(".alert-feed");
  if (feed && alerts.length) {
    let oldest = alerts[alerts.length - 1].ts;
    let loading = false, done = alerts.length < 100;
    const endMark = () => feed.insertAdjacentHTML("beforeend", `<div class="feed-end">— end of alert history · ${feed.querySelectorAll(".alert").length} alerts —</div>`);
    if (done) endMark(); // whole history already shown: say so instead of silently doing nothing
    feed.onscroll = async () => {
      if (loading || done || feed.scrollTop + feed.clientHeight < feed.scrollHeight - 80) return;
      loading = true;
      try {
        const more = await api("/api/alerts", { before: oldest, limit: 50 });
        if (more.length) {
          feed.insertAdjacentHTML("beforeend", more.map(alertHTML).join(""));
          oldest = more[more.length - 1].ts;
        }
        if (more.length < 50) { done = true; endMark(); }
      } finally { loading = false; }
    };
  }
}

async function renderTrades(params = {}) {
  const f = { source: "", type: "", ticker: "", trader: "", sector: "", minUsd: "", offset: 0, sort: "filedDate", dir: "desc", ...params };
  const load = async () => {
    const data = await api("/api/trades", { ...f, limit: 100 });
    $("#tradeTableWrap").innerHTML = tradesTable(data.rows, { serverSorted: true });
    const th = $(`#tradeTableWrap th[data-field="${f.sort}"]`);
    if (th) { th.dataset.dir = f.dir; th.classList.add("sorted"); }
    $("#pageInfo").textContent = `${f.offset + 1}–${Math.min(f.offset + 100, data.total)} of ${data.total}`;
  };
  tradesServerSort = (field, dir) => { f.sort = field; f.dir = dir; f.offset = 0; load(); };
  view.innerHTML = `
    <h2 class="section">All disclosed trades</h2>
    <div class="filters">
      <label>Source <select id="fSrc"><option value="">all</option><option value="form4">Insiders</option><option value="form144">Sale notices 144</option><option value="sc13d">Activists 13D</option><option value="sc13g">Passive 13G</option><option value="fund13f">13F funds</option><option value="congress">Congress</option></select></label>
      <label>Type <select id="fType"><option value="">all</option><option>buy</option><option>sell</option><option>new_stake</option><option>add</option><option>trim</option><option>exit</option></select></label>
      <label>Ticker <input id="fTicker" type="text" placeholder="NVDA" /></label>
      <label>Trader <input id="fTrader" type="text" placeholder="name…" /></label>
      <label>Min $ <select id="fMin"><option value="">any</option><option value="100000">$100K</option><option value="1000000">$1M</option><option value="10000000">$10M</option><option value="100000000">$100M</option></select></label>
      <button id="applyF">Apply</button>
    </div>
    <div id="tradeTableWrap"></div>
    <div class="pager"><button id="prevPg">← prev</button><span id="pageInfo"></span><button id="nextPg">next →</button></div>`;
  $("#fSrc").value = f.source; $("#fType").value = f.type; $("#fTicker").value = f.ticker; $("#fTrader").value = f.trader; $("#fMin").value = f.minUsd;
  $("#applyF").onclick = () => { f.source = $("#fSrc").value; f.type = $("#fType").value; f.ticker = $("#fTicker").value; f.trader = $("#fTrader").value; f.minUsd = $("#fMin").value; f.offset = 0; load(); };
  $("#prevPg").onclick = () => { f.offset = Math.max(0, f.offset - 100); load(); };
  $("#nextPg").onclick = () => { f.offset += 100; load(); };
  await load();
}

async function renderTickers() {
  const agg = await api("/api/aggregate");
  view.innerHTML = `<h2 class="section">Ticker aggregation — consensus & magnitude (${state.window})</h2>
    <div class="card"><div class="table-scroll"><table>
      <thead><tr><th>Ticker</th><th>Company</th><th>Sector</th><th class="num">Traders</th><th class="num">Trades</th>
      <th class="num">Buy $</th><th class="num">Sell $</th><th class="num">Net $</th><th class="num">Gross $</th><th>Last filed</th></tr></thead>
      <tbody>${agg.map((r) => `<tr>
        <td><span class="tick" onclick="location.hash='#ticker/${esc(r.ticker)}'">${esc(r.ticker)}</span></td>
        <td class="muted">${esc((r.company || "").slice(0, 40))}</td><td class="muted">${esc(r.sector)}</td>
        <td class="num"><b>${r.traders}</b></td><td class="num">${r.count}</td>
        <td class="num" style="color:var(--buy)">${fmtUsd(r.buyUsd)}</td>
        <td class="num" style="color:var(--sell)">${fmtUsd(r.sellUsd)}</td>
        <td class="num" style="color:var(${r.netUsd >= 0 ? "--buy" : "--sell"})"><b>${fmtUsd(r.netUsd)}</b></td>
        <td class="num">${fmtUsd(r.grossUsd)}</td><td class="muted">${esc(r.lastFiled)}</td>
      </tr>`).join("")}</tbody></table></div></div>`;
}

async function renderTraders() {
  const rows = await api("/api/traders");
  view.innerHTML = `<h2 class="section">Trader leaderboard (${state.window})</h2>
    <div class="card"><div class="table-scroll"><table>
      <thead><tr><th>Trader</th><th>Role</th><th>Source</th><th class="num">Trades</th><th class="num">Tickers</th>
      <th class="num">Buy $</th><th class="num">Sell $</th><th>Last filed</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="trader-link" onclick="location.hash='#trader/${encodeURIComponent(r.trader)}'">${esc(r.trader)}</span></td>
        <td class="muted">${esc(r.role || "")}</td><td><span class="src-pill">${SRC_SHORT[r.source]}</span></td>
        <td class="num">${r.count}</td><td class="num">${r.tickers}</td>
        <td class="num" style="color:var(--buy)">${fmtUsd(r.buyUsd)}</td>
        <td class="num" style="color:var(--sell)">${fmtUsd(r.sellUsd)}</td>
        <td class="muted">${esc(r.lastFiled)}</td>
      </tr>`).join("")}</tbody></table></div></div>`;
}

async function renderSectors() {
  const rows = await api("/api/sectors");
  const max = Math.max(...rows.map((r) => r.buyUsd + r.sellUsd), 1);
  view.innerHTML = `<h2 class="section">Sector flows (${state.window})</h2>
    <div class="card"><div class="table-scroll"><table>
      <thead><tr><th>Sector</th><th class="num">Tickers</th><th class="num">Trades</th>
      <th class="num">Buy $</th><th class="num">Sell $</th><th class="num">Net $</th><th style="width:30%">Gross flow</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><b>${esc(r.sector)}</b></td><td class="num">${r.tickers}</td><td class="num">${r.count}</td>
        <td class="num" style="color:var(--buy)">${fmtUsd(r.buyUsd)}</td>
        <td class="num" style="color:var(--sell)">${fmtUsd(r.sellUsd)}</td>
        <td class="num" style="color:var(${r.netUsd >= 0 ? "--buy" : "--sell"})"><b>${fmtUsd(r.netUsd)}</b></td>
        <td><div style="height:10px;border-radius:5px;background:linear-gradient(90deg,var(--buy) ${((r.buyUsd / (r.buyUsd + r.sellUsd || 1)) * 100).toFixed(0)}%,var(--sell) 0);width:${Math.max(3, ((r.buyUsd + r.sellUsd) / max) * 100).toFixed(0)}%"></div></td>
      </tr>`).join("")}</tbody></table></div></div>`;
}

async function renderTicker(ticker) {
  const data = await api("/api/trades", { ticker, limit: 500 });
  const rows = data.rows;
  const buy = rows.filter((t) => ["buy", "new_stake", "add"].includes(t.type)).reduce((s, t) => s + (t.estUsd || 0), 0);
  const sell = rows.filter((t) => ["sell", "trim", "exit"].includes(t.type)).reduce((s, t) => s + (t.estUsd || 0), 0);
  const traders = new Set(rows.map((t) => t.trader));
  // weekly timeline buckets
  const weeks = {};
  for (const t of rows) {
    const wk = t.filedDate?.slice(0, 10);
    if (!wk) continue;
    const key = new Date(new Date(wk) - new Date(wk).getDay() * 864e5).toISOString().slice(5, 10);
    const b = (weeks[key] ||= { buy: 0, sell: 0 });
    if (["buy", "new_stake", "add"].includes(t.type)) b.buy += t.estUsd || 0; else b.sell += t.estUsd || 0;
  }
  const wkKeys = Object.keys(weeks).sort();
  const wkMax = Math.max(...wkKeys.map((k) => weeks[k].buy + weeks[k].sell), 1);

  view.innerHTML = `
    <div class="detail-head">
      <h2><a class="name-ext tick-ext" href="https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}" target="_blank" rel="noopener"
        data-tip="Open ${esc(ticker)} on Finviz in a new tab — chart, fundamentals, news.">${esc(ticker)} <span class="ext-hint">↗</span></a></h2>
      <span class="co">${esc(rows[0]?.company || "")} · ${esc(rows[0]?.sector || "")}</span>
      <a href="#tickers">← all tickers</a>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${traders.size}</div><div class="l">distinct traders</div></div>
      <div class="kpi"><div class="v">${rows.length}</div><div class="l">disclosures (${state.window})</div></div>
      <div class="kpi"><div class="v" style="color:var(--buy)">${fmtUsd(buy)}</div><div class="l">reported buying</div></div>
      <div class="kpi"><div class="v" style="color:var(--sell)">${fmtUsd(sell)}</div><div class="l">reported selling</div></div>
      <div class="kpi"><div class="v" style="color:var(${buy - sell >= 0 ? "--buy" : "--sell"})">${fmtUsd(buy - sell)}</div><div class="l">net flow</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h3>Weekly flow (filed date)</h3>
      <div class="timeline">${wkKeys.map((k) => {
        const b = weeks[k];
        return `<div class="tl-bar" title="wk ${k}: buys ${fmtUsd(b.buy)} / sells ${fmtUsd(b.sell)}">
          <div class="tl-buy" style="height:${(b.buy / wkMax) * 70}px"></div>
          <div class="tl-sell" style="height:${(b.sell / wkMax) * 70}px"></div>
          <div class="tl-lab">${k}</div></div>`;
      }).join("")}</div>
    </div>
    ${tradesTable(rows)}`;
}

async function renderTrader(name) {
  const data = await api("/api/trades", { trader: name, limit: 500 });
  const rows = data.rows.filter((t) => t.trader.toLowerCase() === name.toLowerCase() || t.trader.toLowerCase().includes(name.toLowerCase()));
  const buy = rows.filter((t) => ["buy", "new_stake", "add"].includes(t.type)).reduce((s, t) => s + (t.estUsd || 0), 0);
  const sell = rows.filter((t) => ["sell", "trim", "exit"].includes(t.type)).reduce((s, t) => s + (t.estUsd || 0), 0);
  const avgLag = rows.map(lagDays).filter((x) => x != null);
  const src = rows[0]?.source;
  const role = rows[0]?.traderRole || "";
  const coCount = {};
  for (const t of rows) if (t.company) coCount[t.company] = (coCount[t.company] || 0) + 1;
  const topCos = Object.entries(coCount).sort((a, b) => b[1] - a[1]);
  const primaryCo = topCos[0]?.[0] || "";
  const extUrl = traderProfileUrl(name, src, role, primaryCo);
  const secUrl = `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(`"${name}"`)}${src === "form4" ? "&forms=4" : ""}`;
  const firstSeen = rows.reduce((m, t) => (t.tradeDate && t.tradeDate < m ? t.tradeDate : m), "9999-99-99");
  view.innerHTML = `
    <div class="detail-head">
      <h2 style="font-size:20px"><a class="name-ext" href="${esc(extUrl)}" target="_blank" rel="noopener"
        data-tip="Open an external profile of ${esc(name)} in a new tab — who they are, their role, their company.">${esc(name)} <span class="ext-hint">↗</span></a></h2>
      <span class="co">${esc(role)}</span><a href="#traders">← leaderboard</a></div>
    <div class="card profile-card">
      <h3>Profile</h3>
      <div class="profile-grid">
        <div><div class="l">Role</div><div class="v">${esc(role || "—")}</div></div>
        <div><div class="l">${src === "form4" ? "Company (insider at)" : "Top companies traded"}</div>
          <div class="v">${esc((src === "form4" ? primaryCo : topCos.slice(0, 3).map(([c]) => c).join(", ")) || "—")}</div></div>
        <div><div class="l">Disclosure source</div><div class="v">${esc(SRC_LABEL[src] || src || "—")}</div></div>
        <div><div class="l">Active</div><div class="v">${esc(firstSeen === "9999-99-99" ? "—" : firstSeen)} → ${esc(rows.reduce((m, t) => (t.filedDate > m ? t.filedDate : m), "") || "—")}</div></div>
      </div>
      <div class="profile-links">
        <a href="${esc(extUrl)}" target="_blank" rel="noopener">${src === "congress" ? "🏛 congress.gov member profile ↗" : "🔎 who they are ↗"}</a>
        ${src === "congress"
          ? `<a href="https://www.google.com/search?q=${encodeURIComponent(`"${name}" ${role}`)}" target="_blank" rel="noopener">🔎 web search ↗</a>`
          : `<a href="${esc(secUrl)}" target="_blank" rel="noopener">📄 SEC filings ↗</a>`}
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${rows.length}</div><div class="l">disclosures (${state.window})</div></div>
      <div class="kpi"><div class="v">${new Set(rows.map((t) => t.ticker)).size}</div><div class="l">tickers</div></div>
      <div class="kpi"><div class="v" style="color:var(--buy)">${fmtUsd(buy)}</div><div class="l">buys</div></div>
      <div class="kpi"><div class="v" style="color:var(--sell)">${fmtUsd(sell)}</div><div class="l">sells</div></div>
      <div class="kpi"><div class="v ${avgLag.length && avgLag.reduce((a, b) => a + b, 0) / avgLag.length > 30 ? "lag-warn" : ""}">${avgLag.length ? Math.round(avgLag.reduce((a, b) => a + b, 0) / avgLag.length) + "d" : "—"}</div><div class="l">avg disclosure lag</div></div>
    </div>
    ${tradesTable(rows, { showTrader: false })}`;
}

async function renderTrade(id) {
  const t = await api("/api/trade", { id });
  if (!t || t.error) {
    view.innerHTML = `<div class="empty">Trade not found — it may have been purged. <a href="#trades">← all trades</a></div>`;
    return;
  }
  const ctx = await api("/api/trades", { ticker: t.ticker, limit: 100 });
  const lag = lagDays(t);
  const isBuy = ["buy", "new_stake", "add"].includes(t.type);
  const verb = { buy: "bought", sell: "sold", new_stake: "disclosed a new stake of", add: "added", trim: "trimmed", exit: "exited" }[t.type] || t.type;
  view.innerHTML = `
    <div class="detail-head">
      <h2>${esc(t.ticker)}</h2>
      <span class="type-${esc(t.type)}" style="font-size:16px">${esc(t.type.replace("_", " ").toUpperCase())}</span>
      <span class="co">${esc(t.company || "")} · ${esc(t.sector || "")}</span>
      <a href="#trades">← all trades</a>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v" style="color:var(${isBuy ? "--buy" : "--sell"})">${fmtUsd(t.estUsd)}</div>
        <div class="l">est. value${t.usdMin != null ? ` (${fmtUsd(t.usdMin)}–${fmtUsd(t.usdMax)})` : ""}</div></div>
      <div class="kpi"><div class="v">${t.shares ? t.shares.toLocaleString() : "—"}</div><div class="l">shares${t.price ? " @ $" + t.price : ""}</div></div>
      <div class="kpi"><div class="v">${esc(t.tradeDate || "—")}</div><div class="l">trade date</div></div>
      <div class="kpi"><div class="v">${esc(t.filedDate || "—")}</div><div class="l">filed date</div></div>
      <div class="kpi"><div class="v ${lag > 30 ? "lag-warn" : ""}">${lag != null ? lag + "d" : "—"}</div><div class="l">disclosure lag</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h3>Disclosure</h3>
      <p style="font-size:14px;line-height:1.7">
        <span class="trader-link" onclick="location.hash='#trader/${encodeURIComponent(t.trader)}'">${esc(t.trader)}</span>
        ${t.traderRole ? `<span class="muted">(${esc(t.traderRole)})</span>` : ""}
        ${esc(verb)} ~${fmtUsd(t.estUsd)} of
        <span class="tick" onclick="location.hash='#ticker/${esc(t.ticker)}'">${esc(t.ticker)}</span>
        · reported via <span class="src-pill">${SRC_SHORT[t.source] || esc(t.source)}</span>
        ${t.url ? ` · <a href="${esc(t.url)}" target="_blank" rel="noopener">original filing ↗</a>` : ""}
      </p>
    </div>
    <div class="card">
      <h3>Recent ${esc(t.ticker)} disclosures (${state.window}) — this trade highlighted</h3>
      ${tradesTable(ctx.rows, { highlightId: t.id })}
    </div>`;
  $("tr.hl")?.scrollIntoView({ block: "center" });
}

/* ---------------- router / chrome ---------------- */
async function route() {
  const h = location.hash.slice(1) || "overview";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", h.startsWith(a.dataset.view)));
  tradesServerSort = null;
  try {
    if (h.startsWith("ticker/")) return await renderTicker(decodeURIComponent(h.slice(7)));
    if (h.startsWith("trader/")) return await renderTrader(decodeURIComponent(h.slice(7)));
    if (h.startsWith("trade/")) return await renderTrade(decodeURIComponent(h.slice(6)));
    if (h === "trades") return await renderTrades();
    if (h === "tickers") return await renderTickers();
    if (h === "traders") return await renderTraders();
    if (h === "sectors") return await renderSectors();
    return await renderOverview();
  } catch (e) {
    view.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}. Is the server running?</div>`;
  }
}

function updateBell(alerts) {
  const fresh = alerts.filter((a) => a.ts > state.lastVisit).length;
  $("#bellCount").textContent = fresh || "";
  if (fresh && "Notification" in window && Notification.permission === "granted") {
    // one summary notification per session
    if (!sessionStorage.getItem("ceres.notified")) {
      new Notification("Ceres", { body: `${fresh} new smart-money alerts since your last visit` });
      sessionStorage.setItem("ceres.notified", "1");
    }
  }
}

async function refreshStatus() {
  try {
    const s = await api("/api/summary");
    const polls = Object.entries(s.tiers).map(([k, m]) => `${SRC_SHORT[k]} ${m.lastPoll ? new Date(m.lastPoll).toLocaleTimeString() : "never"}`).join(" · ");
    $("#statusBar").textContent = `${s.totalTrades.toLocaleString()} trades · last polls: ${polls}`;
  } catch { $("#statusBar").textContent = "server unreachable"; }
}

$("#windowSel").onchange = (e) => { state.window = e.target.value; localStorage.setItem("ceres.window", state.window); route(); };
$("#pollBtn").onclick = async () => {
  $("#pollBtn").textContent = "⟳ polling…";
  await fetch("/api/poll", { method: "POST" });
  setTimeout(() => { $("#pollBtn").textContent = "⟳ Poll now"; route(); refreshStatus(); }, 12000);
};
$("#purgeDemoBtn").onclick = async () => {
  if (!confirm("Remove all demo seed data?")) return;
  await fetch("/api/purge-demo", { method: "POST" });
  route(); refreshStatus();
};
$("#alertBell").onclick = () => {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  location.hash = "#overview";
};

window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", () => localStorage.setItem("ceres.lastVisit", new Date().toISOString()));
setInterval(refreshStatus, 60_000);
setInterval(() => { if ((location.hash.slice(1) || "overview") === "overview") route(); }, 5 * 60_000); // soft auto-refresh

route();
refreshStatus();
