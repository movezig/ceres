#!/bin/sh
# Ceres watchdog — restart the server if it stops answering.
# Installed in cron (every minute): crontab -l
# Exists because launchd pends KeepAlive respawns as "inefficient" on modern macOS
# and never actually restarts the job (see com.ceres.server LaunchAgent).
cd "$(dirname "$0")" || exit 1

# healthy → nothing to do
curl -s -m 3 http://localhost:8321/api/meta >/dev/null 2>&1 && exit 0
# port held but slow to answer (e.g. mid boot-poll) → don't double-start
lsof -ti :8321 -sTCP:LISTEN >/dev/null 2>&1 && exit 0

echo "$(date -u +%FT%TZ) ceres down — restarting"
/opt/homebrew/bin/node server.js >> data/server.log 2>&1 &
