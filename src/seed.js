// Demo seeder — populates plausible data so the dashboard is reviewable before the first real poll.
// Run: npm run seed   |   Remove later: POST /api/purge-demo (button in the UI footer).
import { store } from "./store.js";
import { hashId, daysAgoISO } from "./util.js";

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const iso = (daysBack) => daysAgoISO(Math.floor(daysBack));

const TICKERS = [
  ["NVDA", "NVIDIA Corp"], ["GOOGL", "Alphabet Inc"], ["AMZN", "Amazon.com Inc"], ["MSFT", "Microsoft Corp"],
  ["AAPL", "Apple Inc"], ["AVGO", "Broadcom Inc"], ["TEM", "Tempus AI"], ["VST", "Vistra Corp"],
  ["GS", "Goldman Sachs"], ["GE", "General Electric"], ["GEV", "GE Vernova"], ["UBER", "Uber Technologies"],
  ["MU", "Micron Technology"], ["STX", "Seagate"], ["JPM", "JPMorgan Chase"], ["XOM", "Exxon Mobil"],
  ["UNH", "UnitedHealth"], ["PLTR", "Palantir"], ["TSLA", "Tesla Inc"], ["CAT", "Caterpillar"],
  ["LMT", "Lockheed Martin"], ["SO", "Southern Co"], ["AB", "AllianceBernstein"], ["DIS", "Walt Disney"]
];
const INSIDERS = [["Jane T Morrow", "CEO"], ["Daniel K Osei", "CFO"], ["Priya Raman", "Director"], ["Chen Wei", "COO"], ["R. Alvarez", "10% owner"], ["M. Kowalski", "Director"], ["S. Fitzgerald", "President"], ["A. Njoku", "EVP"]];
const FUNDS = ["Berkshire Hathaway (Buffett)", "Appaloosa (Tepper)", "Duquesne Family Office (Druckenmiller)", "Pershing Square (Ackman)", "Third Point (Loeb)", "Baupost Group (Klarman)"];
const ACTIVISTS = ["Elliott Investment Management", "Starboard Value LP", "Jana Partners", "ValueAct Holdings"];
const MEMBERS = [["Nancy Pelosi", "Rep. CA-11"], ["Ro Khanna", "Rep. CA-17"], ["Josh Gottheimer", "Rep. NJ-5"], ["Tom Suozzi", "Rep. NY-3"], ["Ted Cruz", "Senator"], ["Cleo Fields", "Rep. LA-6"], ["Rick Scott", "Senator"], ["Terri Sewell", "Rep. AL-7"]];
const RANGES = [[1001, 15000], [15001, 50000], [50001, 100000], [100001, 250000], [250001, 500000], [500001, 1000000], [1000001, 5000000]];

let n = 0;
function add(row) { row.demo = true; if (store.addTrade(row)) n++; }

for (let i = 0; i < 260; i++) {
  const [ticker, company] = pick(TICKERS);
  const [trader, role] = pick(INSIDERS);
  const buy = Math.random() < 0.62;
  const shares = Math.round(rnd(500, 80000));
  const price = rnd(8, 900);
  const d = rnd(0, 45);
  add({
    id: hashId("demo-f4", i), source: "form4", ticker, company, trader, traderRole: role,
    type: buy ? "buy" : "sell", shares, price: +price.toFixed(2), estUsd: Math.round(shares * price),
    usdMin: null, usdMax: null, tradeDate: iso(d + 1), filedDate: iso(d), url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4"
  });
}
for (let i = 0; i < 14; i++) {
  const [ticker, company] = pick(TICKERS);
  const d = rnd(0, 60);
  add({
    id: hashId("demo-13d", i), source: "sc13d", ticker, company, trader: pick(ACTIVISTS), traderRole: "13D filer",
    type: "new_stake", shares: null, price: null, estUsd: Math.round(rnd(8e7, 2.5e9)), usdMin: null, usdMax: null,
    tradeDate: iso(d), filedDate: iso(d), url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13D"
  });
}
for (let i = 0; i < 60; i++) {
  const [ticker, company] = pick(TICKERS);
  const type = pick(["new_stake", "add", "add", "trim", "exit"]);
  const d = rnd(0, 80);
  add({
    id: hashId("demo-13f", i), source: "fund13f", ticker, company, trader: pick(FUNDS), traderRole: "13F manager",
    type, shares: null, price: null, estUsd: Math.round(rnd(2e7, 1.6e10)), usdMin: null, usdMax: null,
    tradeDate: iso(d), filedDate: iso(d), url: "https://13f.info"
  });
}
for (let i = 0; i < 120; i++) {
  const [ticker, company] = pick(TICKERS);
  const [trader, role] = pick(MEMBERS);
  const [min, max] = pick(RANGES);
  const buy = Math.random() < 0.58;
  const d = rnd(0, 60);
  add({
    id: hashId("demo-cg", i), source: "congress", ticker, company, trader, traderRole: role,
    type: buy ? "buy" : "sell", shares: null, price: null,
    estUsd: Math.round((min + max) / 2), usdMin: min, usdMax: max,
    tradeDate: iso(d + rnd(5, 40)), filedDate: iso(d), url: "https://disclosures-clerk.house.gov"
  });
}

// A few demo alerts
const alerts = [
  ["insider_cluster", "critical", "form4", "GEV", "3 insiders", "CLUSTER BUY: 3 insiders bought GEV within 14d"],
  ["insider_big_buy", "high", "form4", "MU", "Jane T Morrow", "Jane T Morrow (CEO) bought ~$1.2M of MU"],
  ["activist_13d", "high", "sc13d", "DIS", "Elliott Investment Management", "New 13D filed on Walt Disney (DIS) — activist stake >5%"],
  ["fund_conviction", "medium", "fund13f", "GOOGL", "Berkshire Hathaway (Buffett)", "Berkshire: major add in Alphabet (~$16.6B)"],
  ["congress_big_buy", "medium", "congress", "AB", "Nancy Pelosi", "Nancy Pelosi disclosed AB buy, $1.0M–$5.0M (filed Jan 26, traded Jan 16)"]
];
alerts.forEach(([rule, severity, source, ticker, trader, message], i) => {
  // anchor each demo alert to a real seeded trade so alert → trade click-through works
  const match = store.trades.find((t) => t.demo && t.ticker === ticker && t.source === source &&
    (["buy", "new_stake", "add"].includes(t.type) || source === "sc13d"));
  store.addAlert({ id: hashId("demo-al", i), ts: new Date(Date.now() - i * 36e5).toISOString(), rule, severity, source, ticker, trader, message, tradeIds: match ? [match.id] : [], demo: true });
});

store.saveState();
console.log(`[seed] inserted ${n} demo trades + ${alerts.length} demo alerts. Purge later via UI footer or POST /api/purge-demo.`);
