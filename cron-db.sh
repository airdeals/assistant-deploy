#!/bin/bash
# cron-db.sh — keep db-server alive; called by panel cron every 5 min.
HOME_REAL=/home/k/kebabms
if (echo > /dev/tcp/127.0.0.1/5433) 2>/dev/null; then exit 0; fi
cd "$HOME_REAL/assistant" || exit 1
nohup "$HOME_REAL/assistant-runtime/node/bin/node" scripts/db-server.mjs >> "$HOME_REAL/db-server.log" 2>&1 &
echo "CRON_DB_UP $! $(date)" >> "$HOME_REAL/db-server.log"
