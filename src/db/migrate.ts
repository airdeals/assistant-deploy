import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Мигратор: применяет нумерованные .sql-файлы из src/db/migrations
 * в порядке имени, фиксируя в schema_migrations. Одна транзакция
 * на миграцию. Команда `down` откатывает последнюю применённую
 * миграцию по файлу <name>.down.sql.
 *
 * Использование:
 *   npm run migrate           # применить все новые
 *   npm run migrate:down      # откатить последнюю
 *   DATABASE_URL=postgres://assistant:assistant@localhost:5433/assistant npx tsx src/db/migrate.ts
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

interface MigrationFile {
  name: string; // "0001_init"
  upPath: string;
  downPath: string | null;
}

async function listMigrations(): Promise<MigrationFile[]> {
  const files = await readdir(MIGRATIONS_DIR);
  const ups = files.filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
  return ups.map((f) => {
    const name = f.replace(/\.sql$/, "");
    const down = files.includes(`${name}.down.sql`) ? path.join(MIGRATIONS_DIR, `${name}.down.sql`) : null;
    return { name, upPath: path.join(MIGRATIONS_DIR, f), downPath: down };
  });
}

async function ensureSchemaMigrations(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(client: Client): Promise<Set<string>> {
  const res = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(res.rows.map((r) => r.name));
}

async function migrateUp(client: Client): Promise<void> {
  await ensureSchemaMigrations(client);
  const applied = await appliedSet(client);
  const migrations = await listMigrations();
  let ran = 0;
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    const sql = await readFile(m.upPath, "utf8");
    console.log(`applying ${m.name} ...`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
      await client.query("COMMIT");
      ran += 1;
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${m.name} failed, rolled back: ${(e as Error).message}`);
    }
  }
  console.log(ran === 0 ? "already up to date" : `applied ${ran} migration(s)`);
}

async function migrateDown(client: Client): Promise<void> {
  await ensureSchemaMigrations(client);
  const applied = await appliedSet(client);
  const migrations = await listMigrations();
  const last = [...migrations].reverse().find((m) => applied.has(m.name));
  if (!last) {
    console.log("nothing to roll back");
    return;
  }
  if (!last.downPath) {
    throw new Error(`migration ${last.name} has no .down.sql file`);
  }
  const sql = await readFile(last.downPath, "utf8");
  console.log(`rolling back ${last.name} ...`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE name = $1", [last.name]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw new Error(`rollback of ${last.name} failed: ${(e as Error).message}`);
  }
  console.log("rolled back");
}

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
    const command = process.argv[2] ?? "up";
    if (command === "up") await migrateUp(client);
    else if (command === "down") await migrateDown(client);
    else {
      console.error(`unknown command: ${command} (expected "up" or "down")`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
