import { randomUUID } from "node:crypto";
import type { DataSource } from "./db/dataSource.js";
import { insertMessageBatch, upsertChat, type IngestMessageEvent } from "./db/repos/ingestRepo.js";
import { parseTgExport, type TgParsedMessage } from "./adapters/parseTgExport.js";
import { parseWaExport, type WaParsedMessage } from "./adapters/parseWaExport.js";
import type { MessageDirection } from "./contracts/events.js";

/**
 * Импортный пайплайн: файл/поток → парсер (parseWaExport/parseTgExport)
 * → нормализация → ingestRepo (транзакция на батч, ON CONFLICT без дублей).
 * Прогресс и ошибки фиксируются в import_batches.
 */

export type ImportFormat = "wa" | "tg";

export interface ImportFileInput {
  /** Содержимое экспортированного файла. */
  content: string;
  /** Внешний id чата; по умолчанию — из заголовка/имени чата. */
  chatExternalId?: string | undefined;
  title?: string | null | undefined;
  /** WA: ownName/ownNumber для направления сообщений. */
  waOptions?: { ownName?: string | undefined; ownNumber?: string | undefined } | undefined;
  /** TG: ownSenderId для направления сообщений. */
  tgOptions?: { ownSenderId?: string | undefined } | undefined;
}

export interface ImportReport {
  batchId: string;
  status: "done" | "failed";
  total: number;
  inserted: number;
  updated: number;
  duplicates: number;
  errors: string[];
  chats: { externalChatId: string; internalChatId: string }[];
}

export interface ProgressEvent {
  done: number;
  total: number;
  chatExternalId: string;
}

function stableChatId(seed: string): string {
  // Детерминированный внешний id чата из заголовка (64 бита hex).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `chat-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function waToEvent(accountId: string, chatId: string, m: WaParsedMessage): IngestMessageEvent {
  const author = m.author.trim().length > 0 ? m.author.trim() : "system";
  return {
    accountId,
    externalChatId: chatId,
    externalMessageId: `${chatId}:${m.sentAt.getTime()}:${author}`,
    author,
    direction: m.direction,
    sentAt: m.sentAt,
    text: m.text,
    isSystem: m.isSystem,
  };
}

function tgToEvent(accountId: string, chatId: string, m: TgParsedMessage): IngestMessageEvent {
  const author = m.senderId ?? m.senderName ?? "unknown";
  return {
    accountId,
    externalChatId: chatId,
    externalMessageId: `tg-${m.id}`,
    author,
    direction: (m.senderId ? m.direction : "in") as MessageDirection,
    sentAt: m.sentAt,
    text: m.text,
    isSystem: m.type === "service",
  };
}

/**
 * Импорт одного батча (1..N файлов одного формата и аккаунта).
 * Каждый файл = один чат. Повторный запуск с теми же данными —
 * только duplicates (AT-06).
 */
export async function importFiles(
  ds: DataSource,
  opts: {
    accountId: string;
    format: ImportFormat;
    files: ImportFileInput[];
    onProgress?: (p: ProgressEvent) => void;
  },
): Promise<ImportReport> {
  const batchId = randomUUID();
  const report: ImportReport = {
    batchId,
    status: "failed",
    total: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    errors: [],
    chats: [],
  };
  await ds.query(
    `INSERT INTO import_batches (id, account_id, status, stats) VALUES ($1, $2, 'running', '{}'::jsonb)`,
    [batchId, opts.accountId],
  );
  try {
    for (const file of opts.files) {
      try {
        let title: string | null = file.title ?? null;
        if (opts.format === "wa") {
          title = parseWaExport(file.content, file.waOptions).chatTitle ?? title;
        } else {
          const parsedTg = parseTgExport(file.content, file.tgOptions);
          title = parsedTg.chatName ?? title;
        }
        const chatExternalId =
          file.chatExternalId ?? stableChatId(title ?? file.content.slice(0, 64));

        const chat = await upsertChat(ds, opts.accountId, chatExternalId, {
          title,
          type: "direct",
        });
        report.chats.push({ externalChatId: chatExternalId, internalChatId: chat.id });

        const events: IngestMessageEvent[] = [];
        if (opts.format === "wa") {
          const parsed = parseWaExport(file.content, file.waOptions);
          for (const m of parsed.messages) events.push(waToEvent(opts.accountId, chatExternalId, m));
        } else {
          const parsed = parseTgExport(file.content, file.tgOptions);
          for (const m of parsed.messages) events.push(tgToEvent(opts.accountId, chatExternalId, m));
        }

        let done = 0;
        const progress = opts.onProgress;
        const CHUNK = 500;
        for (let i = 0; i < events.length; i += CHUNK) {
          const chunk = events.slice(i, i + CHUNK);
          const r = await insertMessageBatch(ds, chat.id, chunk);
          report.total += r.total;
          report.inserted += r.inserted;
          report.updated += r.updated;
          report.duplicates += r.duplicates;
          done += chunk.length;
          progress?.({ done, total: events.length, chatExternalId });
        }
      } catch (e) {
        report.errors.push(`${file.chatExternalId ?? "file"}: ${(e as Error).message}`);
      }
    }
    report.status = report.errors.length > 0 && report.total === 0 ? "failed" : "done";
    await ds.query(
      `UPDATE import_batches SET status = $1, stats = $2, finished_at = now() WHERE id = $3`,
      [report.status, JSON.stringify({ total: report.total, inserted: report.inserted, updated: report.updated, duplicates: report.duplicates }), batchId],
    );
    return report;
  } catch (e) {
    await ds.query(
      `UPDATE import_batches SET status = 'failed', stats = $1, finished_at = now() WHERE id = $2`,
      [JSON.stringify({ error: (e as Error).message }), batchId],
    );
    throw e;
  }
}
