/**
 * start:demo — единый демо-цикл (G5-4): API (node:http) + runtime
 * (demo-источники → ingest → анализ → индексация → mock-каналы).
 *
 *   DATABASE_URL не задан → сам поднимает ephemeral PGlite (WASM Postgres
 *   + pgvector) на свободном порту, применяет миграции 0001–0003,
 *   после остановки УДАЛЯЕТ данные.
 *   DATABASE_URL задан → работает на этой БД (миграции НЕ применяются
 *   автоматически: npm run migrate заранее).
 *
 * Ctrl+C — graceful shutdown: текущий poll-батч доводится, адаптеры
 * отключаются, ресурсы закрываются.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const { vector } = require("@electric-sql/pglite-pgvector");
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");

const CWD = process.cwd();
const CONFIG_PATH = process.env.DEMO_CONFIG ?? path.join(CWD, "config.demo.json");
const API_PORT = Number(process.env.PORT ?? 7100);
const PG_PORT = Number(process.env.DEMO_PG_PORT ?? 55432);

function portFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

function run(label, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: CWD, env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exit ${code}`))));
  });
}

async function openBrowser(url) {
  if (process.env.DEMO_NO_OPEN === "1") return;
  try {
    const { spawn: sp } = await import("node:child_process");
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    sp(cmd, argv, { stdio: "ignore", detached: true }).unref();
  } catch { /* браузер не открылся — не критично */ }
}

const log = (l) => console.log(`[demo] ${l}`);
let dataDir = null;
let socketServer = null;
let pglite = null;
let server = null;
let shutdownServer = null;
let ds = null;
let runner = null;
let shuttingDown = false;

async function main() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`config not found: ${CONFIG_PATH}`);
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

  const ephemeral = !process.env.DATABASE_URL;
  if (ephemeral) {
    if (!(await portFree(PG_PORT))) throw new Error(`port ${PG_PORT} busy (set DEMO_PG_PORT)`);
    dataDir = mkdtempSync(path.join(os.tmpdir(), "assistant-demo-"));
    pglite = new PGlite({ dataDir, extensions: { vector } });
    socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: PG_PORT });
    await socketServer.start();
    process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
    log(`ephemeral postgres on 127.0.0.1:${PG_PORT} (dataDir ${dataDir})`);
    await run("migrations", ["--import", "tsx", "src/db/migrate.ts"]);
  } else {
    log(`using DATABASE_URL from env (run "npm run migrate" if schema is stale)`);
  }

  const { PostgresDataSource } = await import(pathToFileURL(path.join(CWD, "src/db/dataSource.ts")).href);
  ds = new PostgresDataSource(process.env.DATABASE_URL);

  const { createApiServer } = await import(pathToFileURL(path.join(CWD, "src/api/server.ts")).href);
  const { RuntimeRunner } = await import(pathToFileURL(path.join(CWD, "src/runtime/runner.ts")).href);

  runner = new RuntimeRunner({ ds, config, log });
  await runner.seedDemo();
  runner.start();

  server = createApiServer({ ds, log });
  await new Promise((resolve) => server.listen(API_PORT, resolve));
  log(`API on http://localhost:${API_PORT} (health: /health)`);
  log(`login: ${config.demo?.username ?? "demo"} / ${config.demo?.ownerPassword ?? "demo-password"}`);
  log("веб: cd web && VITE_API_BASE=http://localhost:7100 npm run dev (или VITE_USE_FIXTURES=true)");

  // Loopback-only эндпоинт graceful-останова: Windows-хосты внутри
  // инструментальных сред (без собственной консоли) не доставляют Ctrl+C
  // процессу; POST /shutdown-demo дёргает тот же shutdown(), что и SIGINT.
  // Не критичен: при занятом порте просто не поднимается.
  shutdownServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/shutdown-demo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, shuttingDown: true }));
      log("shutdown requested via /shutdown-demo");
      setTimeout(() => void shutdown("http"), 50);
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  shutdownServer.on("error", () => { shutdownServer = null; });
  shutdownServer.listen(API_PORT + 1, "127.0.0.1");

  await openBrowser(`http://localhost:${API_PORT}/health`);
  log("running — Ctrl+C для graceful shutdown");
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutdown...`);
  try { await runner?.stop(); } catch (e) { log(`runner stop: ${e.message}`); }
  try { await new Promise((r) => server?.close(r)); } catch { /* ignore */ }
  try { await new Promise((r) => shutdownServer?.close(r)); } catch { /* ignore */ }
  try { await ds?.close(); } catch { /* ignore */ }
  try { await socketServer?.stop(); } catch { /* ignore */ }
  try { await pglite?.close(); } catch { /* ignore */ }
  if (dataDir) { rmSync(dataDir, { recursive: true, force: true }); log("ephemeral data removed"); }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((e) => {
  console.error(`[demo] FAILED: ${e.message}`);
  void shutdown("error");
});
