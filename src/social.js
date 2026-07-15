// Ceres social/attention collectors: Stocktwits, Apewisdom (pre-aggregated Reddit),
// Reddit (direct, OAuth), Telegram pump channels, X tracked accounts, Bluesky.
// These record per-ticker attention/sentiment SIGNALS (see store.js), not trades:
// crowd attention is what smart money's disclosures should *precede*, so the alerts
// here fire on spikes — and escalate when a spike lands on a ticker smart money
// already bought (social_confluence: "smart money got in before the crowd").
// Credentialed collectors return null (dormant) when their env vars are unset.
import { CONFIG, sourceConfigured } from "./config.js";
import { store } from "./store.js";
import { politeFetch, hashId, extractTickers, knownTickerSet, listedTicker, decodeEntities } from "./util.js";

const today = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const label = (src) => CONFIG.signalSources[src].label;

/* ---------------- shared alerting ---------------- */

/** Attention spike on `ticker` from `source` (≤1 alert per source/ticker/day),
    escalated to social_confluence when smart money bought first. */
function spikeAlerts(source, ticker, message) {
  const date = today();
  store.addAlert({
    id: hashId("al-att", source, ticker, date), ts: nowISO(),
    rule: "attention_spike", severity: "medium", source,
    ticker, trader: label(source), message, tradeIds: []
  });
  const buyers = store.smartBuyersOf(ticker, CONFIG.alerts.confluenceWindowDays);
  if (buyers.length) {
    const who = buyers.slice(0, 3).join(", ") + (buyers.length > 3 ? ", …" : "");
    store.addAlert({
      id: hashId("al-conf", source, ticker, date), ts: nowISO(),
      rule: "social_confluence", severity: "high", source,
      ticker, trader: who,
      message: `${ticker}: crowd attention rising on ${label(source)} AFTER ${buyers.length} smart-money buyer${buyers.length > 1 ? "s" : ""} (${who}) within ${CONFIG.alerts.confluenceWindowDays}d`,
      tradeIds: []
    });
  }
}

/** value/prev ≥ spike ratio and value clears the per-source floor. */
const isSpike = (source, value, prev) =>
  prev != null && value >= (CONFIG.alerts.attentionMinMentions[source] ?? 0) &&
  value / Math.max(1, prev) >= CONFIG.alerts.attentionSpikeRatio;

/* ---------------- Stocktwits (no key) ---------------- */

export async function collectStocktwits() {
  const known = await knownTickerSet();
  const j = await politeFetch(CONFIG.socialUrls.stocktwitsTrending, { json: true });
  const symbols = (j?.symbols || []).slice(0, CONFIG.social.trendingCap);
  const hadPrior = store.signals.some((s) => s.source === "stocktwits"); // first poll: record, don't alert
  const date = today();
  let added = 0;

  symbols.forEach((s, i) => {
    // publicly-traded gate: trending includes crypto/futures (BTC.X etc) — listed equities only
    const ticker = listedTicker(s.symbol, known);
    if (!ticker) return;
    const rank = i + 1;
    const wasTrending = !!store.prevSignal("stocktwits", ticker, "attention", date);
    if (!store.addSignal({
      id: hashId("stocktwits", ticker, date), ts: nowISO(), date,
      source: "stocktwits", ticker, kind: "attention", value: s.watchlist_count || 0,
      meta: { rank, sector: s.sector || null }
    })) return;
    added++;
    if (hadPrior && !wasTrending && rank <= 15)
      spikeAlerts("stocktwits", ticker, `${ticker} entered Stocktwits trending at #${rank} (${(s.watchlist_count || 0).toLocaleString()} watchers)`);
  });

  // bull/bear sentiment streams for the tickers smart money is actually trading
  for (const t of store.tickersOfInterest(7, CONFIG.social.sentimentTopTickers)) {
    try {
      const sj = await politeFetch(CONFIG.socialUrls.stocktwitsStream(t), { json: true, retries: 0 });
      let bull = 0, bear = 0;
      for (const m of sj?.messages || []) {
        const s = m?.entities?.sentiment?.basic;
        if (s === "Bullish") bull++; else if (s === "Bearish") bear++;
      }
      if (bull + bear >= 5 && store.addSignal({
        id: hashId("stocktwits-sent", t, date), ts: nowISO(), date,
        source: "stocktwits", ticker: t, kind: "sentiment",
        value: Math.round(100 * bull / (bull + bear)), meta: { bull, bear }
      })) added++;
    } catch { /* unlisted/renamed symbol — skip */ }
  }
  store.state.lastPoll.stocktwits = nowISO();
  return added;
}

/* ---------------- Apewisdom — pre-aggregated Reddit mentions (no key) ---------------- */

export async function collectApewisdom() {
  const j = await politeFetch(CONFIG.socialUrls.apewisdom, { json: true });
  const known = await knownTickerSet();
  const date = today();
  let added = 0;
  for (const r of (j?.results || []).slice(0, 50)) {
    const ticker = (r.ticker || "").toUpperCase();
    if (!known.has(ticker)) continue;
    const mentions = Number(r.mentions) || 0;
    const prev = Number(r.mentions_24h_ago) || 0;
    if (!store.addSignal({
      id: hashId("apewisdom", ticker, date), ts: nowISO(), date,
      source: "apewisdom", ticker, kind: "attention", value: mentions,
      meta: { rank: Number(r.rank) || null, upvotes: Number(r.upvotes) || 0, prev24h: prev }
    })) continue;
    added++;
    if (isSpike("apewisdom", mentions, prev))
      spikeAlerts("apewisdom", ticker, `${ticker} Reddit mentions ${prev} → ${mentions} in 24h (rank #${r.rank})`);
  }
  store.state.lastPoll.apewisdom = nowISO();
  return added;
}

/* ---------------- Reddit direct (free OAuth script app) ---------------- */

export async function collectReddit() {
  if (!sourceConfigured("reddit")) return null;
  const tok = await politeFetch(CONFIG.socialUrls.redditToken, {
    json: true, method: "POST", body: "grant_type=client_credentials",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CONFIG.creds.redditId}:${CONFIG.creds.redditSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  if (!tok?.access_token) throw new Error("OAuth token request failed");
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const known = await knownTickerSet();
  const counts = new Map();
  for (const sub of CONFIG.social.subreddits) {
    const j = await politeFetch(CONFIG.socialUrls.redditHot(sub), { json: true, headers: auth });
    for (const c of j?.data?.children || []) {
      const d = c.data || {};
      const text = `${d.title || ""} ${d.link_flair_text || ""} ${(d.selftext || "").slice(0, 2000)}`;
      for (const [t, n] of extractTickers(text, known)) counts.set(t, (counts.get(t) || 0) + n);
    }
  }

  const prevMap = store.state.socialPrev.reddit || {};
  const date = today();
  let added = 0;
  for (const [ticker, mentions] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    if (!store.addSignal({
      id: hashId("reddit", ticker, date), ts: nowISO(), date,
      source: "reddit", ticker, kind: "attention", value: mentions,
      meta: { subs: CONFIG.social.subreddits.join("+") }
    })) continue;
    added++;
    if (isSpike("reddit", mentions, prevMap[ticker]))
      spikeAlerts("reddit", ticker, `${ticker} mentions across r/${CONFIG.social.subreddits.join(", r/")}: ${prevMap[ticker]} → ${mentions}`);
  }
  store.state.socialPrev.reddit = Object.fromEntries(counts);
  store.state.lastPoll.reddit = nowISO();
  return added;
}

/* ---------------- Telegram public channels — pump watch (no key) ---------------- */
// Contra signal: a cashtag in a monitored pump channel is a manipulation warning,
// not a buy signal. Only $cashtags count — pump posts are too shouty for bare words.

export async function collectTelegram() {
  if (!CONFIG.social.telegramChannels.length) return null;
  const known = await knownTickerSet();
  const date = today();
  let added = 0;

  for (const ch of CONFIG.social.telegramChannels) {
    const html = await politeFetch(CONFIG.socialUrls.telegram(ch));
    for (const block of html.split('data-post="').slice(1)) {
      const post = block.slice(0, block.indexOf('"'));
      const key = "tg:" + post;
      if (!post.includes("/") || store.seenAcc.has(key)) continue;
      store.seenAcc.add(key);
      const textM = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
      if (!textM) continue;
      const text = decodeEntities(textM[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      const tsM = block.match(/<time[^>]*datetime="([^"]+)"/);
      const fresh = tsM && Date.now() - Date.parse(tsM[1]) < 864e5; // backfill silently, alert on new
      for (const [ticker] of extractTickers(text, known, { bareWords: false })) {
        if (store.addSignal({
          id: hashId("telegram", ch, ticker, post), ts: nowISO(), date,
          source: "telegram", ticker, kind: "pump_mention", value: 1,
          meta: { channel: ch, post, snippet: text.slice(0, 140) }
        })) added++;
        if (fresh) {
          store.addAlert({
            id: hashId("al-pump", ch, ticker, date), ts: nowISO(),
            rule: "pump_watch", severity: "high", source: "telegram",
            ticker, trader: `t.me/${ch}`,
            message: `⚠ ${ticker} pushed in Telegram channel “${ch}” — treat ${ticker} flow as pump risk, not a buy signal`,
            tradeIds: []
          });
        }
      }
    }
  }
  store.state.lastPoll.telegram = nowISO();
  return added;
}

/* ---------------- X tracked accounts (paid API bearer token) ---------------- */

export async function collectX() {
  if (!sourceConfigured("x")) return null;
  const auth = { Authorization: `Bearer ${CONFIG.creds.xBearer}` };

  // resolve handles → user ids once; cached in state.json
  const users = store.state.xUsers || {};
  const missing = CONFIG.social.xHandles.filter((h) => !users[h.toLowerCase()]);
  if (missing.length) {
    const j = await politeFetch(CONFIG.socialUrls.xUsersBy(missing), { json: true, headers: auth });
    for (const u of j?.data || []) users[u.username.toLowerCase()] = u.id;
    store.state.xUsers = users;
  }

  const known = await knownTickerSet();
  const date = today();
  let added = 0;
  for (const handle of CONFIG.social.xHandles) {
    const id = users[handle.toLowerCase()];
    if (!id) continue;
    const j = await politeFetch(CONFIG.socialUrls.xUserTweets(id, CONFIG.social.maxTweetsPerHandle), { json: true, headers: auth });
    for (const tw of j?.data || []) {
      const key = "x:" + tw.id;
      if (store.seenAcc.has(key)) continue;
      store.seenAcc.add(key);
      const fresh = tw.created_at && Date.now() - Date.parse(tw.created_at) < 864e5;
      const snippet = (tw.text || "").replace(/\s+/g, " ").slice(0, 140);
      for (const [ticker] of extractTickers(tw.text || "", known, { bareWords: false })) {
        if (store.addSignal({
          id: hashId("x", handle, ticker, date), ts: nowISO(), date,
          source: "x", ticker, kind: "attention", value: 1,
          meta: { handle, snippet, url: `https://x.com/${handle}/status/${tw.id}` }
        })) added++;
        if (fresh) spikeAlerts("x", ticker, `@${handle} posted about $${ticker}: “${snippet}”`);
      }
    }
  }
  store.state.lastPoll.x = nowISO();
  return added;
}

/* ---------------- Bluesky (free account + app password) ---------------- */
// Public AppView search has been blocking datacenter clients, so authenticate
// against bsky.social — the reliable path — and search cashtags for the tickers
// smart money is currently trading.

export async function collectBluesky() {
  if (!sourceConfigured("bluesky")) return null;
  const sess = await politeFetch(CONFIG.socialUrls.bskySession, {
    json: true, method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: CONFIG.creds.bskyHandle, password: CONFIG.creds.bskyAppPassword })
  });
  if (!sess?.accessJwt) throw new Error("createSession failed — check handle/app password");
  const auth = { Authorization: `Bearer ${sess.accessJwt}` };

  const prevMap = store.state.socialPrev.bluesky || {};
  const next = {};
  const date = today();
  let added = 0;
  for (const ticker of store.tickersOfInterest(7, CONFIG.social.sentimentTopTickers)) {
    let posts = [];
    try {
      const j = await politeFetch(CONFIG.socialUrls.bskySearch("$" + ticker, 25), { json: true, headers: auth, retries: 0 });
      posts = (j?.posts || []).filter((p) => Date.now() - Date.parse(p.indexedAt || 0) < 864e5);
    } catch { continue; } // per-ticker search failure shouldn't kill the poll
    next[ticker] = posts.length;
    if (!posts.length) continue;
    if (!store.addSignal({
      id: hashId("bluesky", ticker, date), ts: nowISO(), date,
      source: "bluesky", ticker, kind: "attention", value: posts.length,
      meta: { snippet: (posts[0]?.record?.text || "").replace(/\s+/g, " ").slice(0, 140) }
    })) continue;
    added++;
    if (isSpike("bluesky", posts.length, prevMap[ticker]))
      spikeAlerts("bluesky", ticker, `$${ticker} Bluesky posts in 24h: ${prevMap[ticker]} → ${posts.length}`);
  }
  store.state.socialPrev.bluesky = next;
  store.state.lastPoll.bluesky = nowISO();
  return added;
}
