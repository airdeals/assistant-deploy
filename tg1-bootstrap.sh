#!/bin/bash
# TG-1 (RU) import bootstrap — self-contained.
# Outer run: curl -sL <this url> | bash   -> re-downloads itself and goes background.
URL="https://raw.githubusercontent.com/airdeals/assistant-deploy/main/tg1-bootstrap.sh"
if [ -z "$TG1_BG" ]; then
  curl -sL "$URL" -o /tmp/tg1b.sh || { echo BOOT_FAIL_DOWNLOAD; exit 1; }
  TG1_BG=1 nohup bash /tmp/tg1b.sh > ~/tg1_import.log 2>&1 &
  echo "BG_STARTED pid $!"
  exit 0
fi

set -u
cd "$HOME/assistant" || { echo BOOT_FAIL_NO_APP; exit 1; }
export PATH="$HOME/assistant-runtime/node/bin:$PATH"
export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"\r' | sed 's/localhost/127.0.0.1/')"
[ -z "$DATABASE_URL" ] && export DATABASE_URL="postgres://assistant:assistant@127.0.0.1:5433/assistant"
export TG_BOT_TOKEN="$(grep -E '^TG_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '"\r')"
export UV_THREADPOOL_SIZE=2
echo "=== bootstrap start $(date) ==="
echo "DATABASE_URL=$DATABASE_URL"

# Quota guard: max user processes = 40 on this host; wait for headroom before heavy steps
wait_quota() {
  for W in 1 2 3 4 5 6 7 8 9 10 11 12; do
    N=$(ps -eLf | wc -l)
    echo "TASKS=$N wait=$W"
    [ "$N" -lt 30 ] && return 0
    sleep 20
  done
  return 0
}
wait_quota

# 0. DB alive? (auto-start db-server if the external killer stopped it)
ensure_db() {
  node -e "
const pg=require('$HOME/assistant/node_modules/pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect().then(()=>c.query('SELECT 1 as ok')).then(r=>{console.log('DB_OK',r.rows[0].ok);return c.end();}).catch(e=>{console.error('DB_DOWN');process.exit(1);});
"
}
start_db() {
  echo "STARTING_DB_SERVER"
  cd "$HOME/assistant"
  nohup "$HOME/assistant-runtime/node/bin/node" scripts/db-server.mjs > ~/db-server.log 2>&1 &
  echo "DB_SERVER_PID $!"
  sleep 10
}
ensure_db || start_db
ensure_db || { echo BOOT_FAIL_DB; exit 1; }

# 1. update importCli bundle (pinned commit)
curl -sL "https://raw.githubusercontent.com/airdeals/assistant-deploy/15e177624d5732cd387ee013b08625deac75b51f/dist/cli/importCli.js" -o dist/cli/importCli.js
sha256sum dist/cli/importCli.js

# 2-3. (fetch_chunks.mjs removed — curl-based downloader below, resilient to external kills)

# 4. kill bot (single-connection DB)
BOTPID="$(ps aux | grep 'dist/bot/bot.js' | grep -v grep | awk '{print $2}')"
if [ -n "$BOTPID" ]; then kill $BOTPID && echo "BOT_KILLED $BOTPID"; fi
sleep 2

# 5. download parts one-by-one with curl (short-lived processes + retries; survives external kills)
mkdir -p ~/tg1_parts
PARTS="1:BQACAgQAAxkDAAMLas_r9tONvETWx-aiSHpH-0fJlEgAAhIjAALi1HhSCwX4m7pfOJA9BA
2:BQACAgQAAxkDAAMMas_r_c2jt4Ifeoz4NLfaotNYTYkAAhQjAALi1HhSBiPIguq9xFA9BA
3:BQACAgQAAxkDAAMNas_r_udiwKxcWh_XF_tAvf18CJUAAhUjAALi1HhSyhtu5mWsMaE9BA
4:BQACAgQAAxkDAAMOas_sBYHD6XpDAWrgAdkdBeWyKfoAAhYjAALi1HhSER35wzfcjTg9BA
5:BQACAgQAAxkDAAMPas_sBsewmnYDPmokGC8WHKgdQ8YAAhcjAALi1HhSmA77Zbf5WFk9BA
6:BQACAgQAAxkDAAMQas_sDKXlCzUjtUCCdhwWYEyZvk8AAhgjAALi1HhSqINt--Oi1lI9BA"
FAIL=0
for ENTRY in $PARTS; do
  N="${ENTRY%%:*}"; FID="${ENTRY#*:}"
  OUT=~/tg1_parts/part0$N
  if [ -s "$OUT" ]; then echo "part $N already present, size $(wc -c < $OUT)"; continue; fi
  OK=0
  for TRY in 1 2 3 4 5; do
    FP=$(node -e "fetch('https://api.telegram.org/bot'+process.env.TG_BOT_TOKEN+'/getFile?file_id='+encodeURIComponent('$FID')).then(r=>r.json()).then(j=>{if(!j.ok){process.exit(1)}console.log(j.result.file_path)}).catch(()=>process.exit(1))")
    if [ -n "$FP" ]; then
      curl -sL -m 600 -o "$OUT" "https://api.telegram.org/file/bot$TG_BOT_TOKEN/$FP"
      SZ=$(wc -c < "$OUT" 2>/dev/null || echo 0)
      if [ "$SZ" -gt 1000000 ]; then echo "part $N ok try $TRY size $SZ"; OK=1; break; fi
    fi
    echo "part $N try $TRY failed, retry in 10s"; sleep 10
  done
  [ "$OK" = 0 ] && { echo "PART $N FAILED"; FAIL=1; break; }
done
[ "$FAIL" = 1 ] && { echo BOOT_FAIL_FETCH; exit 1; }
rm -f ~/tg1_parts/tg1.tar.gz
cat ~/tg1_parts/part01 ~/tg1_parts/part02 ~/tg1_parts/part03 ~/tg1_parts/part04 ~/tg1_parts/part05 ~/tg1_parts/part06 > ~/tg1_parts/tg1.tar.gz
echo "ASSEMBLY_DONE $(wc -c < ~/tg1_parts/tg1.tar.gz)"

# 6. extract (to disk-backed dir, NOT /tmp tmpfs — cgroup kills big tmpfs writes)
rm -rf ~/tg1_extract && mkdir -p ~/tg1_extract
tar -xzf ~/tg1_parts/tg1.tar.gz -C ~/tg1_extract || { echo BOOT_FAIL_TAR; exit 1; }
echo "CHAT_FILES $(ls ~/tg1_extract/tg1_chats | wc -l)"
rm -f ~/tg1_batch_state

# 6.5 stats BEFORE import
node -e "
const pg=require('$HOME/assistant/node_modules/pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect()
 .then(()=>Promise.all([c.query('SELECT a.adapter, count(ch.id) AS chats FROM accounts a LEFT JOIN chats ch ON ch.account_id=a.id GROUP BY a.adapter'),c.query('SELECT count(*) AS msgs FROM messages')]))
 .then(([a,m])=>{console.log('PRESTATS_CHATS',JSON.stringify(a.rows));console.log('PRESTATS_MSGS',m.rows[0].msgs);return c.end();})
 .catch(e=>{console.error('PRESTATS_FAIL',e.message);process.exit(1);});
"

# 7. import in BATCHES (killer on host ends node processes; grinder retries same batch until it passes)
ls ~/tg1_extract/tg1_chats > ~/tg1_filelist.txt
TOTAL=$(wc -l < ~/tg1_filelist.txt)
echo "FILES_TOTAL=$TOTAL"
BATCH=25
START_IDX=1
[ -f ~/tg1_batch_state ] && START_IDX=$(cat ~/tg1_batch_state)
FAILS=0
while [ "$START_IDX" -le "$TOTAL" ]; do
  END_IDX=$((START_IDX+BATCH-1))
  [ "$END_IDX" -gt "$TOTAL" ] && END_IDX=$TOTAL
  rm -rf ~/tg1_batch && mkdir -p ~/tg1_batch
  sed -n "${START_IDX},${END_IDX}p" ~/tg1_filelist.txt | while read -r FN; do
    [ -f "$HOME/tg1_extract/tg1_chats/$FN" ] && cp "$HOME/tg1_extract/tg1_chats/$FN" "$HOME/tg1_batch/"
  done
  CNT=$(ls ~/tg1_batch | wc -l)
  echo "BATCH_RUN $START_IDX-$END_IDX files=$CNT"
  OK=1
  if [ "$CNT" -gt 0 ]; then
    OK=0
    for TRY in 1 2 3; do
      wait_quota
      ensure_db || start_db
      node --max-old-space-size=768 dist/cli/importCli.js --format=tg --account=a1b2c3d4-0001-7000-8000-000000000001 --dir=$HOME/tg1_batch --own-sender=user230434076
      RC=$?
      echo "BATCH_EXIT range=$START_IDX-$END_IDX try=$TRY rc=$RC"
      [ "$RC" = 0 ] && { OK=1; break; }
      sleep 15
    done
  fi
  if [ "$OK" = 1 ]; then
    sed -n "${START_IDX},${END_IDX}p" ~/tg1_filelist.txt | while read -r FN; do
      rm -f "$HOME/tg1_extract/tg1_chats/$FN"
    done
    echo "$((END_IDX+1))" > ~/tg1_batch_state
    START_IDX=$((END_IDX+1))
    FAILS=0
  else
    FAILS=$((FAILS+1))
    echo "BATCH_FAILED range=$START_IDX-$END_IDX fails=$FAILS"
    sleep 30
    [ "$FAILS" -ge 150 ] && { echo BOOT_FAIL_IMPORT; exit 1; }
  fi
done
echo ALL_BATCHES_DONE

# 8. fix account own_external_id
node -e "
const pg=require('$HOME/assistant/node_modules/pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect()
 .then(()=>c.query(\"UPDATE accounts SET own_external_id='user230434076' WHERE adapter='tg1'\"))
 .then(r=>{console.log('ACCOUNTS_UPDATED',r.rowCount);return c.end();})
 .catch(e=>{console.error('ACCOUNTS_FAIL',e.message);process.exit(1);});
"

# 9. stats
node -e "
const pg=require('$HOME/assistant/node_modules/pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect()
 .then(()=>Promise.all([c.query('SELECT count(*) FROM messages'),c.query('SELECT count(*) FROM chats'),c.query('SELECT count(*) FROM accounts')]))
 .then(([m,ch,a])=>{console.log('STATS messages='+m.rows[0].count,'chats='+ch.rows[0].count,'accounts='+a.rows[0].count);return c.end();})
 .catch(e=>{console.error('STATS_FAIL',e.message);process.exit(1);});
"

# 10. ensure TG_OWNER_ID in .env, restart bot
grep -q '^TG_OWNER_ID=' .env || echo 'TG_OWNER_ID=1121294292' >> .env
grep TG_OWNER_ID .env
TG_OWNER_ID=1121294292 nohup node dist/bot/bot.js > ~/bot.log 2>&1 &
echo "BOT_STARTED $!"
sleep 5
tail -5 ~/bot.log
echo "=== bootstrap done $(date) ==="
echo BOOT_DONE