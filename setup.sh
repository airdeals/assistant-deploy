#!/usr/bin/env bash
# setup.sh — установка личного AI-помощника на сервер БЕЗ root и Docker.
# Работает на обычном виртуальном хостинге (Timeweb и подобных).
#
# Что делает:
#   1. Скачивает Node.js v22 (LTS) в ~/assistant-runtime/node (без root);
#   2. npm install зависимостей (чистый JS, без нативных сборок);
#   3. Создаёт .env из .env.example, если его нет (секреты добавим позже);
#   4. Запускает db:local-verify — эфемерный PGlite + миграции + smoke + интеграционный тест.
#
# Запуск:  bash setup.sh
set -euo pipefail

NODE_VER="v22.23.1"
NODE_DIR="$HOME/assistant-runtime/node"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Проверки платформы -------------------------------------------------
ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  warn "архитектура $ARCH — официальных сборок Node.js для неё нет. Если установка упадёт, напишите владельцу."
fi

say "Шаг 0: проверка инструментов скачивания"
HAVE_DL=""
for tool in curl wget git python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "  найден: $tool"
    [ -z "$HAVE_DL" ] && HAVE_DL="$tool"
  fi
done
[ -z "$HAVE_DL" ] && die "нет ни curl, wget, git, ни python3 — сообщите владельцу, нужна другая схема доставки"

say "Шаг 1: Node.js ${NODE_VER} в ${NODE_DIR}"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$NODE_DIR"
  TARBALL="node-${NODE_VER}-linux-x64.tar.gz"
  URLS=(
    "https://nodejs.org/dist/${NODE_VER}/${TARBALL}"
    "https://github.com/nodejs/node/releases/download/${NODE_VER}/${TARBALL}"
  )
  OK=""
  for url in "${URLS[@]}"; do
    echo "  качаю: $url"
    if command -v curl >/dev/null 2>&1; then
      curl -fSL --connect-timeout 20 -o "/tmp/${TARBALL}" "$url" && OK=1 && break
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 20 -O "/tmp/${TARBALL}" "$url" && OK=1 && break
    elif command -v python3 >/dev/null 2>&1; then
      python3 - "$url" "/tmp/${TARBALL}" <<'PY' && OK=1 && break
import sys, urllib.request
urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
PY
    fi
  done
  [ -z "$OK" ] && die "не удалось скачать Node.js (проверьте доступ к nodejs.org или github.com)"
  tar -xzf "/tmp/${TARBALL}" -C "$NODE_DIR" --strip-components=1
  rm -f "/tmp/${TARBALL}"
else
  echo "  уже установлен: $($NODE_DIR/bin/node -v)"
fi

export PATH="$NODE_DIR/bin:$PATH"
echo "  node: $(node -v)"
echo "  npm:  $(npm -v)"

say "Шаг 2: зависимости проекта"
cd "$APP_DIR"
npm install --no-audit --no-fund

say "Шаг 3: .env (секреты добавим позже, файл уже создан)"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  создан .env из .env.example"
else
  echo "  .env уже есть, не трогаю"
fi

say "Шаг 4: проверка базы (PGlite + миграции + smoke)"
npm run db:local-verify

say "ГОТОВО"
cat <<'EOF'

  РАЗВЁРТЫВАНИЕ УСПЕШНО
  ====================
  Node.js, зависимости, миграции и smoke-тест — всё зелёное.

  Дальше (после того как владелец пришлёт секреты):
    1. Вписать токен бота и Telegram user ID в .env
    2. Запустить постоянную БД:  npm run db:server
    3. Применить миграции:      DATABASE_URL=postgres://assistant:assistant@127.0.0.1:5433/assistant npm run migrate
    4. Запустить помощника:     npm run start
EOF
