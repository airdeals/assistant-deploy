#!/bin/bash
# cron-bot.sh — keep bot alive; called by panel cron every minute.
# Bot reads config from process env only (not .env) — export both vars inline.
HOME_REAL=/home/k/kebabms
# importer owns the single DB connection while its pause flag is fresh (<15 min)
if [ -f "$HOME_REAL/IMPORT_PAUSE" ] && [ -z "$(find "$HOME_REAL/IMPORT_PAUSE" -mmin +15 2>/dev/null)" ]; then exit 0; fi
ALIVE=0
for P in $(pgrep -f dist/bot/bot.js); do
  C=$(readlink /proc/$P/cwd 2>/dev/null)
  [ "$C" = "$HOME_REAL/assistant" ] && ALIVE=1
done
[ "$ALIVE" = 1 ] && exit 0
cd "$HOME_REAL/assistant" || exit 1
export TG_BOT_TOKEN=$(grep -E '^TG_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '"\r')
export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"\r' | sed 's/localhost/127.0.0.1/')
[ -z "$DATABASE_URL" ] && export DATABASE_URL="postgres://assistant:assistant@127.0.0.1:5433/assistant"
TG_OWNER_ID=1121294292 nohup "$HOME_REAL/assistant-runtime/node/bin/node" dist/bot/bot.js >> "$HOME_REAL/bot.log" 2>&1 &
echo "CRON_BOT_UP $! $(date)" >> "$HOME_REAL/bot.log"
