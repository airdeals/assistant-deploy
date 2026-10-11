import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDataSource } from "../src/db/dataSource.js";
import { insertMessageBatch, upsertChat } from "../src/db/repos/ingestRepo.js";
import { searchMessages } from "../src/db/repos/searchRepo.js";
import { createOwnerUser, login, authenticate } from "../src/auth/service.js";

/**
 * Интеграционные тесты против реального Postgres.
 * Пропускаются без DATABASE_URL (нет Docker) — unit-зелёные независимо.
 * Прогон: npm run db:local-verify (PGlite ephemeral, миграции 0001–0003).
 *
 * Баги, найденные при первом реальном прогоне (2026-10-10) и исправленные здесь:
 *  - тесты предполагали сид-аккаунт и сид-владельца, которых миграции не создают;
 *    теперь каждый тест сидит owner + account сам (ON CONFLICT DO NOTHING).
 *  - DataSource ОДИН на файл (beforeAll/afterAll): PGlite однопользовательский —
 *    второй пул подряд получает ECONNRESET.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const OWNER_ID = "00000000-0000-0000-0000-000000000001";

let ds: PostgresDataSource;

beforeAll(async () => {
  ds = new PostgresDataSource(process.env.DATABASE_URL as string);
  await ds.query(
    `INSERT INTO owners (id, display_name, timezone) VALUES ($1, 'IT-owner', 'UTC')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID],
  );
  await ds.query(
    `INSERT INTO accounts (owner_id, platform, adapter, own_external_id, connection_type)
     VALUES ($1, 'telegram', 'tg1', 'it-account', 'import_only')
     ON CONFLICT (owner_id, platform, own_external_id) DO NOTHING`,
    [OWNER_ID],
  );
});

afterAll(async () => {
  await ds.close();
});

describe.skipIf(!hasDb)("integration: Postgres", () => {
  it("миграции применены: ingest + search + auth круг скозь pg", async () => {
    const account = (await ds.query<{ id: string }>(
      `SELECT id FROM accounts ORDER BY created_at LIMIT 1`,
    )).rows[0];
    expect(account).toBeTruthy();

    const chat = await upsertChat(ds, account!.id, `it-chat-${Date.now()}`, { title: "IT" });
    const r = await insertMessageBatch(ds, chat.id, [{
      accountId: account!.id,
      externalChatId: "it",
      externalMessageId: `it-${Date.now()}`,
      author: "+7999",
      direction: "in",
      sentAt: new Date("2024-01-24T10:00:00Z"),
      text: "интеграционный счёт 20000",
    }]);
    expect(r.inserted).toBe(1);

    const hits = await searchMessages(ds, { q: "интеграционный" });
    expect(hits.length).toBeGreaterThan(0);

    await createOwnerUser(ds, OWNER_ID, `it-${Date.now()}`, "pw");
    const issued = await login(ds, "nope", "pw");
    expect(issued).toBeNull();
  }, 30000);

  it("authenticate: свежая сессия активна", async () => {
    const username = `it2-${Date.now()}`;
    await createOwnerUser(ds, OWNER_ID, username, "pw");
    const issued = await login(ds, username, "pw");
    expect(issued).not.toBeNull();
    const auth = await authenticate(ds, issued!.token);
    expect(auth).not.toBeNull();
    expect(auth!.scope).toBe("owner");
  }, 30000);
});
