import crypto from "node:crypto";
import { CONFIG } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastFetch = 0;

/** Polite fetch: rate-limited, UA header, retries, text or json. */
export async function politeFetch(url, { json = false, retries = 2 } = {}) {
  const wait = lastFetch + CONFIG.requestDelayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": CONFIG.userAgent, "Accept-Encoding": "gzip, deflate" },
        signal: AbortSignal.timeout(60_000)
      });
      if (res.status === 429 || res.status === 503) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return json ? res.json() : res.text();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

export const hashId = (...parts) =>
  crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);

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
