// Zero-dependency .env loader. Reads <repo>/.env (gitignored — see .env.example)
// and fills process.env without overriding variables already set in the shell,
// so `CERES_X_BEARER=... npm start` still wins over the file.
import fs from "node:fs";

const ENV_FILE = new URL("../.env", import.meta.url).pathname;

if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
