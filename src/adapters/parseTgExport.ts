import type { MessageDirection } from "../contracts/events.js";

/** Одно распознанное сообщение из Telegram Desktop result.json. */
export interface TgParsedMessage {
  id: number;
  type: "message" | "service";
  senderId: string | null;
  senderName: string | null;
  direction: MessageDirection;
  sentAt: Date;
  text: string;
  replyToMessageId: number | null;
  forwardFrom: string | null;
  /** Имя .ogg-файла голосового сообщения, если есть. */
  mediaOgg: string | null;
}

export interface TgParseResult {
  chatName: string | null;
  chatType: string | null;
  chatId: number | null;
  messages: TgParsedMessage[];
}

export interface TgParseOptions {
  /** Внутренний идентификатор владельца в Telegram (направление "out"). */
  ownSenderId?: string | undefined;
  /** Включить служебные сообщения (по умолчанию false — пропускаются). */
  includeService?: boolean | undefined;
}

interface TgTextEntity {
  type?: string;
  text?: string;
}

interface TgRawMessage {
  id?: number;
  type?: string;
  date_unixtime?: string;
  date?: string;
  from?: string;
  from_id?: string;
  actor?: string;
  actor_id?: string;
  text?: string | TgTextEntity[];
  text_entities?: TgTextEntity[];
  reply_to_message_id?: number;
  forwarded_from?: string;
  forward_from?: string;
  file?: string;
  mime_type?: string;
}

interface TgRawExport {
  name?: string;
  type?: string;
  id?: number;
  messages?: TgRawMessage[];
}

function flattenText(raw: TgRawMessage): string {
  // При наличии text_entities они первичны; строковое text — производное.
  const entities = raw.text_entities ?? (Array.isArray(raw.text) ? raw.text : []);
  if (entities.length > 0) return entities.map((e) => e.text ?? "").join("");
  return typeof raw.text === "string" ? raw.text : "";
}

/**
 * Чистая функция: содержимое Telegram Desktop result.json (строка)
 * -> структурированные сообщения. Без I/O.
 */
export function parseTgExport(json: string, opts: TgParseOptions = {}): TgParseResult {
  let root: TgRawExport;
  try {
    root = JSON.parse(json) as TgRawExport;
  } catch (e) {
    throw new Error(`parseTgExport: invalid JSON: ${(e as Error).message}`);
  }
  if (root === null || typeof root !== "object" || !Array.isArray(root.messages)) {
    throw new Error("parseTgExport: expected Telegram Desktop export object with messages[]");
  }

  const messages: TgParsedMessage[] = [];
  for (const raw of root.messages) {
    const type = raw.type === "service" ? "service" : "message";
    if (type === "service" && opts.includeService !== true) continue;

    const senderId = raw.from_id ?? raw.actor_id ?? null;
    const senderName = raw.from ?? raw.actor ?? null;

    const unix = raw.date_unixtime ? Number(raw.date_unixtime) : NaN;
    let sentAt: Date;
    if (Number.isFinite(unix)) {
      sentAt = new Date(unix * 1000);
    } else if (raw.date) {
      sentAt = new Date(raw.date);
    } else {
      continue; // нет даты — не валидная запись
    }
    if (Number.isNaN(sentAt.getTime())) continue;

    const isVoiceOgg =
      typeof raw.file === "string" &&
      raw.file.toLowerCase().endsWith(".ogg");

    messages.push({
      id: raw.id ?? -1,
      type,
      senderId,
      senderName,
      direction:
        opts.ownSenderId && senderId === opts.ownSenderId ? "out" : "in",
      sentAt,
      text: flattenText(raw),
      replyToMessageId: raw.reply_to_message_id ?? null,
      forwardFrom: raw.forwarded_from ?? raw.forward_from ?? null,
      mediaOgg: isVoiceOgg ? raw.file ?? null : null,
    });
  }

  return {
    chatName: root.name ?? null,
    chatType: root.type ?? null,
    chatId: root.id ?? null,
    messages,
  };
}
