/**
 * db:server — постоянная БД помощника на сервере БЕЗ Docker и root.
 *
 * PGlite (WASM Postgres 18) + pgvector + pglite-socket (pg-протокол по TCP).
 * Данные хранятся в ~/assistant-data/db (переопределяется DATA_DIR).
 * Порт 127.0.0.1:5433 совпадает с .env.example → приложение и мигратор
 * работают без изменений через обычный pg-клиент.
 *
 * Запуск:  npm run db:server        (должен работать постоянно, в screen/tmux)
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");

const PORT = Number(process.env.DB_PORT ?? 5433);
const HOST = process.env.DB_HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? path.join(os.homedir(), "assistant-data", "db");

mkdirSync(DATA_DIR, { recursive: true });
console.log(`[db:server] data dir: ${DATA_DIR}`);

const db = new PGlite({ dataDir: DATA_DIR, extensions: { vector } });
const server = new PGLiteSocketServer({ db, host: HOST, port: PORT });
await server.start();

console.log(`[db:server] postgres (pglite WASM) listening on ${HOST}:${PORT}`);
console.log(`[db:server] DATABASE_URL=postgres://assistant:assistant@${HOST}:${PORT}/assistant`);
console.log("[db:server] остановка: Ctrl+C");

const shutdown = async () => {
  console.log("\n[db:server] shutting down...");
  try { await server.stop(); } catch { /* ignore */ }
  try { await db.close(); } catch { /* ignore */ }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
