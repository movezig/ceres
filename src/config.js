// Ceres configuration
export const CONFIG = {
  // SEC requires a descriptive User-Agent with contact info — set CERES_CONTACT to your email.
  userAgent: `Ceres/1.0 research dashboard (${process.env.CERES_CONTACT || "CERES_CONTACT not set"})`,

  pollIntervalMs: 60 * 60 * 1000,        // hourly
  congressPollEveryNthCycle: 6,          // congress datasets are large + update slowly: every 6h
  requestDelayMs: 150,                   // stay well under SEC's 10 req/s limit
  form4MaxFilingsPerPoll: 80,            // politeness cap
  backfillDays: 120,                     // ignore congress rows disclosed earlier than this on first run

  // Alert thresholds
  alerts: {
    insiderBigBuyUsd: 250_000,           // single open-market insider buy
    insiderClusterCount: 3,              // distinct insiders buying same ticker...
    insiderClusterWindowDays: 14,        // ...within this window
    congressBigUsd: 100_000,             // range midpoint
    fundIncreasePct: 50                  // 13F position increase to count as conviction add
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

  sources: {
    form4:    { tier: 1, label: "Insiders (Form 4)" },
    sc13d:    { tier: 2, label: "Activists (13D)" },
    fund13f:  { tier: 3, label: "Superinvestors (13F)" },
    congress: { tier: 4, label: "Congress" }
  },

  edgar: {
    form4Atom:  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=100&output=atom",
    sc13dAtom:  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC+13D&company=&dateb=&owner=include&count=40&output=atom",
    tickersUrl: "https://www.sec.gov/files/company_tickers.json",
    submissions:(cik) => `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`,
    archiveDir: (cik, accNoDash) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDash}`
  },

  congress: {
    houseUrl:  "https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json",
    senateUrl: "https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json"
  },

  port: Number(process.env.PORT || 8321),
  dataDir: new URL("../data/", import.meta.url).pathname
};
