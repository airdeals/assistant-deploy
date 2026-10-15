#!/bin/bash
# supervise.sh — keep db-server and bot alive on a hostile shared host; self-backgrounding.
# Outer run: curl -sL <this url> | bash   -> re-downloads itself and goes background.
URL="https://raw.githubusercontent.com/airdeals/assistant-deploy/main/supervise.sh"
if [ -z "$SUP_BG" ]; then
  curl -sL "$URL" -o /tmp/supervise.sh || { echo SUP_FAIL_DOWNLOAD; exit 1; }
  SUP_BG=1 nohup bash /tmp/supervise.sh > ~/supervise.log 2>&1 &
  echo "SUP_BG_STARTED pid $!"
  exit 0
fi

NODE="$HOME/assistant-runtime/node/bin/node"
APP="$HOME/assistant"
cd "$APP" || { echo SUP_FAIL_NO_APP; exit 1; }
export UV_THREADPOOL_SIZE=2

db_up() {
  (echo > /dev/tcp/127.0.0.1/5433) 2>/dev/null
}

start_db() {
  if ! db_up; then
    nohup "$NODE" scripts/db-server.mjs >> ~/db-server.log 2>&1 &
    echo "SUP_DB_STARTED $! $(date)"
  fi
}

bot_up() {
  ps aux | grep 'dist/bot/bot.js' | grep -v grep | grep -v defunct >/dev/null 2>&1
}

start_bot() {
  if ! bot_up; then
    TG_OWNER_ID=1121294292 nohup "$NODE" dist/bot/bot.js >> ~/bot.log 2>&1 &
    echo "SUP_BOT_STARTED $! $(date)"
  fi
}

echo "SUPERVISOR_START $(date)"
i=0
while [ "$i" -lt 720 ]; do
  start_db
  start_bot
  i=$((i+1))
  sleep 60
done
echo "SUPERVISOR_END $(date)"