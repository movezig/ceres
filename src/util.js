import crypto from "node:crypto";
import zlib from "node:zlib";
import { CONFIG } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastFetch = 0;

/** Polite fetch: rate-limited, UA header, retries; text (default), json, or buffer.
    Extra headers (e.g. Authorization) merge over the defaults; method/body for OAuth POSTs. */
export async function politeFetch(url, { json = false, buffer = false, retries = 2, headers = {}, method = "GET", body = undefined } = {}) {
  const wait = lastFetch + CONFIG.requestDelayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method, body,
        headers: { "User-Agent": CONFIG.userAgent, "Accept-Encoding": "gzip, deflate", ...headers },
        signal: AbortSignal.timeout(60_000)
      });
      if (res.status === 429 || res.status === 503) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return json ? res.json() : buffer ? Buffer.from(await res.arrayBuffer()) : res.text();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

export const hashId = (...parts) =>
  crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);

/* ---------------- SEC ticker map (shared by EDGAR + social collectors) ---------------- */

let tickerMap = null; // CIK -> { ticker, title }

export async function loadTickerMap() {
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

/** Set of every real US-listed ticker — validates cashtags scraped from social text. */
export async function knownTickerSet() {
  const map = await loadTickerMap();
  return new Set(Object.values(map).map((v) => (v.ticker || "").toUpperCase()).filter(Boolean));
}

/** MANDATORY publicly-traded filter: canonical SEC-listed ticker, or null.
    Ceres only tracks underlyings an individual retail investor can buy on-exchange —
    filings on private/non-traded vehicles (issuerTradingSymbol "NONE"/"N/A", interval
    funds, private placements) are dropped at ingest via this gate. Handles the
    BRK.B ↔ BRK-B punctuation mismatch between filings and company_tickers.json. */
export function listedTicker(sym, known) {
  const t = (sym || "").toUpperCase().trim();
  if (!t || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return null;
  if (known.has(t)) return t;
  const dash = t.replace(/\./g, "-");
  if (known.has(dash)) return dash;
  const dot = t.replace(/-/g, ".");
  if (known.has(dot)) return dot;
  return null;
}

/* ---------------- Minimal XML helpers (no deps, defensive) ---------------- */

/** First text content of <tag>...</tag> anywhere in xml (handles nested <value>). */
export function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const inner = m[1];
  const v = inner.match(/<value[^>]*>([\s\S]*?)<\/value>/i);
  return decodeEntities((v ? v[1] : inner).replace(/<[^>]+>/g, "").trim());
}

/** All blocks <tag>...</tag>. */
export function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'");
}

/* ---------------- Parsing helpers ---------------- */

/** "$1,001 - $15,000" -> {min, max, mid}; "$1,000,001 +" handled. */
export function parseAmountRange(s) {
  if (!s) return null;
  const nums = [...String(s).matchAll(/\$?([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  if (!nums.length) return null;
  const min = nums[0];
  const max = nums.length > 1 ? nums[1] : Math.round(min * 5); // open-ended top bucket
  return { min, max, mid: Math.round((min + max) / 2) };
}

export function toISO(d) {
  if (!d) return null;
  const s = String(d).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);          // MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export const daysAgoISO = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/** Normalize a person/entity name: "SMITH JOHN Q" -> "John Q Smith" best-effort. */
export function titleCase(name) {
  if (!name) return name;
  return name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
}

/* ---------------- ZIP (House Clerk publishes PTR indexes as .zip) ---------------- */

/** Extract the first entry matching namePattern from a ZIP buffer (deflate/store only). */
export function zipExtract(buf, namePattern) {
  let eocd = -1; // End Of Central Directory: search backwards through max comment length
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: end-of-central-directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip: corrupt central directory");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (namePattern.test(name)) {
      // local header repeats name/extra with its own lengths — skip via those
      const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/* ---------------- ticker extraction from social text ---------------- */

// Uppercase words that read as tickers but are almost always noise in finance talk.
// Real tickers colliding with these (e.g. NOW, ALL, IT) are still caught via $cashtags.
const TICKER_STOP = new Set(("A,I,AI,ALL,AN,ARE,AT,ATH,BE,BUY,BY,CALL,CALLS,CEO,CFO,CPI,DD,DOW,EDIT,EOD,EPS,ETF,EV,FD,FDA," +
  "FED,FOR,FYI,GDP,GO,HOLD,HUGE,IMO,IPO,IRS,IT,ITM,LOL,MOON,NEW,NEWS,NEXT,NOW,ON,ONE,OPEN,OR,OTM,PE,PT,PUT,PUTS," +
  "REAL,RH,RSI,SEC,SELL,SO,TA,TLDR,USA,USD,WSB,WTF,YOLO,YTD").split(","));

/** Count ticker mentions in free text → Map(ticker -> count).
    $Cashtags need only exist in `known` (set of real tickers); bare uppercase
    words additionally must clear the stoplist. Pass bareWords:false for noisy text. */
export function extractTickers(text, known, { bareWords = true } = {}) {
  const counts = new Map();
  const bump = (t) => counts.set(t, (counts.get(t) || 0) + 1);
  for (const m of String(text).matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    const t = m[1].toUpperCase();
    if (known.has(t)) bump(t);
  }
  if (bareWords) {
    for (const m of String(text).matchAll(/\b([A-Z]{2,5})\b/g)) {
      const t = m[1];
      if (known.has(t) && !TICKER_STOP.has(t)) bump(t);
    }
  }
  return counts;
}
