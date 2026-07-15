// Build the static GitHub Pages site into docs/.
// Copies the SPA from public/, rewrites asset paths to be relative (Pages
// serves from a /ceres/ subpath), injects the live-POC banner + static-api.js
// shim, and writes the current store to docs/snapshot.json.
// Run by .github/workflows/poll.yml after each hourly poll so the hosted
// site tracks the live store. docs/static-api.js is hand-maintained.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, sourceConfigured } from "./config.js";
import { store } from "./store.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUB = path.join(ROOT, "public");
const DOCS = path.join(ROOT, "docs");
fs.mkdirSync(DOCS, { recursive: true });

const generatedAt = new Date().toISOString();
const signalCutoff = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
const snapshot = {
  generatedAt,
  meta: {
    managers: CONFIG.managers, sources: CONFIG.sources, alerts: CONFIG.alerts,
    signalSources: Object.fromEntries(Object.entries(CONFIG.signalSources)
      .map(([k, v]) => [k, { label: v.label, configured: sourceConfigured(k) }])),
    confluenceWindowDays: CONFIG.alerts.confluenceWindowDays,
    pollIntervalMs: CONFIG.pollIntervalMs, port: CONFIG.port
  },
  sectors: JSON.parse(fs.readFileSync(path.join(PUB, "sectors.json"), "utf8")),
  lastPoll: store.state.lastPoll,
  trades: store.trades,
  alerts: store.alerts,
  signals: store.signals.filter((s) => s.date >= signalCutoff) // bound snapshot size
};
fs.writeFileSync(path.join(DOCS, "snapshot.json"), JSON.stringify(snapshot));

fs.copyFileSync(path.join(PUB, "app.js"), path.join(DOCS, "app.js"));

const banner = `<div class="poc-banner">⬡ Live POC — real SEC + congressional disclosures, re-polled hourly · last refresh ${generatedAt.slice(0, 16).replace("T", " ")} UTC · ` +
  `<a href="https://github.com/movezig/ceres">self-host for desktop alerts</a></div>`;

const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8")
  .replace('href="/style.css"', 'href="./style.css"')
  .replace('<script src="/app.js"></script>', '<script src="./static-api.js"></script>\n<script src="./app.js"></script>')
  .replace("</header>", "</header>\n" + banner);
fs.writeFileSync(path.join(DOCS, "index.html"), html);

const css = fs.readFileSync(path.join(PUB, "style.css"), "utf8") + `
/* --- static Pages build only --- */
.poc-banner {
  padding: 6px 20px; font-size: 12px; text-align: center;
  background: #241d0a; color: var(--accent); border-bottom: 1px solid var(--line);
}
.poc-banner a { color: var(--accent); text-decoration: underline; }
#pollBtn, #purgeDemoBtn { display: none; } /* server actions — polling is the Actions cron's job here */
`;
fs.writeFileSync(path.join(DOCS, "style.css"), css);

console.log(`docs/ built: ${store.trades.length} trades, ${store.alerts.length} alerts, ${snapshot.signals.length} signals, snapshot ${generatedAt}`);
