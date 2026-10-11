import { createHash } from "node:crypto";
import type { Queryable } from "../dataSource.js";
import type { Expectation, ExpectationResolution, ExpectationStatus } from "../../core/pendingReplies.js";

/** Персист ожиданий ответов (pending_replies + колонки G3/0003). */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Core-стор генерирует текстовые id вида "exp-N"; колонка pending_replies.id —
 * uuid. На границе персистентности приводим к детерминированному uuid
 * (из messageId): повторная propose того же вопроса сходится в одну строку
 * (ON CONFLICT), а не падает с 22P02. Найдено интеграционным прогоном G5-4.
 */
function rowIdFor(e: Expectation): string {
  if (UUID_RE.test(e.id)) return e.id;
  const h = createHash("sha256").update(`pending:${e.messageId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface PendingReplyRow {
  id: string;
  chatId: string;
  messageId: string;
  fromPersonId: string | null;
  question: string;
  status: ExpectationStatus;
  resolution: ExpectationResolution;
  closedByMessageId: string | null;
  waitingSince: Date;
}

function toRow(e: Expectation): PendingReplyRow {
  return {
    id: rowIdFor(e),
    chatId: e.chatId,
    messageId: e.messageId,
    fromPersonId: e.personId,
    question: e.question,
    status: e.status,
    resolution: e.resolution,
    closedByMessageId: e.closedByMessageId,
    waitingSince: e.questionSentAt,
  };
}

export async function upsertExpectation(q: Queryable, e: Expectation): Promise<void> {
  const r = toRow(e);
  await q.query(
    `INSERT INTO pending_replies
       (id, chat_id, message_id, from_person_id, question, status, resolution,
        closed_by_message_id, waiting_since)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status,
       resolution = excluded.resolution,
       closed_by_message_id = excluded.closed_by_message_id,
       from_person_id = excluded.from_person_id`,
    [r.id, r.chatId, r.messageId, r.fromPersonId, r.question, r.status, r.resolution, r.closedByMessageId, r.waitingSince],
  );
}

export async function listExpectations(
  q: Queryable,
  opts: { status?: ExpectationStatus | undefined } = {},
): Promise<PendingReplyRow[]> {
  const res = await q.query<PendingReplyRow>(
    `SELECT id, chat_id AS "chatId", message_id AS "messageId",
            from_person_id AS "fromPersonId", question, status, resolution,
            closed_by_message_id AS "closedByMessageId", waiting_since AS "waitingSince"
     FROM pending_replies
     ${opts.status ? "WHERE status = $1" : ""}
     ORDER BY waiting_since DESC`,
    opts.status ? [opts.status] : [],
  );
  return res.rows;
}

/** Пометка чата как служебного (поток владельца с ассистентом, AT-37). */
export async function markAssistantThread(q: Queryable, chatId: string): Promise<void> {
  await q.query(`UPDATE chats SET is_assistant_thread = true WHERE id = $1`, [chatId]);
}

export async function isAssistantThread(q: Queryable, chatId: string): Promise<boolean> {
  const res = await q.query<{ is_assistant_thread: boolean }>(
    `SELECT is_assistant_thread FROM chats WHERE id = $1`,
    [chatId],
  );
  return res.rows[0]?.is_assistant_thread === true;
}
