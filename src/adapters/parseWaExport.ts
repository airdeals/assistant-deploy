import type { MessageDirection } from "../contracts/events.js";

/** Одно распознанное сообщение из текстового экспорта WhatsApp. */
export interface WaParsedMessage {
  author: string;
  direction: MessageDirection;
  sentAt: Date;
  text: string;
  isSystem: boolean;
}

export interface WaParseResult {
  /** Заголовок чата (строки до первой записи в квадратных скобках), если есть. */
  chatTitle: string | null;
  messages: WaParsedMessage[];
}

export interface WaParseOptions {
  /** Собственное отображаемое имя владельца (для направления "out"). */
  ownName?: string | undefined;
  /** Собственный номер владельца (для направления "out"). */
  ownNumber?: string | undefined;
  /**
   * Формат даты: "auto" (по умолчанию), "dmy" (dd.mm.yyyy) или "mdy" (mm/dd/yyyy).
   * В режиме auto: если первая компонента > 12 — это день; иначе если вторая > 12 — месяц/день;
   * если обе ≤ 12, используется "dmy".
   */
  dateLocale?: "auto" | "dmy" | "mdy";
  /** Включить системные записи в результат (по умолчанию false — пропускаются). */
  includeSystem?: boolean;
}

const MESSAGE_RE = /^\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+(AM|PM))?\]\s*(.*)$/;

const SYSTEM_PHRASES = [
  "messages and calls are end-to-end encrypted",
  "messages are end-to-end encrypted",
  "changed the subject",
  "changed this group's icon",
  "changed the group name",
  "created group",
  "you created group",
  "added you",
  "you were added",
  "added ",
  "removed ",
  "left",
  "joined using this group's invite link",
  "joined using an invite link",
  "security code changed",
  "disappearing messages",
  "changed their phone number",
  "is a business account",
  "turned on read receipts",
  "this message was deleted",
  "pinned a message",
  "via a link in the chat",
  "создал группу",
  "создала группу",
  "изменил тему",
  "изменила тему",
  "изменил(а) тему",
  "изменил название",
  "изменила название",
  "покинул группу",
  "покинула группу",
  "присоединился",
  "присоединилась",
  "присоединился(ась) по ссылке",
  "код безопасности изменился",
  "исходящие сообщения",
  "изменил(а) номер телефона",
  "это сообщение было удалено",
  "закрепил(а) сообщение",
];

function isSystemRecord(author: string, text: string): boolean {
  const full = `${author}: ${text}`.toLowerCase();
  return SYSTEM_PHRASES.some((p) => full.startsWith(p) || full.includes(p));
}

function normalizeNumber(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

function resolveDirection(author: string, opts: WaParseOptions): MessageDirection {
  const trimmed = author.trim();
  if (/^(you|вы)$/i.test(trimmed)) return "out";
  if (opts.ownName && trimmed.toLowerCase() === opts.ownName.trim().toLowerCase()) return "out";
  if (opts.ownNumber) {
    const a = normalizeNumber(trimmed);
    const b = normalizeNumber(opts.ownNumber);
    if (a.length > 0 && b.length > 0 && (a === b || a.endsWith(b) || b.endsWith(a))) return "out";
  }
  return "in";
}

function resolveDateLocale(a: number, b: number, opts: WaParseOptions): "dmy" | "mdy" {
  if (opts.dateLocale && opts.dateLocale !== "auto") return opts.dateLocale;
  if (a > 12) return "dmy";
  if (b > 12) return "mdy";
  return "dmy";
}

function parseDate(m: RegExpMatchArray, opts: WaParseOptions): Date | null {
  const a = Number(m[1]);
  const b = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const locale = resolveDateLocale(a, b, opts);
  const day = locale === "dmy" ? a : b;
  const month = locale === "dmy" ? b : a;
  const hour24 = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ampm = m[7]?.toUpperCase();

  let hour = hour24;
  if (ampm === "AM") {
    if (hour === 12) hour = 0;
  } else if (ampm === "PM") {
    if (hour !== 12) hour += 12;
  } else if (hour24 > 23) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Чистая функция: текст экспорта WhatsApp -> структурированные сообщения.
 * Разбирает формат "[dd.mm.yyyy, hh:mm:ss] Имя: текст", обе локали дат
 * (24-часовая и AM/PM), многострочные сообщения (продолжение присоединяется
 * к предыдущему через "\n"), пропускает системные записи (опционально).
 * Без I/O и внешних зависимостей.
 */
export function parseWaExport(input: string, opts: WaParseOptions = {}): WaParseResult {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const chatTitleLines: string[] = [];
  const messages: WaParsedMessage[] = [];
  let current: WaParsedMessage | null = null;

  const flush = (includeSystem: boolean) => {
    if (current && (includeSystem || !current.isSystem)) {
      messages.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/‎/g, "").trimEnd();
    if (line.trim().length === 0) continue;

    const m = line.match(MESSAGE_RE);
    if (m) {
      flush(opts.includeSystem === true);
      const sentAt = parseDate(m, opts);
      const rest = m[8] ?? "";
      const colonIdx = rest.indexOf(": ");
      const author = colonIdx === -1 ? rest.trim() : rest.slice(0, colonIdx).trim();
      const text = colonIdx === -1 ? "" : rest.slice(colonIdx + 2);
      const isSystem = isSystemRecord(author, text);
      if (!sentAt) continue; // неразбираемая дата — пропускаем строку-запись
      current = {
        author,
        direction: resolveDirection(author, opts),
        sentAt,
        text,
        isSystem,
      };
    } else {
      if (current) {
        // Многострочное продолжение предыдущего сообщения.
        current.text = current.text.length === 0 ? line : `${current.text}\n${line}`;
        if (isSystemRecord(current.author, current.text)) current.isSystem = true;
      } else if (line.trimStart().startsWith("[") && isSystemRecord("", line)) {
        // Системная запись без автора/даты («[Messages and calls are end-to-end…]»):
        // не заголовок чата, а служебное сообщение.
        current = {
          author: "",
          direction: "in",
          sentAt: messages.length > 0 ? (messages[messages.length - 1]!.sentAt ?? new Date(0)) : new Date(0),
          text: line.trim(),
          isSystem: true,
        };
      } else {
        // Заголовок чата (до первой записи в скобках).
        chatTitleLines.push(line);
      }
    }
  }
  flush(opts.includeSystem === true);

  const chatTitle = chatTitleLines.length > 0 ? chatTitleLines.join("\n").trim() : null;
  return { chatTitle, messages };
}
