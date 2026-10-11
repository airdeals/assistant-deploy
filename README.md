# assistant-deploy

Деплой-репозиторий личного AI-помощника (владелец: частное использование).
**Здесь только код без секретов.** Токены и пароли живут в `.env` на сервере
и в этом репозитории не публикуются.

## Сервер

Виртуальный хостинг без root и без Docker (Timeweb, vh224). Поэтому:

- **Node.js v22** кладётся в `~/assistant-runtime/node` (скачивается `setup.sh`);
- вместо Docker Postgres — **PGlite** (WASM Postgres 18 + pgvector),
  данные в `~/assistant-data/db`;
- приложение и миграторы ходят к БД по обычному pg-протоколу
  (`127.0.0.1:5433`, см. `.env.example`), код не менялся.

## Установка (одна команда на сервере)

```bash
git clone https://github.com/airdeals/assistant-deploy.git assistant && bash assistant/setup.sh
```

Если `git` на сервере нет, вместо clone можно скачать архив:

```bash
(curl -L https://codeload.github.com/airdeals/assistant-deploy/tar.gz/refs/heads/main -o /tmp/a.tgz || wget -O /tmp/a.tgz https://codeload.github.com/airdeals/assistant-deploy/tar.gz/refs/heads/main) && tar -xzf /tmp/a.tgz && bash assistant-deploy-main/setup.sh
```

`setup.sh` сам: скачает Node, поставит зависимости, создаст `.env`,
прогонит миграции и smoke-тест на эфемерном PGlite. В конце — яркий маркер
`РАЗВЁРТЫВАНИЕ УСПЕШНО`.

## После установки (когда появятся секреты)

1. Вписать токен Telegram-бота и Telegram user ID владельца в `.env`;
2. Постоянная БД: `npm run db:server` (в screen/tmux, держать запущенной);
3. Миграции: `npm run migrate`;
4. Помощник: `npm run start`.

## Структура

- `src/` — весь бэкенд (контракты, адаптеры, репозитории, API);
- `scripts/db-server.mjs` — постоянная PGlite-БД по TCP 127.0.0.1:5433;
- `scripts/db-local-verify.mjs` — эфемерная проверка: миграции + smoke + интеграционный тест;
- `setup.sh` — установка без root.
