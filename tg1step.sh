#!/bin/bash
# tg1step.sh — ONE import step for panel cron (every ~10 min). Small-first size-sorted batches.
# Replaces the killed grinder loop. State in files, idempotent, log capped.
HOME_REAL=/home/k/kebabms
APP="$HOME_REAL/assistant"
NODE="$HOME_REAL/assistant-runtime/node/bin/node"
LOG="$HOME_REAL/tg1_step.log"
STATE="$HOME_REAL/tg1_cron_state"
LIST="$HOME_REAL/tg1_sizelist.txt"
SRC="$HOME_REAL/tg1_extract/tg1_chats"
BATCHDIR="$HOME_REAL/tg1_cron_batch"
FAILIDX="$HOME_REAL/tg1_fail_idx"
FAILCNT="$HOME_REAL/tg1_fail_cnt"
export UV_THREADPOOL_SIZE=2

echo "STEP_START $(date)" >> "$LOG"

# one-time: stop the old grinder loop, shrink its huge log
pkill -f 'tgb.sh' 2>/dev/null
pkill -f 'importCli' 2>/dev/null
[ ! -f "$HOME_REAL/.tg1_log_truncated" ] && { : > "$HOME_REAL/tg1_import.log"; touch "$HOME_REAL/.tg1_log_truncated"; }

cd "$APP" || exit 1
export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"
' | sed 's/localhost/127.0.0.1/')
[ -z "$DATABASE_URL" ] && export DATABASE_URL="postgres://assistant:assistant@127.0.0.1:5433/assistant"

# 0. ensure db
if ! (echo > /dev/tcp/127.0.0.1/5433) 2>/dev/null; then
  nohup "$NODE" scripts/db-server.mjs >> "$HOME_REAL/db-server.log" 2>&1 &
  echo "DB_STARTED $! $(date)" >> "$LOG"
  sleep 8
fi

# 1. size-sorted list once (smallest first; problem files end up last, alone)
if [ ! -f "$LIST" ]; then
  ls -S "$SRC" 2>/dev/null | tac > "$LIST"
  echo "LIST_BUILT $(wc -l < "$LIST")" >> "$LOG"
fi
TOTAL=$(wc -l < "$LIST")
IDX=1
[ -f "$STATE" ] && IDX=$(cat "$STATE")
[ -z "$IDX" ] && IDX=1
echo "PROGRESS idx=$IDX total=$TOTAL $(date)" >> "$LOG"

# 2. collect batch: <=150 files and <=50MB total; one big file goes alone
rm -rf "$BATCHDIR"; mkdir -p "$BATCHDIR"
BUDGET=52428800; N=0; SUM=0; FIRSTIDX=$IDX
while [ "$IDX" -le "$TOTAL" ]; do
  [ "$N" -ge 150 ] && break
  [ "$SUM" -ge "$BUDGET" ] && break
  FN=$(sed -n "${IDX}p" "$LIST")
  SZ=$(stat -c %s "$SRC/$FN" 2>/dev/null || echo 0)
  if [ "$SZ" != 0 ]; then
    cp "$SRC/$FN" "$BATCHDIR/" 2>/dev/null && { N=$((N+1)); SUM=$((SUM+SZ)); }
  fi
  IDX=$((IDX+1))
  [ "$SZ" -gt "$BUDGET" ] && break
done
CNT=$(ls "$BATCHDIR" 2>/dev/null | wc -l)
echo "BATCH from=$FIRSTIDX files=$CNT sum=$SUM next=$IDX" >> "$LOG"
if [ "$CNT" = 0 ]; then
  echo "ALL_DONE $(date)" >> "$LOG"
  tail -100 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  exit 0
fi

# 3. import this batch once; if killed, next cron run retries the same batch
# single-connection DB: pause cron-bot, stop OUR bot, import, unpause
touch "$HOME_REAL/IMPORT_PAUSE"
for P in $(pgrep -f dist/bot/bot.js); do
  C=$(readlink /proc/$P/cwd 2>/dev/null)
  [ "$C" = "$HOME_REAL/assistant" ] && kill $P 2>/dev/null
done
sleep 2
"$NODE" --max-old-space-size=512 dist/cli/importCli.js --format=tg --account=a1b2c3d4-0001-7000-8000-000000000001 --dir="$BATCHDIR" --own-sender=user230434076 >> "$LOG" 2>&1
RC=$?
echo "IMPORT rc=$RC" >> "$LOG"
if [ "$RC" = 0 ]; then
  for F in "$BATCHDIR"/*; do rm -f "$SRC/$(basename "$F")"; done
  echo "$IDX" > "$STATE"
  rm -f "$FAILIDX" "$FAILCNT"
  echo "ADVANCED to=$IDX" >> "$LOG"
else
  # count failures per batch; after 3, skip it (log) and move on
  if [ -f "$FAILIDX" ] && [ "$(cat "$FAILIDX")" = "$FIRSTIDX" ]; then
    FC=$(cat "$FAILCNT" 2>/dev/null); FC=$((FC+1))
  else
    echo "$FIRSTIDX" > "$FAILIDX"; FC=1
  fi
  echo "$FC" > "$FAILCNT"
  echo "FAIL from=$FIRSTIDX count=$FC" >> "$LOG"
  if [ "$FC" -ge 3 ]; then
    echo "$IDX" > "$STATE"
    rm -f "$FAILIDX" "$FAILCNT"
    echo "SKIPPED from=$FIRSTIDX to=$((IDX-1))" >> "$LOG"
  fi
fi
rm -f "$HOME_REAL/IMPORT_PAUSE"
tail -100 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
