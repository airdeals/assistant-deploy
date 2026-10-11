import { createHmac, timingSafeEqual } from "node:crypto";
import type { DataSource } from "../db/dataSource.js";
import type { RawMessageEvent } from "../contracts/events.js";
import { insertMessageBatch, upsertChat, type BatchInsertResult } from "../db/repos/ingestRepo.js";

/**
 * Webhook-приёмник WA-2 (WhatsApp coexistence / Cloud API), G4.
 * - верификация X-Hub-Signature-256: HMAC-SHA256 по app secret,
 *   константное сравнение (timingSafeEqual);
 * - чужой/невалидная подпись → 401 (AT-21), без подсказок;
 * - разбор типов: messages (входящие), smb_message_echoes (свои
 *   исходящие с телефона владельца), history (одноразовый бэкфилл),
 *   statuses (доставка — в ingest не идут, только считаются);
 * - маршрутизация в ingestRepo: идемпотентность — натуральный ключ
 *   (account_id, external_chat_id, message_id), повтор webhook/history
 *   не дублирует (AT-06).
 */

/** Проверка подписи Meta. header: "sha256=<hex>". Константное сравнение. */
export function verifyWa2Signature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const actual = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual требует равной длины; при разной — подпись заведомо плохая.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asRecordArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => asRecord(x) !== null) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function dateFromTs(v: unknown): Date {
  const n = Number(v);
  // WA timestamp — секунды unix.
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** Текст сообщения: text.body либо caption медиа; медиа — mediaRefs. */
function extractTextAndMedia(m: Record<string, unknown>): { text: string; mediaRefs?: RawMessageEvent["mediaRefs"] } {
  const type = str(m.type);
  const textRec = asRecord(m.text);
  if (type === "text" && textRec) {
    return { text: str(textRec.body) };
  }
  const mediaRec = asRecord(m[type]);
  const mediaRefs: NonNullable<RawMessageEvent["mediaRefs"]> = [];
  const id = mediaRec ? str(mediaRec.id) : "";
  const mime = mediaRec ? str(mediaRec.mime_type) : "";
  if (id) {
    mediaRefs.push({ externalId: id, ...(mime ? { mime } : {}) });
  }
  return { text: mediaRec ? str(mediaRec.caption) : "", ...(mediaRefs.length > 0 ? { mediaRefs } : {}) };
}

/** Входящее сообщение WhatsApp → RawMessageEvent. */
function normalizeInbound(m: Record<string, unknown>): RawMessageEvent {
  const from = str(m.from);
  const { text, mediaRefs } = extractTextAndMedia(m);
  const event: RawMessageEvent = {
    externalChatId: from,
    externalMessageId: str(m.id),
    authorExternalId: from,
    direction: "in",
    sentAt: dateFromTs(m.timestamp),
    text,
  };
  if (mediaRefs !== undefined) event.mediaRefs = mediaRefs;
  return event;
}

/** smb_message_echoes — свои исходящие, отправленные с телефона (WA-2). */
function normalizeEcho(m: Record<string, unknown>): RawMessageEvent {
  const to = str(m.to);
  const { text, mediaRefs } = extractTextAndMedia(m);
  const event: RawMessageEvent = {
    externalChatId: to,
    externalMessageId: str(m.message_id ?? m.id),
    authorExternalId: "me",
    direction: "out",
    sentAt: dateFromTs(m.timestamp),
    text,
  };
  if (mediaRefs !== undefined) event.mediaRefs = mediaRefs;
  return event;
}

export interface Wa2ParseResult {
  /** Входящие + echo + history — всё, что маршрутизируется в ingest. */
  messages: RawMessageEvent[];
  /** Число статусов доставки (в ingest не идут). */
  statuses: number;
  /** Нераспознанные блоки (для наблюдаемости, не ошибка). */
  skipped: number;
}

/**
 * Разбор тела webhook. Формат: entry[].changes[].value.{messages,statuses,smb_message_echoes}.
 * History-бэкфилл coexistence приходит тем же массивом messages — обрабатывается
 * идемпотентно на уровне ingest (AT-06).
 */
export function parseWa2Payload(payload: unknown): Wa2ParseResult {
  const result: Wa2ParseResult = { messages: [], statuses: 0, skipped: 0 };
  const root = asRecord(payload);
  if (!root) return { ...result, skipped: 1 };
  const entries = asRecordArray(root.entry);
  if (entries.length === 0) result.skipped += 1;
  for (const entry of entries) {
    for (const change of asRecordArray(entry.changes)) {
      const value = asRecord(change.value);
      if (!value) {
        result.skipped += 1;
        continue;
      }
      for (const m of asRecordArray(value.messages)) result.messages.push(normalizeInbound(m));
      for (const m of asRecordArray(value.smb_message_echoes)) result.messages.push(normalizeEcho(m));
      result.statuses += asRecordArray(value.statuses).length;
    }
  }
  return result;
}

export interface Wa2WebhookDeps {
  ds: DataSource;
  accountId: string;
}

export interface Wa2IngestOutcome extends BatchInsertResult {
  statuses: number;
  chats: number;
}

/**
 * Запись разобранных событий: группировка по чатам, upsertChat,
 * батч-вставка одной транзакцией на чат. Идемпотентно (AT-06).
 */
export async function handleWa2Webhook(deps: Wa2WebhookDeps, parsed: Wa2ParseResult): Promise<Wa2IngestOutcome> {
  const byChat = new Map<string, RawMessageEvent[]>();
  for (const ev of parsed.messages) {
    const list = byChat.get(ev.externalChatId) ?? [];
    list.push(ev);
    byChat.set(ev.externalChatId, list);
  }

  const outcome: Wa2IngestOutcome = {
    inserted: 0, updated: 0, duplicates: 0, total: 0, statuses: parsed.statuses, chats: byChat.size,
  };
  for (const [externalChatId, events] of byChat) {
    const chat = await upsertChat(deps.ds, deps.accountId, externalChatId, { type: "direct" });
    const res = await insertMessageBatch(
      deps.ds,
      chat.id,
      events.map((e) => ({
        accountId: deps.accountId,
        externalChatId,
        externalMessageId: e.externalMessageId,
        author: e.authorExternalId,
        direction: e.direction,
        sentAt: e.sentAt,
        text: e.text,
        editedAt: e.editedAt ?? null,
        deletedAt: e.deletedAt ?? null,
        isSystem: e.isSystem ?? false,
      })),
    );
    outcome.inserted += res.inserted;
    outcome.updated += res.updated;
    outcome.duplicates += res.duplicates;
    outcome.total += res.total;
  }
  return outcome;
}
