#!/bin/bash
# tg2fetch.sh — download TG-2 archive parts from Telegram via bot API, extract, build size list.
# Idempotent: if tg2_ready exists, exits immediately. Runs from panel cron until success.
HOME_REAL=/home/k/kebabms
LOG="$HOME_REAL/tg2_fetch.log"
READY="$HOME_REAL/tg2_ready"
PARTS_DIR="$HOME_REAL/tg2_parts"
DEST="$HOME_REAL/tg2_chats.tar.gz"
EXTRACT="$HOME_REAL/tg2_extract"
LIST="$HOME_REAL/tg2_sizelist.txt"
SRC="$EXTRACT/tg2_chats"

[ -f "$READY" ] && exit 0
echo "FETCH_START $(date)" >> "$LOG"

TOK=$(grep -E '^TG_BOT_TOKEN=' "$HOME_REAL/assistant/.env" | cut -d= -f2- | tr -d '\r\n ')
[ -z "$TOK" ] && { echo "NO_TOKEN $(date)" >> "$LOG"; exit 1; }

# file_ids of the 4 parts (sent earlier by bot @kipadel_bot)
FIDS="BQACAgQAAxkDAAMHas-40YH9ZdhGRfMDR3Fn_HD9LVEAApwiAALi1HhS1NqR1FkC2xU9BA BQACAgQAAxkDAAMIas-40gKBefjWr4yhD17VsBOhBdEAAp0iAALi1HhSan2SJp3X0p89BA BQACAgQAAxkDAAMJas-40-sqjeXijBePRw8aaCFxqw0AAp4iAALi1HhSLDEMLM4TPr09BA BQACAgQAAxkDAAMKas-40x32HNZqo7DYgtTueH1bn-wAAp8iAALi1HhSwZdwWQYSlec9BA"

mkdir -p "$PARTS_DIR"
N=0
for FID in $FIDS; do
  N=$((N+1))
  OUT="$PARTS_DIR/part00$N"
  [ -s "$OUT" ] && { echo "PART $N cached" >> "$LOG"; continue; }
  FP=$(wget -q -T 30 -O - "https://api.telegram.org/bot$TOK/getFile?file_id=$FID" | grep -o '"file_path":"[^"]*"' | cut -d'"' -f4)
  [ -z "$FP" ] && { echo "PART $N getFile FAILED $(date)" >> "$LOG"; exit 1; }
  wget -q -T 60 -O "$OUT" "https://api.telegram.org/file/bot$TOK/$FP" || { echo "PART $N download FAILED $(date)" >> "$LOG"; exit 1; }
  echo "PART $N ok size=$(stat -c %s "$OUT" 2>/dev/null || echo 0)" >> "$LOG"
done

cat "$PARTS_DIR/part001" "$PARTS_DIR/part002" "$PARTS_DIR/part003" "$PARTS_DIR/part004" > "$DEST"
rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
tar -xzf "$DEST" -C "$EXTRACT" >> "$LOG" 2>&1 || { echo "EXTRACT FAILED $(date)" >> "$LOG"; exit 1; }
[ -d "$SRC" ] || { echo "NO_SRC_DIR $(date)" >> "$LOG"; ls "$EXTRACT" >> "$LOG" 2>&1; exit 1; }
ls -S "$SRC" | tac > "$LIST"
echo "LIST_BUILT $(wc -l < "$LIST") files" >> "$LOG"
touch "$READY"
echo "READY $(date)" >> "$LOG"
tail -50 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
