#!/bin/bash
# TG-2 (TR) import bootstrap — self-contained.
# Outer run: curl -sL <this url> | bash   -> re-downloads itself and goes background.
URL="https://raw.githubusercontent.com/airdeals/assistant-deploy/main/tg2-bootstrap.sh"
if [ -z "$TG2_BG" ]; then
  curl -sL "$URL" -o /tmp/tg2b.sh || { echo BOOT_FAIL_DOWNLOAD; exit 1; }
  TG2_BG=1 nohup bash /tmp/tg2b.sh > ~/tg2_import.log 2>&1 &
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
{"source": "tg2_chats.tar.gz", "size": 60772314, "parts": [{"part": 1, "name": "tg2_chats.tar.gz.part001", "file_id": "BQACAgQAAxkDAAMHas-40YH9ZdhGRfMDR3Fn_HD9LVEAApwiAALi1HhS1NqR1FkC2xU9BA"}, {"part": 2, "name": "tg2_chats.tar.gz.part002", "file_id": "BQACAgQAAxkDAAMIas-40gKBefjWr4yhD17VsBOhBdEAAp0iAALi1HhSan2SJp3X0p89BA"}, {"part": 3, "name": "tg2_chats.tar.gz.part003", "file_id": "BQACAgQAAxkDAAMJas-40-sqjeXijBePRw8aaCFxqw0AAp4iAALi1HhSLDEMLM4TPr09BA"}, {"part": 4, "name": "tg2_chats.tar.gz.part004", "file_id": "BQACAgQAAxkDAAMKas-40x32HNZqo7DYgtTueH1bn-wAAp8iAALi1HhSwZdwWQYSlec9BA"}]}
JSON_EOF
wc -c /tmp/chunks.json

# 4. kill bot (single-connection DB)
BOTPID="$(ps aux | grep 'dist/bot/bot.js' | grep -v grep | awk '{print $2}')"
if [ -n "$BOTPID" ]; then kill $BOTPID && echo "BOT_KILLED $BOTPID"; fi
sleep 2

# 5. download + assemble chunks
rm -f /tmp/tg2.tar.gz
node fetch_chunks.mjs "$(cat /tmp/chunks.json)" /tmp/tg2.tar.gz || { echo BOOT_FAIL_FETCH; exit 1; }
ls -la /tmp/tg2.tar.gz

# 6. extract
rm -rf /tmp/tg2 && mkdir -p /tmp/tg2
tar -xzf /tmp/tg2.tar.gz -C /tmp/tg2 || { echo BOOT_FAIL_TAR; exit 1; }
echo "CHAT_FILES $(ls /tmp/tg2/tg2_chats | wc -l)"

# 7. import (long)
node dist/cli/importCli.js --format=tg --account=a1b2c3d4-0002-7000-8000-000000000002 --dir=/tmp/tg2/tg2_chats --own-sender=user1121294292
echo "IMPORT_EXIT=$?"

# 8. fix account own_external_id
node -e "
const pg=require('$HOME/assistant/node_modules/pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect()
 .then(()=>c.query(\"UPDATE accounts SET own_external_id='user1121294292' WHERE adapter='tg2'\"))
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

# 10. restart bot
nohup node dist/bot/bot.js > ~/bot.log 2>&1 &
echo "BOT_STARTED $!"
sleep 5
tail -5 ~/bot.log
echo "=== bootstrap done $(date) ==="
echo BOOT_DONE
