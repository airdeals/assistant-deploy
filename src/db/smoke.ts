import { Client } from "pg";

/**
 * Минимальный smoke-тест подключения: SELECT 1, версия сервера,
 * список созданных миграциями таблиц и их количество.
 * Требует предварительно поднятой БД и применённых миграций:
 *   docker compose up -d db && npm run migrate && npm run db:smoke
 */

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (see .env.example)");
    process.exitCode = 1;
    return;
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const one = await client.query<{ one: number }>("SELECT 1 AS one");
    if (one.rows[0]?.one !== 1) throw new Error("SELECT 1 failed");

    const version = await client.query<{ server_version: string }>("SHOW server_version");
    console.log(`connected, server_version=${version.rows[0]?.server_version}`);

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    console.log(`tables (${names.length}): ${names.join(", ")}`);

    const expected = ["accounts", "messages", "financial_events", "reminders", "message_embeddings"];
    const missing = expected.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      throw new Error(`missing expected tables: ${missing.join(", ")} (run npm run migrate first)`);
    }
    const mig = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations");
    console.log(`schema_migrations rows: ${mig.rows[0]?.count}`);
    console.log("SMOKE OK");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`SMOKE FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
});
