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

set -x
cd "$HOME/assistant" || { echo BOOT_FAIL_NO_APP; exit 1; }
export PATH="$HOME/assistant-runtime/node/bin:$PATH"
export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"\r' | sed 's/localhost/127.0.0.1/')"
[ -z "$DATABASE_URL" ] && export DATABASE_URL="postgres://assistant:assistant@127.0.0.1:5433/assistant"
export TG_BOT_TOKEN="$(grep -E '^TG_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '"\r')"
echo "=== bootstrap start $(date) ==="
echo "DATABASE_URL=$DATABASE_URL"

# 0. DB alive?
node -e "
const pg=require('$HOME/assistant/node_modules/pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect().then(()=>c.query('SELECT 1 as ok')).then(r=>{console.log('DB_OK',r.rows[0].ok);return c.end();}).catch(e=>{console.error('DB_FAIL',e.message);process.exit(1);});
" || { echo BOOT_FAIL_DB; exit 1; }

# 1. update importCli bundle (pinned commit)
curl -sL "https://raw.githubusercontent.com/airdeals/assistant-deploy/15e177624d5732cd387ee013b08625deac75b51f/dist/cli/importCli.js" -o dist/cli/importCli.js
sha256sum dist/cli/importCli.js

# 2. fetch_chunks.mjs
cat > fetch_chunks.mjs <<'MJS_EOF'
import { writeFileSync, appendFileSync, unlinkSync, existsSync } from "node:fs";

const [, , metaJson, outfile] = process.argv;
const meta = JSON.parse(metaJson);
const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) { console.error("TG_BOT_TOKEN required"); process.exit(1); }

async function api(path) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}${path}`);
  return r.json();
}

for (const p of meta.parts) {
  const gf = await api(`/getFile?file_id=${encodeURIComponent(p.file_id)}`);
  if (!gf.ok) { console.error("getFile fail", p.part, gf); process.exit(1); }
  const url = `https://api.telegram.org/file/bot${TOKEN}/${gf.result.file_path}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  appendFileSync(outfile, buf);
  console.log(`part ${p.part} downloaded, ${buf.length} bytes`);
}
console.log("ASSEMBLY_DONE", outfile);
MJS_EOF
wc -c fetch_chunks.mjs

# 3. chunks meta
cat > /tmp/chunks.json <<'JSON_EOF'
{"source": "tg1_chats.tar.gz", "size": 102882227, "parts": [{"part": 1, "name": "tg1_chats.tar.gz.part001", "file_id": "BQACAgQAAxkDAAMLas_r9tONvETWx-aiSHpH-0fJlEgAAhIjAALi1HhSCwX4m7pfOJA9BA"}, {"part": 2, "name": "tg1_chats.tar.gz.part002", "file_id": "BQACAgQAAxkDAAMMas_r_c2jt4Ifeoz4NLfaotNYTYkAAhQjAALi1HhSBiPIguq9xFA9BA"}, {"part": 3, "name": "tg1_chats.tar.gz.part003", "file_id": "BQACAgQAAxkDAAMNas_r_udiwKxcWh_XF_tAvf18CJUAAhUjAALi1HhSyhtu5mWsMaE9BA"}, {"part": 4, "name": "tg1_chats.tar.gz.part004", "file_id": "BQACAgQAAxkDAAMOas_sBYHD6XpDAWrgAdkdBeWyKfoAAhYjAALi1HhSER35wzfcjTg9BA"}, {"part": 5, "name": "tg1_chats.tar.gz.part005", "file_id": "BQACAgQAAxkDAAMPas_sBsewmnYDPmokGC8WHKgdQ8YAAhcjAALi1HhSmA77Zbf5WFk9BA"}, {"part": 6, "name": "tg1_chats.tar.gz.part006", "file_id": "BQACAgQAAxkDAAMQas_sDKXlCzUjtUCCdhwWYEyZvk8AAhgjAALi1HhSqINt--Oi1lI9BA"}]}
JSON_EOF
wc -c /tmp/chunks.json

# 4. kill bot (single-connection DB)
BOTPID="$(ps aux | grep 'dist/bot/bot.js' | grep -v grep | awk '{print $2}')"
if [ -n "$BOTPID" ]; then kill $BOTPID && echo "BOT_KILLED $BOTPID"; fi
sleep 2

# 5. download + assemble chunks
rm -f /tmp/tg1.tar.gz
node fetch_chunks.mjs "$(cat /tmp/chunks.json)" /tmp/tg1.tar.gz || { echo BOOT_FAIL_FETCH; exit 1; }
ls -la /tmp/tg1.tar.gz

# 6. extract
rm -rf /tmp/tg1 && mkdir -p /tmp/tg1
tar -xzf /tmp/tg1.tar.gz -C /tmp/tg1 || { echo BOOT_FAIL_TAR; exit 1; }
echo "CHAT_FILES $(ls /tmp/tg1/tg1_chats | wc -l)"

# 6.5 stats BEFORE import
node -e "
const pg=require('$HOME/assistant/node_modules/pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect()
 .then(()=>Promise.all([c.query('SELECT a.adapter, count(ch.id) AS chats FROM accounts a LEFT JOIN chats ch ON ch.account_id=a.id GROUP BY a.adapter'),c.query('SELECT count(*) AS msgs FROM messages')]))
 .then(([a,m])=>{console.log('PRESTATS_CHATS',JSON.stringify(a.rows));console.log('PRESTATS_MSGS',m.rows[0].msgs);return c.end();})
 .catch(e=>{console.error('PRESTATS_FAIL',e.message);process.exit(1);});
"

# 7. import (long)
node dist/cli/importCli.js --format=tg --account=a1b2c3d4-0001-7000-8000-000000000001 --dir=/tmp/tg1/tg1_chats --own-sender=user230434076
echo "IMPORT_EXIT=$?"

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
nohup node dist/bot/bot.js > ~/bot.log 2>&1 &
echo "BOT_STARTED $!"
sleep 5
tail -5 ~/bot.log
echo "=== bootstrap done $(date) ==="
echo BOOT_DONE