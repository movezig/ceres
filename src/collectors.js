// Ceres data collectors — disclosures: Form 4 + Form 144 (insiders), SC 13D/13G
// (activist/passive stakes), 13F (funds), Congress (community dataset + House Clerk
// official cross-check); market structure: FINRA Reg SHO short volume.
// Social/attention collectors live in social.js; pollAll orchestrates everything.
import { CONFIG } from "./config.js";
import { store } from "./store.js";
import {
  politeFetch, hashId, xmlText, xmlBlocks, decodeEntities, zipExtract,
  parseAmountRange, toISO, daysAgoISO, titleCase, loadTickerMap, knownTickerSet, listedTicker
} from "./util.js";
import {
  collectStocktwits, collectApewisdom, collectReddit,
  collectTelegram, collectX, collectBluesky
} from "./social.js";

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
  const known = await knownTickerSet();
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
      added += ingestForm4Xml(xml, e, known);
    } catch (err) {
      console.error("[form4]", e.accession, err.message);
    }
  }
  store.state.lastPoll.form4 = new Date().toISOString();
  return added;
}

function ingestForm4Xml(xml, entry, known) {
  // publicly-traded gate: private issuers file Form 4s with symbol "NONE"/"N/A" — skip them
  const ticker = listedTicker(xmlText(xml, "issuerTradingSymbol"), known);
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

/* ------------------------------ Form 144 (proposed insider sales) ------------------------------ */
// Filed when an insider *intends* to sell restricted stock — a leading indicator,
// unlike the after-the-fact Form 4. Same getcurrent Atom + primary_doc.xml pattern.

export async function collect144() {
  const map = await loadTickerMap();
  const atom = await politeFetch(CONFIG.edgar.form144Atom);
  // (Reporting) + (Subject) entries share one accession — first occurrence wins
  const entries = parseAtomEntries(atom)
    .filter((e, i, arr) => e.accession && arr.findIndex((x) => x.accession === e.accession) === i)
    .filter((e) => !store.seenAcc.has("f144:" + e.accession))
    .slice(0, CONFIG.form144MaxFilingsPerPoll);

  let added = 0;
  for (const e of entries) {
    store.seenAcc.add("f144:" + e.accession);
    try {
      const files = await filingFileList(e.cik, e.accNoDash);
      const xmlFile = files.find((f) => /primary_doc.*\.xml$/i.test(f)) ||
                      files.find((f) => /\.xml$/i.test(f) && !/index/i.test(f));
      if (!xmlFile) continue;
      const xml = await politeFetch(`${CONFIG.edgar.archiveDir(e.cik, e.accNoDash)}/${xmlFile}`);
      added += ingest144Xml(xml, e, map);
    } catch (err) {
      console.error("[form144]", e.accession, err.message);
    }
  }
  store.state.lastPoll.form144 = new Date().toISOString();
  return added;
}

function ingest144Xml(xml, entry, map) {
  const issuerCik = xmlText(xml, "issuerCik");
  const info = issuerCik ? map[Number(issuerCik)] : null;
  // publicly-traded gate: no listed ticker for the issuer → retail can't act on it, skip
  const ticker = info?.ticker;
  const company = xmlText(xml, "issuerName") || info?.title;
  const seller = titleCase(xmlText(xml, "nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold"));
  const role = xmlText(xml, "relationshipToIssuer") || "Insider";
  const shares = Number(xmlText(xml, "noOfUnitsSold")) || 0;
  const value = Math.round(Number(xmlText(xml, "aggregateMarketValue")) || 0);
  const tradeDate = toISO(xmlText(xml, "approxSaleDate")) || toISO(entry.updated);
  if (!ticker || !seller || !value) return 0;

  const row = {
    id: hashId("144", entry.accession),
    source: "form144", ticker, company, trader: seller, traderRole: role,
    type: "sell", shares,
    price: shares ? +(value / shares).toFixed(2) : null,
    estUsd: value, usdMin: value, usdMax: value,
    tradeDate, filedDate: toISO(entry.updated) || tradeDate,
    url: entry.link
  };
  if (!store.addTrade(row)) return 0;
  if (value >= CONFIG.alerts.form144BigUsd) {
    store.addAlert({
      id: hashId("al-144", row.id), ts: new Date().toISOString(),
      rule: "form144_big_sale", severity: "medium", source: "form144",
      ticker, trader: seller,
      message: `${seller} (${role}) filed notice to sell ~$${fmtM(value)} of ${ticker} around ${tradeDate}`,
      tradeIds: [row.id]
    });
  }
  return 1;
}

/* ------------------------------ SC 13D / SC 13G ------------------------------ */
// Same Atom shape for both: 13D = activist stake >5%, 13G = passive stake >5%.
// A 13D landing on a ticker that already has a 13G row = a filer turning activist.

const SCHEDULES = {
  sc13d: {
    atom: () => CONFIG.edgar.sc13dAtom, prefix: "13d",
    titleRe: /SC 13D(?:\/A)?\s*-\s*(.+?)\s*\(\d{10}\)/i,
    placeholder: "Activist filer (see filing)", role: "13D filer",
    rule: "activist_13d", severity: "high",
    describe: (co, tk) => `New 13D filed on ${co} (${tk}) — activist stake >5%`
  },
  sc13g: {
    atom: () => CONFIG.edgar.sc13gAtom, prefix: "13g",
    titleRe: /SC 13G(?:\/A)?\s*-\s*(.+?)\s*\(\d{10}\)/i,
    placeholder: "Passive filer (see filing)", role: "13G filer",
    rule: "passive_stake_13g", severity: "medium",
    describe: (co, tk) => `New 13G filed on ${co} (${tk}) — passive stake >5%`
  }
};

async function collectSchedule(source) {
  const S = SCHEDULES[source];
  const map = await loadTickerMap();
  const atom = await politeFetch(S.atom());
  const entries = parseAtomEntries(atom);
  let added = 0;

  for (const e of entries) {
    if (!e.accession) continue;
    const key = S.prefix + ":" + e.accession;
    // title looks like: "SC 13D - COMPANY NAME (0001234567) (Subject)"
    const isSubject = /\(Subject\)/i.test(e.title);
    const nameM = e.title.match(S.titleRe);
    const name = nameM ? decodeEntities(nameM[1]) : null;

    if (isSubject) {
      if (store.seenAcc.has(key)) continue;
      store.seenAcc.add(key);
      const info = e.cik ? map[Number(e.cik)] : null;
      // publicly-traded gate: subject has no listed ticker (private target/fund) → skip entirely
      if (!info?.ticker) continue;
      const row = {
        id: hashId(S.prefix, e.accession),
        source,
        ticker: info.ticker,
        company: name || info?.title || "Unknown subject",
        trader: S.placeholder, traderRole: S.role,
        type: "new_stake", shares: null, price: null,
        estUsd: null, usdMin: null, usdMax: null,
        tradeDate: toISO(e.updated), filedDate: toISO(e.updated),
        url: e.link
      };
      if (store.addTrade(row)) {
        added++;
        store.addAlert({
          id: hashId("al-" + S.prefix, e.accession), ts: new Date().toISOString(),
          rule: S.rule, severity: S.severity, source,
          ticker: row.ticker, trader: row.trader,
          message: S.describe(row.company, row.ticker),
          tradeIds: [row.id]
        });
        if (source === "sc13d" &&
            store.trades.some((t) => t.source === "sc13g" && t.ticker === row.ticker && t.id !== row.id)) {
          store.addAlert({
            id: hashId("al-conv", e.accession), ts: new Date().toISOString(),
            rule: "activist_conversion", severity: "critical", source: "sc13d",
            ticker: row.ticker, trader: row.trader,
            message: `13G→13D on ${row.ticker}: a previously passive >5% holder is turning activist`,
            tradeIds: [row.id]
          });
        }
      }
    } else if (name) {
      // filed-by entry for same accession: backfill the filer's name
      const t = store.trades.find((t) => t.source === source && t.url === e.link);
      if (t && t.trader === S.placeholder) t.trader = titleCase(name);
    }
  }
  store.state.lastPoll[source] = new Date().toISOString();
  return added;
}

export const collect13D = () => collectSchedule("sc13d");
export const collect13G = () => collectSchedule("sc13g");

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
  const known = await knownTickerSet();
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
        // publicly-traded gate: PTRs cover bonds/PE/crypto/etc — keep listed equities only
        const ticker = listedTicker(r.ticker, known);
        if (!ticker) continue;
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

/* ------------------------------ House Clerk (official PTR index) ------------------------------ */
// The Clerk's {year}FD.zip lists every House financial disclosure filing. Trade detail
// lives in PDFs (not parseable zero-dep), but the filing index gives us two things the
// community S3 dataset can't: an authoritative freshness check for the congress tier,
// and a per-filing signal linking straight to the official PTR PDF.

export async function collectHouseClerk() {
  const year = new Date().getFullYear();
  const zip = await politeFetch(CONFIG.congress.clerkZip(year), { buffer: true });
  const xml = zipExtract(zip, /\.xml$/i)?.toString("utf8");
  if (!xml) throw new Error("no XML index inside " + year + "FD.zip");

  const cutoff = daysAgoISO(CONFIG.backfillDays);
  let added = 0, newestPtr = "";
  for (const m of xmlBlocks(xml, "Member")) {
    if ((xmlText(m, "FilingType") || "").toUpperCase() !== "P") continue; // PTRs only
    const docId = xmlText(m, "DocID");
    const filed = toISO(xmlText(m, "FilingDate"));
    if (!docId || !filed) continue;
    if (filed > newestPtr) newestPtr = filed;
    if (filed < cutoff) continue;
    const who = titleCase(`${xmlText(m, "First") || ""} ${xmlText(m, "Last") || ""}`);
    if (store.addSignal({
      id: hashId("hc", docId), ts: new Date().toISOString(), date: filed,
      source: "houseclerk", ticker: null, kind: "ptr_filed", value: 1,
      meta: { member: who, district: xmlText(m, "StateDst"), url: CONFIG.congress.clerkPdf(year, docId) }
    })) added++;
  }

  // Freshness cross-check: if the Clerk shows PTRs well ahead of the newest S3 row
  // (or the S3 dataset has produced nothing at all), the congress tier is stale.
  const newestS3 = store.trades.find((t) => t.source === "congress" && !t.demo)?.filedDate;
  if (newestPtr) {
    const gapDays = newestS3 ? Math.round((Date.parse(newestPtr) - Date.parse(newestS3)) / 864e5) : Infinity;
    if (gapDays > CONFIG.alerts.congressStaleDays) {
      store.addAlert({
        id: hashId("al-cgstale", newestPtr.slice(0, 7)), ts: new Date().toISOString(),
        rule: "congress_dataset_stale", severity: "medium", source: "congress",
        ticker: null, trader: "House Clerk",
        message: newestS3
          ? `Congress tier is ${gapDays}d behind: official House PTRs run to ${newestPtr}, community dataset stops at ${newestS3}`
          : `Congress tier is running blind: official House PTRs run to ${newestPtr} but the community dataset has produced no trades — see README for paid alternatives`,
        tradeIds: []
      });
    }
  }
  store.state.lastPoll.houseclerk = new Date().toISOString();
  return added;
}

/* ------------------------------ FINRA Reg SHO (daily short volume) ------------------------------ */
// One pipe-delimited file per trading day: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market.
// Recorded only for tickers already showing smart-money flow — it's an enrichment layer:
// heavy shorting against fresh insider/fund buying is the classic squeeze/conviction setup.

export async function collectRegSHO() {
  const interest = new Set(store.tickersOfInterest(30, 300));
  if (!interest.size) return 0;

  // walk back from today to the most recent file we haven't ingested (weekends/holidays skip days)
  let text = null, date = null;
  const last = store.state.lastRegSho || "";
  for (let back = 0; back <= 5 && !text; back++) {
    const d = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
    if (d <= last) return 0; // nothing newer published yet
    try {
      text = await politeFetch(CONFIG.finra.regShoDaily(d.replace(/-/g, "")), { retries: 0 });
      date = d;
    } catch { /* not a trading day or not published yet — try the day before */ }
  }
  if (!text) return 0;

  let added = 0;
  for (const line of text.split("\n").slice(1)) {
    const [, sym, shortVol, , totalVol] = line.split("|");
    if (!sym || !interest.has(sym)) continue;
    const sv = Number(shortVol), tv = Number(totalVol);
    if (!tv) continue;
    const pct = +(100 * sv / tv).toFixed(1);
    if (!store.addSignal({
      id: hashId("regsho", sym, date), ts: new Date().toISOString(), date,
      source: "regsho", ticker: sym, kind: "short_vol", value: pct,
      meta: { shortVol: sv, totalVol: tv }
    })) continue;
    added++;
    if (pct >= CONFIG.alerts.shortVolPct) {
      const buyers = store.smartBuyersOf(sym, CONFIG.alerts.confluenceWindowDays);
      if (buyers.length) {
        store.addAlert({
          id: hashId("al-squeeze", sym, date), ts: new Date().toISOString(),
          rule: "short_squeeze_setup", severity: "medium", source: "regsho",
          ticker: sym, trader: buyers.slice(0, 3).join(", "),
          message: `${sym}: ${pct}% of ${date} volume was short-sold while ${buyers.length} smart-money buyer${buyers.length > 1 ? "s" : ""} bought within ${CONFIG.alerts.confluenceWindowDays}d`,
          tradeIds: []
        });
      }
    }
  }
  store.state.lastRegSho = date;
  store.state.lastPoll.regsho = new Date().toISOString();
  return added;
}

/* ------------------------------ Orchestrator ------------------------------ */

export async function pollAll({ force = false } = {}) {
  const t0 = Date.now();
  const counts = {};
  const run = async (key, fn) => {
    try {
      const n = await fn();
      if (n != null) counts[key] = n; // null = collector dormant (credentials not configured)
    } catch (e) { console.error(`[poll] ${key}:`, e.message); }
  };
  store.state.cycle = (store.state.cycle || 0) + 1;
  const due = (n) => force || store.state.cycle % n === 1;

  // publicly-traded mandate: sweep out anything that slipped in without a listed ticker
  // (also self-heals data collected before this filter existed, and after delistings)
  try {
    const known = await knownTickerSet();
    if (known.size) {
      const dropped = store.pruneInvalid((t) => listedTicker(t, known));
      if (dropped) console.log(`[ceres] pruned ${dropped} rows on non-listed underlyings`);
    }
  } catch (e) { console.error("[poll] prune:", e.message); }

  // disclosure tiers
  await run("form4", collectForm4);
  await run("form144", collect144);
  await run("sc13d", collect13D);
  await run("sc13g", collect13G);
  await run("fund13f", collect13F);
  if (due(CONFIG.congressPollEveryNthCycle)) {
    await run("congress", collectCongress);
    await run("houseclerk", collectHouseClerk);
  }

  // market structure
  if (due(CONFIG.regShoPollEveryNthCycle)) await run("regsho", collectRegSHO);

  // social attention (credentialed sources skip themselves when unconfigured)
  await run("stocktwits", collectStocktwits);
  await run("apewisdom", collectApewisdom);
  await run("reddit", collectReddit);
  await run("telegram", collectTelegram);
  if (due(CONFIG.xPollEveryNthCycle)) await run("x", collectX);
  await run("bluesky", collectBluesky);

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
