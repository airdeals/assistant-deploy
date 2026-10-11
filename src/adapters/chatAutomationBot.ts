import { NotConfiguredAdapter } from "./base.js";
import type { AdapterCapabilities } from "../contracts/adapter.js";
import type { RawMessageEvent } from "../contracts/events.js";

/**
 * Резервный канал Telegram Chat Automation (бизнес-бот), G4.
 * Разбор updateBotNew/Edit/DeleteBusinessMessage → RawMessageEvent → ingest.
 * По контракту Bot API истории чатов НЕТ — historyBackfill = false,
 * fetchHistory бросает UnsupportedOperationError (ADR-001: никаких тихих
 * заглушек). Live-события приходят webhook-пушем: caller прогоняет
 * сырые update'ы через ingestUpdates().
 */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** message бизнес-бота → RawMessageEvent (чат = business_connection + user). */
function normalizeBusinessMessage(businessConnectionId: string, msg: Record<string, unknown>, kind: "new" | "edit", now: Date): RawMessageEvent | null {
  const chat = asRecord(msg.chat);
  if (!chat) return null;
  const chatUserId = num(chat.id);
  const from = asRecord(msg.from);
  const senderId = from ? num(from.id) || str(from.id) : chatUserId;
  const text = extractBusinessText(msg);
  const event: RawMessageEvent = {
    externalChatId: `biz:${businessConnectionId}:${chatUserId}`,
    externalMessageId: String(num(msg.message_id)),
    authorExternalId: String(senderId),
    direction: "in",
    sentAt: typeof msg.date === "number" ? new Date(msg.date * 1000) : now,
    text,
  };
  if (kind === "edit") event.editedAt = now;
  return event;
}

function extractBusinessText(msg: Record<string, unknown>): string {
  const entities = [
    asRecord(msg.text), asRecord(msg.caption),
    ...((Array.isArray(msg.text) ? msg.text : []) as unknown[]).map((x) => asRecord(x)),
  ];
  for (const e of entities) {
    if (!e) continue;
    if (typeof e.body === "string") return e.body;
    if (typeof e.text === "string") return e.text;
  }
  return "";
}

/**
 * Один update Bot API → RawMessageEvent[] (delete порождёт событие на
 * каждый message_id). Неизвестные типы — пустой массив.
 */
export function normalizeBusinessUpdate(update: unknown, now: Date = new Date()): RawMessageEvent[] {
  const u = asRecord(update);
  if (!u) return [];
  const type = str(u.update_type ?? u["@type"]);

  if (type === "updateBotNewBusinessMessage" || type === "updateBotEditBusinessMessage") {
    const conn = asRecord(u.business_connection) ?? asRecord(u.business_connection_id ? { id: u.business_connection_id } : null);
    const businessConnectionId = conn ? str(conn.id) : "";
    const msg = asRecord(u.message);
    if (!msg || !businessConnectionId) return [];
    const ev = normalizeBusinessMessage(
      businessConnectionId,
      msg,
      type === "updateBotEditBusinessMessage" ? "edit" : "new",
      now,
    );
    return ev ? [ev] : [];
  }

  if (type === "updateBotDeleteBusinessMessage") {
    const conn = asRecord(u.business_connection) ?? (u.business_connection_id ? { id: u.business_connection_id } : null);
    const businessConnectionId = conn ? str(conn.id) : "";
    const chat = asRecord(u.chat);
    const chatUserId = chat ? num(chat.id) : 0;
    const ids = Array.isArray(u.message_ids) ? (u.message_ids as unknown[]) : [];
    if (!businessConnectionId) return [];
    return ids
      .filter((x): x is number => typeof x === "number")
      .map((id) => {
        const ev: RawMessageEvent = {
          externalChatId: `biz:${businessConnectionId}:${chatUserId}`,
          externalMessageId: String(id),
          authorExternalId: "unknown",
          direction: "in",
          sentAt: now,
          text: "",
          deletedAt: now,
        };
        return ev;
      });
  }

  return [];
}

/** Пакет update'ов webhook — всё, что распозналось. */
export function ingestUpdates(updates: unknown[], now: Date = new Date()): RawMessageEvent[] {
  return updates.flatMap((u) => normalizeBusinessUpdate(u, now));
}

export class ChatAutomationBotAdapter extends NotConfiguredAdapter {
  readonly name = "tg-chat-automation";

  private static readonly caps: AdapterCapabilities = {
    liveEvents: true,           // push через webhook
    historyBackfill: false,     // по контракту API истории нет
    historyImport: false,
    mediaDownload: false,
    sendMessages: false,
    editTracking: true,
    deleteTracking: true,
  };

  getCapabilities(): AdapterCapabilities {
    return { ...ChatAutomationBotAdapter.caps };
  }
  // fetchHistory/pollEvents/downloadMedia — UnsupportedOperationError
  // из базового NotConfiguredAdapter (ADR-001).
}
