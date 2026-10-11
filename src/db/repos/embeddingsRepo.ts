import type { Queryable } from "../dataSource.js";

/**
 * Репозиторий эмбеддингов (таблица message_embeddings из 0001, pgvector).
 * - выбор кандидатов на индексацию: сообщения без вектора ТЕКУЩЕЙ модели
 *   («устаревший» вектор = вектор другой модели, см. решение в README);
 * - upsert по (message_id, model);
 * - векторный поиск: ранжирование cosine через pgvector <=>, фильтры
 *   (person/account/chat/period/type) — в WHERE до ORDER BY (FR-04).
 */

/** Серверная размерность вектора (vector(1536) в схеме). */
export const EMBEDDING_DIM = 1536;

export interface PendingEmbeddingRow {
  id: string;
  text: string;
}

/** Сообщения без вектора текущей модели (лимит — размер батча индексации). */
export async function selectPendingEmbeddings(
  q: Queryable,
  model: string,
  limit: number,
): Promise<PendingEmbeddingRow[]> {
  const res = await q.query<PendingEmbeddingRow>(
    `SELECT m.id, m.text
     FROM messages m
     WHERE m.deleted_at IS NULL
       AND m.is_system = false
       AND NOT EXISTS (
         SELECT 1 FROM message_embeddings me
         WHERE me.message_id = m.id AND me.model = $1)
     ORDER BY m.sent_at ASC
     LIMIT $2`,
    [model, limit],
  );
  return res.rows;
}

/** pgvector принимает литерал '[1,2,...]'. */
export function serializeVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function upsertEmbedding(
  q: Queryable,
  messageId: string,
  model: string,
  vector: number[],
): Promise<void> {
  await q.query(
    `INSERT INTO message_embeddings (message_id, model, vector)
     VALUES ($1, $2, $3::vector)
     ON CONFLICT (message_id, model)
     DO UPDATE SET vector = excluded.vector, created_at = now()`,
    [messageId, model, serializeVector(vector)],
  );
}

/**
 * Edit/delete сообщения инвалидирует его вектор: строка удаляется,
 * следующий прогон индексации пересчитает её по новому тексту
 * (зависимые выводы — через messages.invalidated, см. ingestRepo).
 */
export async function deleteEmbeddingsForMessage(q: Queryable, messageId: string): Promise<void> {
  await q.query(`DELETE FROM message_embeddings WHERE message_id = $1`, [messageId]);
}

export interface SemanticFilters {
  personId?: string | undefined;
  accountId?: string | undefined;
  chatId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  chatType?: string | undefined;
  limit?: number | undefined;
}

export interface SemanticHit {
  messageId: string;
  externalMessageId: string;
  chatId: string;
  externalChatId: string;
  chatTitle: string | null;
  accountId: string;
  platform: string;
  ownExternalId: string;
  author: string;
  direction: "in" | "out";
  sentAt: Date;
  text: string;
  /** cosine similarity, 0..1. */
  score: number;
}

/**
 * Векторный топ-N: фильтры применяются в WHERE до ранжирования
 * (FR-04 — фильтрация до выборки), ранжирование — me.vector <=> $1.
 */
export async function searchSimilar(
  q: Queryable,
  queryVector: number[],
  model: string,
  f: SemanticFilters,
): Promise<SemanticHit[]> {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 200);
  const res = await q.query<SemanticHit>(
    `SELECT m.id AS "messageId", m.message_id AS "externalMessageId",
            m.chat_id AS "chatId", c.external_chat_id AS "externalChatId",
            c.title AS "chatTitle", m.account_id AS "accountId",
            a.platform, a.own_external_id AS "ownExternalId",
            m.author, m.direction, m.sent_at AS "sentAt", m.text,
            1 - (me.vector <=> $1::vector) AS score
     FROM message_embeddings me
     JOIN messages m ON m.id = me.message_id
     JOIN chats c ON c.id = m.chat_id
     JOIN accounts a ON a.id = m.account_id
     WHERE me.model = $2
       AND ($3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM chat_participants cp
             JOIN identities i ON i.external_id = cp.external_id
             WHERE cp.chat_id = m.chat_id AND i.person_id = $3))
       AND ($4::uuid IS NULL OR m.account_id = $4)
       AND ($5::uuid IS NULL OR m.chat_id = $5)
       AND ($6::date IS NULL OR m.sent_at >= $6::date)
       AND ($7::date IS NULL OR m.sent_at < $7::date + 1)
       AND ($8::text IS NULL OR c.type = $8)
       AND m.is_system = false
       AND m.deleted_at IS NULL
     ORDER BY me.vector <=> $1
     LIMIT ${limit}`,
    [
      serializeVector(queryVector),
      model,
      f.personId ?? null,
      f.accountId ?? null,
      f.chatId ?? null,
      f.from ?? null,
      f.to ?? null,
      f.chatType ?? null,
    ],
  );
  return res.rows;
}
