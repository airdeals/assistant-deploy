import type { MessageDirection } from "../contracts/events.js";

/**
 * Идемпотентная нормализация событий сообщений (AT-06).
 * Натуральный ключ: (account_id, external_chat_id, external_message_id).
 * Повтор webhook или повторный импорт не создаёт дублей.
 * Правка сообщения создаёт Revision и помечает зависимые выводы
 * инвалидированными (флаг invalidated).
 * Хранилище in-memory: на этапе G1 нет БД, контракт повторяет будущую схему.
 */

export interface IngestEvent {
  accountId: string;
  externalChatId: string;
  externalMessageId: string;
  authorExternalId: string;
  direction: MessageDirection;
  sentAt: Date;
  text: string;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  isSystem?: boolean;
}

export interface Revision {
  seq: number;
  kind: "edit" | "delete" | "restore";
  prevText: string;
  newText: string;
  at: Date;
}

export interface StoredMessage {
  accountId: string;
  chatId: string;
  messageId: string;
  authorExternalId: string;
  direction: MessageDirection;
  sentAt: Date;
  text: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  isSystem: boolean;
  revisions: Revision[];
  /** true, если после последнего вывода агента сообщение менялось. */
  invalidated: boolean;
}

export type IngestResult =
  | { status: "created"; message: StoredMessage }
  | { status: "duplicate"; message: StoredMessage }
  | { status: "edited"; message: StoredMessage; revision: Revision }
  | { status: "deleted"; message: StoredMessage; revision: Revision };

export function naturalKey(accountId: string, chatId: string, messageId: string): string {
  return `${accountId}${chatId}${messageId}`;
}

export class IngestStore {
  private readonly byKey = new Map<string, StoredMessage>();

  ingest(event: IngestEvent, now: Date = new Date()): IngestResult {
    const key = naturalKey(event.accountId, event.externalChatId, event.externalMessageId);
    const existing = this.byKey.get(key);

    if (!existing) {
      const msg: StoredMessage = {
        accountId: event.accountId,
        chatId: event.externalChatId,
        messageId: event.externalMessageId,
        authorExternalId: event.authorExternalId,
        direction: event.direction,
        sentAt: event.sentAt,
        text: event.text,
        editedAt: event.editedAt ?? null,
        deletedAt: event.deletedAt ?? null,
        isSystem: event.isSystem ?? false,
        revisions: [],
        invalidated: false,
      };
      this.byKey.set(key, msg);
      return { status: "created", message: msg };
    }

    // Удаление
    const wantsDeleted = (event.deletedAt ?? null) !== null;
    if (wantsDeleted && existing.deletedAt === null) {
      const revision: Revision = {
        seq: existing.revisions.length + 1,
        kind: "delete",
        prevText: existing.text,
        newText: "",
        at: event.deletedAt ?? now,
      };
      existing.revisions.push(revision);
      existing.deletedAt = event.deletedAt ?? now;
      existing.invalidated = true;
      return { status: "deleted", message: existing, revision };
    }

    // Правка текста
    if (existing.deletedAt === null && event.text !== existing.text) {
      const revision: Revision = {
        seq: existing.revisions.length + 1,
        kind: "edit",
        prevText: existing.text,
        newText: event.text,
        at: event.editedAt ?? now,
      };
      existing.revisions.push(revision);
      existing.text = event.text;
      existing.editedAt = event.editedAt ?? now;
      existing.invalidated = true;
      return { status: "edited", message: existing, revision };
    }

    // Полностью идентичное повторное событие (webhook дубль / повтор импорта).
    return { status: "duplicate", message: existing };
  }

  get(accountId: string, chatId: string, messageId: string): StoredMessage | undefined {
    return this.byKey.get(naturalKey(accountId, chatId, messageId));
  }

  /** Снять флаг инвалидации после пересчёта зависимых выводов. */
  markValid(message: StoredMessage): void {
    message.invalidated = false;
  }

  count(): number {
    return this.byKey.size;
  }

  all(): StoredMessage[] {
    return [...this.byKey.values()];
  }
}
