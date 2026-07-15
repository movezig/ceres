// Ceres configuration
import "./env.js"; // loads <repo>/.env into process.env (never committed — see .env.example)

const list = (v, fallback = "") => (v ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

export const CONFIG = {
  // SEC requires a descriptive User-Agent with contact info — set CERES_CONTACT to your email.
  userAgent: `Ceres/1.0 research dashboard (${process.env.CERES_CONTACT || "CERES_CONTACT not set"})`,

  pollIntervalMs: 60 * 60 * 1000,        // hourly
  congressPollEveryNthCycle: 6,          // congress datasets are large + update slowly: every 6h
  regShoPollEveryNthCycle: 6,            // FINRA publishes once per trading day
  xPollEveryNthCycle: 3,                 // X API reads are metered — stretch your monthly quota
  requestDelayMs: 150,                   // stay well under SEC's 10 req/s limit
  form4MaxFilingsPerPoll: 80,            // politeness cap
  form144MaxFilingsPerPoll: 40,          // politeness cap
  backfillDays: 120,                     // ignore congress rows disclosed earlier than this on first run

  // Alert thresholds
  alerts: {
    insiderBigBuyUsd: 250_000,           // single open-market insider buy
    insiderClusterCount: 3,              // distinct insiders buying same ticker...
    insiderClusterWindowDays: 14,        // ...within this window
    congressBigUsd: 100_000,             // range midpoint
    fundIncreasePct: 50,                 // 13F position increase to count as conviction add
    form144BigUsd: 1_000_000,            // single Form 144 proposed insider sale
    congressStaleDays: 10,               // House Clerk PTRs newer than S3 data by this → stale alert
    shortVolPct: 60,                     // Reg SHO short volume % that flags squeeze conditions
    attentionSpikeRatio: 2.5,            // social mentions vs previous reading
    attentionMinMentions: { reddit: 20, apewisdom: 75, bluesky: 10, stocktwits: 0, x: 1, telegram: 1 },
    confluenceWindowDays: 14             // smart-money buys within this window of a social spike
  },

  // Low-turnover / high-signal managers tracked for 13F cloning (CIK -> label)
  managers: {
    "0001067983": "Berkshire Hathaway (Buffett)",
    "0001336528": "Pershing Square (Ackman)",
    "0001656456": "Duquesne Family Office (Druckenmiller)",
    "0001006438": "Appaloosa (Tepper)",
    "0001649339": "Scion Asset Management (Burry)",
    "0001061768": "Baupost Group (Klarman)",
    "0001709323": "Himalaya Capital (Li Lu)",
    "0000921669": "Icahn Enterprises",
    "0001418814": "ValueAct",
    "0000915191": "Starboard Value",
    "0001048445": "Elliott Investment Management",
    "0001040273": "Third Point (Loeb)"
  },

  // Disclosure sources → trade rows (tier gauges on the dashboard)
  sources: {
    form4:    { tier: 1, label: "Insiders (Form 4)" },
    form144:  { tier: 2, label: "Sale notices (Form 144)" },
    sc13d:    { tier: 3, label: "Activists (13D)" },
    sc13g:    { tier: 4, label: "Passive whales (13G)" },
    fund13f:  { tier: 5, label: "Superinvestors (13F)" },
    congress: { tier: 6, label: "Congress" }
  },

  // Signal sources → per-ticker time series (attention / sentiment / short volume),
  // not trades. `needs` lists env vars required before the collector activates.
  signalSources: {
    stocktwits: { label: "Stocktwits",        needs: [] },
    apewisdom:  { label: "Reddit (Apewisdom)",needs: [] },
    reddit:     { label: "Reddit (direct)",   needs: ["CERES_REDDIT_CLIENT_ID", "CERES_REDDIT_CLIENT_SECRET"] },
    telegram:   { label: "Telegram pumps",    needs: ["CERES_TG_CHANNELS"] },
    x:          { label: "X tracked accounts",needs: ["CERES_X_BEARER", "CERES_X_HANDLES"] },
    bluesky:    { label: "Bluesky",           needs: ["CERES_BSKY_HANDLE", "CERES_BSKY_APP_PASSWORD"] },
    regsho:     { label: "Short volume (FINRA)", needs: [] },
    houseclerk: { label: "House Clerk PTRs",  needs: [] }
  },

  // Secrets — set these in <repo>/.env (gitignored) or as CI repo secrets. Never commit values.
  creds: {
    xBearer:         process.env.CERES_X_BEARER || "",
    redditId:        process.env.CERES_REDDIT_CLIENT_ID || "",
    redditSecret:    process.env.CERES_REDDIT_CLIENT_SECRET || "",
    bskyHandle:      process.env.CERES_BSKY_HANDLE || "",
    bskyAppPassword: process.env.CERES_BSKY_APP_PASSWORD || ""
  },

  social: {
    subreddits: list(process.env.CERES_SUBREDDITS, "wallstreetbets,stocks,options"),
    telegramChannels: list(process.env.CERES_TG_CHANNELS),   // public channels to watch for pumps
    xHandles: list(process.env.CERES_X_HANDLES),             // curated high-signal accounts
    maxTweetsPerHandle: 5,
    sentimentTopTickers: 10,   // stocktwits bull/bear streams for the N most active tickers
    trendingCap: 30            // stocktwits trending symbols to record per poll
  },

  edgar: {
    form4Atom:   "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=100&output=atom",
    form144Atom: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=144&company=&dateb=&owner=include&count=80&output=atom",
    sc13dAtom:   "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13D&company=&dateb=&owner=include&count=40&output=atom",
    sc13gAtom:   "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13G&company=&dateb=&owner=include&count=40&output=atom",
    tickersUrl:  "https://www.sec.gov/files/company_tickers.json",
    submissions: (cik) => `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`,
    archiveDir:  (cik, accNoDash) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDash}`
  },

  congress: {
    houseUrl:  "https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json",
    senateUrl: "https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json",
    clerkZip:  (year) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`,
    clerkPdf:  (year, docId) => `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`
  },

  finra: {
    // Consolidated NMS short-sale volume, one pipe-delimited file per trading day.
    regShoDaily: (yyyymmdd) => `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`
  },

  socialUrls: {
    stocktwitsTrending: "https://api.stocktwits.com/api/2/trending/symbols.json",
    stocktwitsStream: (t) => `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(t)}.json`,
    apewisdom: "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
    redditToken: "https://www.reddit.com/api/v1/access_token",
    redditHot: (sub) => `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/hot?limit=100&raw_json=1`,
    telegram: (ch) => `https://t.me/s/${encodeURIComponent(ch)}`,
    xUsersBy: (handles) => `https://api.x.com/2/users/by?usernames=${encodeURIComponent(handles.join(","))}`,
    xUserTweets: (id, n) => `https://api.x.com/2/users/${id}/tweets?max_results=${Math.max(5, n)}&exclude=retweets,replies&tweet.fields=created_at`,
    bskySession: "https://bsky.social/xrpc/com.atproto.server.createSession",
    bskySearch: (q, limit) => `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=${limit}&sort=latest`
  },

  // Admin auth for mutating endpoints (POST /api/poll, /api/purge-demo).
  // Only a SHA-256 hash is ever stored — see .env.example for how to generate a token.
  // Localhost is exempt unless CERES_REQUIRE_AUTH=1 (set that behind a reverse proxy,
  // where every request's socket looks local).
  adminTokenHash: (process.env.CERES_ADMIN_TOKEN_HASH || "").trim().toLowerCase(),
  requireAuth: process.env.CERES_REQUIRE_AUTH === "1",

  port: Number(process.env.PORT || 8321),
  dataDir: new URL("../data/", import.meta.url).pathname
};

/** True when every env var a signal source needs is present. */
export function sourceConfigured(key) {
  return (CONFIG.signalSources[key]?.needs || []).every((v) => (process.env[v] || "").length > 0);
}
