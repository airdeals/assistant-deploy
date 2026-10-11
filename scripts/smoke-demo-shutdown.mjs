/**
 * Живой дымовой тест start:demo: поднимает демо, ждёт ingest-цикл,
 * дёргает loopback /shutdown-demo (тот же shutdown(), что и SIGINT) и ждёт
 * чистого выхода. Windows-хосты без собственной консоли не доставляют
 * процессу Ctrl+C, поэтому shutdown через loopback-эндпоинт demo-скрипта.
 * В реальной консоли пользователя Ctrl+C → SIGINT работает штатно.
 */
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 7100);
const child = spawn(process.execPath, ["--import", "tsx", "scripts/start-demo.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, DEMO_NO_OPEN: "1" },
  stdio: "inherit",
});

const t = setTimeout(() => {
  console.log("\n[smoke] requesting graceful shutdown via /shutdown-demo...");
  fetch(`http://127.0.0.1:${PORT + 1}/shutdown-demo`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => console.log("[smoke] shutdown response:", JSON.stringify(j)))
    .catch((e) => console.error("[smoke] shutdown request failed:", e.message));
}, 15000);

child.on("exit", (code, signal) => {
  clearTimeout(t);
  console.log(`[smoke] demo exited: code=${code} signal=${signal}`);
  process.exit(code ?? (signal ? 0 : 1));
});
setTimeout(() => { console.error("[smoke] TIMEOUT"); child.kill("SIGKILL"); process.exit(2); }, 90000);
