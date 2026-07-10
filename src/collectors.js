// Ceres data collectors: Form 4 (insiders), SC 13D (activists), 13F (funds), Congress.
import { CONFIG } from "./config.js";
import { store } from "./store.js";
import {
  politeFetch, hashId, xmlText, xmlBlocks, decodeEntities,
  parseAmountRange, toISO, daysAgoISO, titleCase
} from "./util.js";

let tickerMap = null; // CIK -> { ticker, title }

async function loadTickerMap() {
  if (tickerMap) return tickerMap;
  try {
    const j = await politeFetch(CONFIG.edgar.tickersUrl, { json: true });
    tickerMap = {};
    for (const k of Object.keys(j)) {
      const { cik_str, ticker, title } = j[k];
      if (!tickerMap[cik_str]) tickerMap[cik_str] = { ticker, title };
    }
  } catch (e) {
    console.error("[ceres] ticker map load failed:", e.message);
    tickerMap = {};
  }
  return tickerMap;
}

/* ------------------------------ Atom helpers ------------------------------ */

function parseAtomEntries(atomXml) {
  return xmlBlocks(atomXml, "entry").map((e) => {
    const title = xmlText(e, "title") || "";
    const linkM = e.match(/<link[^>]*href="([^"]+)"/i);
    const link = linkM ? decodeEntities(linkM[1]) : null;
    const updated = xmlText(e, "updated");
    // ".../Archives/edgar/data/1234567/000123456726000123/0001234567-26-000123-index.htm"
    const accM = (link || "").match(/\/(\d{10}-\d{2}-\d{6})-index/);
    const cikM = (link || "").match(/\/data\/(\d+)\//);
    return {
      title, link, updated,
      accession: accM ? accM[1] : null,
      accNoDash: accM ? accM[1].replace(/-/g, "") : null,
      cik: cikM ? cikM[1] : null
    };
  });
}

async function filingFileList(cik, accNoDash) {
  const j = await politeFetch(`${CONFIG.edgar.archiveDir(cik, accNoDash)}/index.json`, { json: true });
  return (j?.directory?.item || []).map((i) => i.name);
}

/* ------------------------------ Form 4 ------------------------------ */

export async function collectForm4() {
  const atom = await politeFetch(CONFIG.edgar.form4Atom);
  const entries = parseAtomEntries(atom)
    .filter((e) => e.accession && !store.seenAcc.has("f4:" + e.accession))
    .slice(0, CONFIG.form4MaxFilingsPerPoll);

  let added = 0;
  for (const e of entries) {
    store.seenAcc.add("f4:" + e.accession);
    try {
      const files = await filingFileList(e.cik, e.accNoDash);
      const xmlFile = files.find((f) => /\.xml$/i.test(f) && !/index/i.test(f));
      if (!xmlFile) continue;
      const xml = await politeFetch(`${CONFIG.edgar.archiveDir(e.cik, e.accNoDash)}/${xmlFile}`);
      added += ingestForm4Xml(xml, e);
    } catch (err) {
      console.error("[form4]", e.accession, err.message);
    }
  }
  store.state.lastPoll.form4 = new Date().toISOString();
  return added;
}

function ingestForm4Xml(xml, entry) {
  const ticker = (xmlText(xml, "issuerTradingSymbol") || "").toUpperCase().replace(/[^A-Z.\-]/g, "");
  const company = xmlText(xml, "issuerName");
  const owner = titleCase(xmlText(xml, "rptOwnerName"));
  const officerTitle = xmlText(xml, "officerTitle");
  const isDir = /1|true/i.test(xmlText(xml, "isDirector") || "");
  const isOff = /1|true/i.test(xmlText(xml, "isOfficer") || "");
  const isTen = /1|true/i.test(xmlText(xml, "isTenPercentOwner") || "");
  const role = officerTitle || (isOff ? "Officer" : isDir ? "Director" : isTen ? "10% owner" : "Insider");
  if (!ticker || !owner) return 0;

  let added = 0;
  for (const tx of xmlBlocks(xml, "nonDerivativeTransaction")) {
    const code = xmlText(tx, "transactionCode");
    if (code !== "P" && code !== "S") continue; // open-market buys/sells only
    const shares = Number(xmlText(tx, "transactionShares")) || 0;
    const price = Number(xmlText(tx, "transactionPricePerShare")) || 0;
    const tradeDate = toISO(xmlText(tx, "transactionDate"));
    const estUsd = Math.round(shares * price);
    if (!shares || !tradeDate) continue;

    const row = {
      id: hashId("form4", entry.accession, ticker, owner, code, tradeDate, shares),
      source: "form4", ticker, company, trader: owner, traderRole: role,
      type: code === "P" ? "buy" : "sell",
      shares, price, estUsd, usdMin: estUsd, usdMax: estUsd,
      tradeDate, filedDate: toISO(entry.updated) || tradeDate,
      url: entry.link
    };
    if (store.addTrade(row)) { added++; runInsiderAlerts(row); }
  }
  return added;
}

function runInsiderAlerts(row) {
  const A = CONFIG.alerts;
  if (row.type === "buy" && row.estUsd >= A.insiderBigBuyUsd) {
    store.addAlert({
      id: hashId("al-big", row.id), ts: new Date().toISOString(),
      rule: "insider_big_buy", severity: "high", source: "form4",
      ticker: row.ticker, trader: row.trader,
      message: `${row.trader} (${row.traderRole}) bought ~$${fmtM(row.estUsd)} of ${row.ticker}`,
      tradeIds: [row.id]
    });
  }
  if (row.type === "buy") {
    const cutoff = daysAgoISO(A.insiderClusterWindowDays);
    const buyers = new Set(
      store.trades
        .filter((t) => t.source === "form4" && t.type === "buy" && t.ticker === row.ticker && t.tradeDate >= cutoff)
        .map((t) => t.trader)
    );
    if (buyers.size >= A.insiderClusterCount) {
      store.addAlert({
        id: hashId("al-cluster", row.ticker, daysAgoISO(0)), ts: new Date().toISOString(),
        rule: "insider_cluster", severity: "critical", source: "form4",
        ticker: row.ticker, trader: [...buyers].join(", "),
        message: `CLUSTER BUY: ${buyers.size} insiders bought ${row.ticker} within ${A.insiderClusterWindowDays}d`,
        tradeIds: []
      });
    }
  }
}

/* ------------------------------ SC 13D ------------------------------ */

export async function collect13D() {
  const map = await loadTickerMap();
  const atom = await politeFetch(CONFIG.edgar.sc13dAtom);
  const entries = parseAtomEntries(atom);
  let added = 0;

  for (const e of entries) {
    if (!e.accession) continue;
    const key = "13d:" + e.accession;
    // title looks like: "SC 13D - COMPANY NAME (0001234567) (Subject)"
    const isSubject = /\(Subject\)/i.test(e.title);
    const nameM = e.title.match(/SC 13D(?:\/A)?\s*-\s*(.+?)\s*\(\d{10}\)/i);
    const name = nameM ? decodeEntities(nameM[1]) : null;

    if (isSubject) {
      if (store.seenAcc.has(key)) continue;
      store.seenAcc.add(key);
      const info = e.cik ? map[Number(e.cik)] : null;
      const row = {
        id: hashId("13d", e.accession),
        source: "sc13d",
        ticker: info?.ticker || "?",
        company: name || info?.title || "Unknown subject",
        trader: "Activist filer (see filing)", traderRole: "13D filer",
        type: "new_stake", shares: null, price: null,
        estUsd: null, usdMin: null, usdMax: null,
        tradeDate: toISO(e.updated), filedDate: toISO(e.updated),
        url: e.link
      };
      if (store.addTrade(row)) {
        added++;
        store.addAlert({
          id: hashId("al-13d", e.accession), ts: new Date().toISOString(),
          rule: "activist_13d", severity: "high", source: "sc13d",
          ticker: row.ticker, trader: row.trader,
          message: `New 13D filed on ${row.company}${row.ticker !== "?" ? ` (${row.ticker})` : ""} — activist stake >5%`,
          tradeIds: [row.id]
        });
      }
    } else if (name) {
      // filed-by entry for same accession: backfill the activist's name
      const t = store.trades.find((t) => t.source === "sc13d" && t.url === e.link);
      if (t && t.trader === "Activist filer (see filing)") t.trader = titleCase(name);
    }
  }
  store.state.lastPoll.sc13d = new Date().toISOString();
  return added;
}

/* ------------------------------ 13F ------------------------------ */

export async function collect13F() {
  const map = await loadTickerMap();
  const nameToTicker = {};
  for (const k of Object.keys(map)) {
    nameToTicker[map[k].title.toUpperCase().replace(/[^A-Z0-9 ]/g, "")] = map[k].ticker;
  }
  let added = 0;

  for (const [cik, label] of Object.entries(CONFIG.managers)) {
    try {
      const sub = await politeFetch(CONFIG.edgar.submissions(cik), { json: true });
      const r = sub?.filings?.recent;
      if (!r) continue;
      let idx = -1;
      for (let i = 0; i < r.form.length; i++) if (r.form[i] === "13F-HR") { idx = i; break; }
      if (idx < 0) continue;

      const acc = r.accessionNumber[idx];
      const prevSnap = store.state.snapshots13F[cik];
      if (prevSnap?.accession === acc) continue; // no new filing

      const accNoDash = acc.replace(/-/g, "");
      const files = await filingFileList(cik, accNoDash);
      const infoFile = files.find((f) => /info.*table.*\.xml$/i.test(f)) ||
                       files.find((f) => /\.xml$/i.test(f) && !/primary_doc/i.test(f));
      if (!infoFile) continue;

      const xml = await politeFetch(`${CONFIG.edgar.archiveDir(cik, accNoDash)}/${infoFile}`);
      const holdings = {}; // key: nameOfIssuer -> { valueUsd, shares }
      for (const it of xmlBlocks(xml, "infoTable")) {
        const issuer = (xmlText(it, "nameOfIssuer") || "").trim();
        // Post-2023 13Fs report value in whole dollars (previously $ thousands).
        const value = Number(xmlText(it, "value")) || 0;
        const shares = Number(xmlText(it, "sshPrnamt")) || 0;
        if (!issuer) continue;
        const k = issuer.toUpperCase();
        holdings[k] = holdings[k] || { valueUsd: 0, shares: 0, issuer };
        holdings[k].valueUsd += value;
        holdings[k].shares += shares;
      }

      const filedDate = toISO(r.filingDate[idx]);
      const url = `${CONFIG.edgar.archiveDir(cik, accNoDash)}/${infoFile}`;
      if (prevSnap?.holdings) {
        added += diff13F(label, prevSnap.holdings, holdings, filedDate, url, nameToTicker);
      } else {
        // first sight of this manager: record top 15 positions as context (type "add")
        const top = Object.values(holdings).sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 15);
        for (const h of top) added += push13FTrade(label, h.issuer, "add", h.valueUsd, filedDate, url, nameToTicker, false);
      }
      store.state.snapshots13F[cik] = { accession: acc, holdings };
    } catch (e) {
      console.error("[13f]", label, e.message);
    }
  }
  store.state.lastPoll.fund13f = new Date().toISOString();
  return added;
}

function diff13F(label, prev, curr, filedDate, url, nameToTicker) {
  let added = 0;
  for (const k of Object.keys(curr)) {
    const c = curr[k], p = prev[k];
    if (!p) { added += push13FTrade(label, c.issuer, "new_stake", c.valueUsd, filedDate, url, nameToTicker, true); continue; }
    const chg = p.shares ? ((c.shares - p.shares) / p.shares) * 100 : 0;
    if (chg >= CONFIG.alerts.fundIncreasePct)
      added += push13FTrade(label, c.issuer, "add", Math.max(0, c.valueUsd - p.valueUsd), filedDate, url, nameToTicker, true);
    else if (chg <= -CONFIG.alerts.fundIncreasePct)
      added += push13FTrade(label, c.issuer, "trim", Math.max(0, p.valueUsd - c.valueUsd), filedDate, url, nameToTicker, false);
  }
  for (const k of Object.keys(prev)) {
    if (!curr[k]) added += push13FTrade(label, prev[k].issuer, "exit", prev[k].valueUsd, filedDate, url, nameToTicker, false);
  }
  return added;
}

function push13FTrade(label, issuer, type, estUsd, filedDate, url, nameToTicker, alert) {
  const cleaned = issuer.toUpperCase().replace(/[^A-Z0-9 ]/g, "");
  const ticker = nameToTicker[cleaned] ||
    nameToTicker[Object.keys(nameToTicker).find((n) => n.startsWith(cleaned.slice(0, 12))) || ""] || cleaned.slice(0, 8);
  const row = {
    id: hashId("13f", label, issuer, type, filedDate),
    source: "fund13f", ticker, company: titleCase(issuer),
    trader: label, traderRole: "13F manager",
    type, shares: null, price: null,
    estUsd: Math.round(estUsd), usdMin: null, usdMax: null,
    tradeDate: filedDate, filedDate, url
  };
  if (!store.addTrade(row)) return 0;
  if (alert && (type === "new_stake" || estUsd >= 50_000_000)) {
    store.addAlert({
      id: hashId("al-13f", row.id), ts: new Date().toISOString(),
      rule: "fund_conviction", severity: "medium", source: "fund13f",
      ticker, trader: label,
      message: `${label}: ${type === "new_stake" ? "NEW position" : "major add"} in ${row.company} (~$${fmtM(estUsd)})`,
      tradeIds: [row.id]
    });
  }
  return 1;
}

/* ------------------------------ Congress ------------------------------ */

export async function collectCongress() {
  let added = 0;
  const cutoff = daysAgoISO(CONFIG.backfillDays);

  const sets = [
    { url: CONFIG.congress.houseUrl, chamber: "House" },
    { url: CONFIG.congress.senateUrl, chamber: "Senate" }
  ];
  for (const s of sets) {
    try {
      const rows = await politeFetch(s.url, { json: true });
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const filedDate = toISO(r.disclosure_date);
        if (!filedDate || filedDate < cutoff) continue;
        const ticker = (r.ticker || "").toUpperCase().trim();
        if (!ticker || ticker === "--" || ticker === "N/A") continue;
        const who = r.representative || r.senator || "Unknown member";
        const range = parseAmountRange(r.amount);
        const rawType = (r.type || "").toLowerCase();
        const type = rawType.includes("purchase") ? "buy" : rawType.includes("sale") ? "sell" : rawType.includes("exchange") ? "exchange" : "other";
        const tradeDate = toISO(r.transaction_date) || filedDate;

        const row = {
          id: hashId("cg", who, ticker, tradeDate, rawType, r.amount || ""),
          source: "congress", ticker,
          company: (r.asset_description || "").replace(/<[^>]+>/g, "").slice(0, 80),
          trader: who, traderRole: s.chamber === "House" ? `Rep. ${r.district || ""}`.trim() : "Senator",
          type, shares: null, price: null,
          estUsd: range?.mid ?? null, usdMin: range?.min ?? null, usdMax: range?.max ?? null,
          tradeDate, filedDate,
          url: r.ptr_link || "https://efts.sec.gov/"
        };
        if (store.addTrade(row)) {
          added++;
          if (type === "buy" && (range?.mid ?? 0) >= CONFIG.alerts.congressBigUsd) {
            store.addAlert({
              id: hashId("al-cg", row.id), ts: new Date().toISOString(),
              rule: "congress_big_buy", severity: "medium", source: "congress",
              ticker, trader: who,
              message: `${who} disclosed ${ticker} buy, $${fmtM(range.min)}–$${fmtM(range.max)} (filed ${filedDate}, traded ${tradeDate})`,
              tradeIds: [row.id]
            });
          }
        }
      }
    } catch (e) {
      console.error("[congress]", s.chamber, e.message, "— dataset may be stale/unavailable; see README for alternatives");
    }
  }
  store.state.lastPoll.congress = new Date().toISOString();
  return added;
}

/* ------------------------------ Orchestrator ------------------------------ */

export async function pollAll({ force = false } = {}) {
  const t0 = Date.now();
  const counts = {};
  try { counts.form4 = await collectForm4(); } catch (e) { console.error("[poll] form4:", e.message); }
  try { counts.sc13d = await collect13D(); } catch (e) { console.error("[poll] 13d:", e.message); }
  try { counts.fund13f = await collect13F(); } catch (e) { console.error("[poll] 13f:", e.message); }
  store.state.cycle = (store.state.cycle || 0) + 1;
  if (force || store.state.cycle % CONFIG.congressPollEveryNthCycle === 1) {
    try { counts.congress = await collectCongress(); } catch (e) { console.error("[poll] congress:", e.message); }
  }
  store.saveState();
  console.log(`[ceres] poll done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, counts);
  return counts;
}

function fmtM(n) {
  if (n == null) return "?";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}
