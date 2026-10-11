/**
 * db:local-verify — локальная проверка миграций и интеграционных тестов
 * БЕЗ Docker и системных установок.
 *
 * Стек: PGlite (WASM Postgres 18, дочерний процесс node) + pglite-pgvector
 * + pglite-socket (pg-протокол по TCP) → существующий мигратор, db:smoke
 * и vitest с tests/db.integration.test.ts работают без изменений.
 *
 * Почему не embedded-postgres: его бинарники (zonkyio) — ванильный Postgres
 * БЕЗ pgvector, а миграция 0001 требует тип vector(1536). Решение зафиксировано
 * в README и отчёте этапа.
 *
 * Что делает:
 *   1) поднимает ephemeral Postgres на 127.0.0.1:55432 (проверяет занятость);
 *   2) применяет миграции 0001→0002→0003 через существующий src/db/migrate.ts;
 *   3) прогоняет src/db/smoke.ts;
 *   4) прогоняет vitest tests/db.integration.test.ts (активируется по DATABASE_URL);
 *   5) гасит сервер и УДАЛЯЕТ каталог данных (os.tmpdir).
 *
 * Выходной код 0 только если все шаги зелёные.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const require = createRequire(import.meta.url);
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");

const PORT = Number(process.env.VERIFY_PORT ?? 55432);
const HOST = "127.0.0.1";
const CWD = process.cwd();

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}

function run(label, args) {
  console.log(`\n=== ${label} ===`);
  return new Promise((resolve, reject) => {
    // ВАЖНО: только асинхронный spawn — spawnSync блокирует event loop,
    // а pglite-socket обслуживает подключения этого же процесса (deadlock).
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: CWD, env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (exit ${code ?? signal})`));
    });
  });
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), "assistant-db-verify-"));
const db = new PGlite({ dataDir, extensions: { vector } });
let server = null;
let failed = false;

try {
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is busy — free it or set VERIFY_PORT`);
  server = new PGLiteSocketServer({ db, host: HOST, port: PORT });
  await server.start();
  console.log(`ephemeral postgres on ${HOST}:${PORT} (pglite WASM, dataDir ${dataDir})`);

  process.env.DATABASE_URL = `postgres://postgres:postgres@${HOST}:${PORT}/postgres`;

  await run("migrations 0001→0003", ["--import", "tsx", "src/db/migrate.ts"]);
  await run("db:smoke", ["--import", "tsx", "src/db/smoke.ts"]);
  await run("integration tests (tests/db.integration.test.ts)",
    [path.join("node_modules", "vitest", "vitest.mjs"), "run", "tests/db.integration.test.ts"]);

  console.log("\nDB LOCAL VERIFY: ALL GREEN");
} catch (e) {
  failed = true;
  console.error(`\nDB LOCAL VERIFY FAILED: ${e instanceof Error ? e.message : e}`);
} finally {
  try { await server?.stop(); } catch { /* ignore */ }
  try { await db.close(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`cleanup: data dir removed, ephemeral postgres stopped`);
}
process.exit(failed ? 1 : 0);
