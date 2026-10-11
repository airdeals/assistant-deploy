import { randomUUID } from "node:crypto";
import type { DataSource, Queryable } from "../dataSource.js";

/**
 * ingestRepo: запись нормализованных событий в БД.
 * AT-06: натуральный ключ (account_id, external_chat_id, message_id),
 * INSERT ... ON CONFLICT DO NOTHING — повтор webhook/импорта не дублирует.
 * Правка текста обновляет сообщение и пишет message_revisions + invalidated.
 * Батч записывается одной транзакцией; checkpoint sync хранится
 * в sync_checkpoints.
 */

export interface IngestMessageEvent {
  accountId: string;
  externalChatId: string;
  externalMessageId: string;
  author: string;
  direction: "in" | "out";
  sentAt: Date;
  sourceTz?: string | null;
  text: string;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  isSystem?: boolean;
}

export interface ChatUpsert {
  id: string;
  created: boolean;
}

export interface BatchInsertResult {
  inserted: number;
  updated: number;
  duplicates: number;
  total: number;
}

export async function upsertChat(
  q: Queryable,
  accountId: string,
  externalChatId: string,
  opts: { title?: string | null; type?: string } = {},
): Promise<ChatUpsert> {
  const res = await q.query<{ id: string; created: boolean }>(
    `INSERT INTO chats (account_id, external_chat_id, type, title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, external_chat_id)
     DO UPDATE SET title = COALESCE(excluded.title, chats.title)
     RETURNING id, (xmax = 0) AS created`,
    [accountId, externalChatId, opts.type ?? "direct", opts.title ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error("upsertChat: no row returned");
  return row;
}

export async function upsertParticipant(
  q: Queryable,
  chatId: string,
  externalId: string,
  personId?: string | null,
): Promise<void> {
  await q.query(
    `INSERT INTO chat_participants (chat_id, external_id, person_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id, external_id)
     DO UPDATE SET person_id = COALESCE(excluded.person_id, chat_participants.person_id)`,
    [chatId, externalId, personId ?? null],
  );
}

export async function insertMessage(
  q: Queryable,
  chatId: string,
  e: IngestMessageEvent,
): Promise<"inserted" | "updated" | "duplicate"> {
  const res = await q.query<{ id: string }>(
    `INSERT INTO messages
       (account_id, chat_id, message_id, author, direction, sent_at, source_tz,
        text, edited_at, deleted_at, is_system)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (account_id, chat_id, message_id) DO NOTHING
     RETURNING id`,
    [
      e.accountId,
      chatId,
      e.externalMessageId,
      e.author,
      e.direction,
      e.sentAt,
      e.sourceTz ?? null,
      e.text,
      e.editedAt ?? null,
      e.deletedAt ?? null,
      e.isSystem ?? false,
    ],
  );
  if (res.rows[0]) return "inserted";

  // Конфликт: проверяем, изменился ли текст/удаление.
  const existing = await q.query<{
    id: string;
    text: string;
    deleted_at: Date | null;
  }>(
    `SELECT id, text, deleted_at FROM messages
     WHERE account_id = $1 AND chat_id = $2 AND message_id = $3`,
    [e.accountId, chatId, e.externalMessageId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("insertMessage: conflict without existing row");
  const wantsDeleted = (e.deletedAt ?? null) !== null;
  const textChanged = e.text !== row.text;
  if (!textChanged && (!wantsDeleted || row.deleted_at !== null)) {
    return "duplicate";
  }
  const now = e.editedAt ?? e.deletedAt ?? new Date();
  const seqRes = await q.query<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM message_revisions WHERE message_id = $1`,
    [row.id],
  );
  const nextSeq = seqRes.rows[0]?.next_seq ?? 1;
  await q.query(
    `INSERT INTO message_revisions (message_id, seq, kind, prev_text, new_text, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.id, nextSeq, wantsDeleted ? "delete" : "edit", row.text, wantsDeleted ? "" : e.text, now],
  );
  await q.query(
    `UPDATE messages
     SET text = $2, edited_at = $3, deleted_at = $4, invalidated = true
     WHERE id = $1`,
    [
      row.id,
      wantsDeleted ? row.text : e.text,
      e.editedAt ?? (textChanged ? now : null),
      wantsDeleted ? e.deletedAt ?? now : null,
    ],
  );
  return "updated";
}

/** Транзакционная запись батча событий одного чата. */
export async function insertMessageBatch(
  ds: DataSource,
  chatId: string,
  events: IngestMessageEvent[],
): Promise<BatchInsertResult> {
  return ds.transaction(async (tx) => {
    const result: BatchInsertResult = { inserted: 0, updated: 0, duplicates: 0, total: events.length };
    for (const e of events) {
      const status = await insertMessage(tx, chatId, e);
      result[status === "inserted" ? "inserted" : status === "updated" ? "updated" : "duplicates"] += 1;
    }
    return result;
  });
}

export async function saveCheckpoint(
  q: Queryable,
  accountId: string,
  cursor: unknown,
): Promise<void> {
  await q.query(
    `INSERT INTO sync_checkpoints (account_id, cursor, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (account_id) DO UPDATE SET cursor = excluded.cursor, updated_at = now()`,
    [accountId, JSON.stringify(cursor ?? {})],
  );
}

export async function getCheckpoint(q: Queryable, accountId: string): Promise<unknown | null> {
  const res = await q.query<{ cursor: unknown }>(
    `SELECT cursor FROM sync_checkpoints WHERE account_id = $1`,
    [accountId],
  );
  return res.rows[0]?.cursor ?? null;
}

/** Служебный id для тестов/фейков, не используется в SQL. */
export function newId(): string {
  return randomUUID();
}

/** Своя переписка помощника → is_assistant_thread (AT-37, G5). */
export async function markAssistantThread(
  q: Queryable,
  accountId: string,
  externalChatId: string,
): Promise<void> {
  await q.query(
    `UPDATE chats SET is_assistant_thread = true WHERE account_id = $1 AND external_chat_id = $2`,
    [accountId, externalChatId],
  );
}
