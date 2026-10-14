#!/usr/bin/env bash
# setup.sh — установка личного AI-помощника на сервер БЕЗ root и Docker.
# Работает на обычном виртуальном хостинге (Timeweb и подобных).
#
# Что делает:
#   1. Скачивает Node.js в ~/assistant-runtime/node (без root);
#      - glibc >= 2.28: официальная сборка v22;
#      - glibc < 2.28 (напр. Ubuntu 18.04): неофициальная сборка v20 (glibc-217);
#   2. npm install зависимостей (чистый JS, без нативных сборок);
#   3. Создаёт .env из .env.example, если его нет (секреты добавим позже);
#   4. Запускает db:local-verify — эфемерный PGlite + миграции + smoke + интеграционный тест.
#
# Запуск:  bash setup.sh
set -euo pipefail

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

say "Шаг 1: подбор сборки Node.js под эту систему"
GLIBC_VER="$(ldd --version 2>/dev/null | head -1 | awk '{print $NF}' | grep -E '^[0-9]+\.[0-9]+$' || echo '0.0')"
GLIBC_MAJOR="${GLIBC_VER%%.*}"
GLIBC_MINOR="${GLIBC_VER##*.}"
echo "  glibc: $GLIBC_VER"
if [ "$GLIBC_MAJOR" -gt 2 ] || { [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -ge 28 ]; }; then
  NODE_VER="v22.23.1"
  NODE_FLAVOUR="linux-x64"
  NODE_BASE="https://nodejs.org/dist"
else
  NODE_VER="v20.18.1"
  NODE_FLAVOUR="linux-x64-glibc-217"
  NODE_BASE="https://unofficial-builds.nodejs.org/download/release"
  warn "glibc $GLIBC_VER старше 2.28 — беру совместимую сборку Node.js $NODE_VER (glibc-217)"
fi
TARBALL="node-${NODE_VER}-${NODE_FLAVOUR}.tar.gz"

NEED_INSTALL=1
if [ -x "$NODE_DIR/bin/node" ] && "$NODE_DIR/bin/node" -v >/dev/null 2>&1; then
  HAVE_VER="$("$NODE_DIR/bin/node" -v)"
  if [ "$HAVE_VER" = "$NODE_VER" ]; then
    NEED_INSTALL=0
    echo "  уже установлен и работает: $HAVE_VER"
  else
    echo "  найден $HAVE_VER, нужен $NODE_VER — переустанавливаю"
  fi
fi

if [ "$NEED_INSTALL" = "1" ]; then
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  URLS=(
    "${NODE_BASE}/${NODE_VER}/${TARBALL}"
    "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.gz"
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
  [ -z "$OK" ] && die "не удалось скачать Node.js (проверьте доступ к nodejs.org или unofficial-builds.nodejs.org)"
  tar -xzf "/tmp/${TARBALL}" -C "$NODE_DIR" --strip-components=1
  rm -f "/tmp/${TARBALL}"
fi

export PATH="$NODE_DIR/bin:$PATH"
echo "  node: $(node -v)"
echo "  npm:  $(npm -v)"

say "Шаг 2: зависимости проекта (только рабочие, без сборщиков)"
cd "$APP_DIR"
# Код на сервере идёт собранным (dist/) — tsx/esbuild/vitest не нужны.
# Ставим только runtime-зависимости (pglite, pg, zod) и без install-скриптов:
# так установка создаёт минимум процессов и проходит даже при жёстких
# лимитах виртуального хостинга (иначе spawn sh падает с EAGAIN).
NPM_OK=""
for attempt in 1 2 3; do
  echo "  попытка $attempt: npm install --omit=dev --ignore-scripts"
  if npm install --omit=dev --no-audit --no-fund --legacy-peer-deps --ignore-scripts; then
    NPM_OK=1
    break
  fi
  echo "  попытка $attempt не удалась, пауза 15 сек"
  sleep 15
done
[ -z "$NPM_OK" ] && die "npm install не удался после 3 попыток — сообщите владельцу"

say "Шаг 3: .env (секреты добавим позже, файл уже создан)"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  создан .env из .env.example"
else
  echo "  .env уже есть, не трогаю"
fi

say "Шаг 4: проверка базы (PGlite + миграции + smoke, по собранным бандлам)"
SKIP_VITEST=1 npm run db:local-verify

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
