/**
 * Нормализованное сырое событие сообщения, единое для всех источников.
 * Адаптеры приводят свои форматы к этой структуре; дальше работает core/ingest.
 */

export type MessageDirection = "in" | "out";

export interface MediaRef {
  /** Идентификатор вложения во внешней системе. */
  externalId: string;
  /** MIME-тип, если известен. */
  mime?: string;
  /** Имя файла, если известно. */
  fileName?: string;
}

export interface RawMessageEvent {
  externalChatId: string;
  externalMessageId: string;
  /** Внешний идентификатор автора (id/телефон), не отображаемое имя. */
  authorExternalId: string;
  direction: MessageDirection;
  /** UTC. */
  sentAt: Date;
  text: string;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  isSystem?: boolean;
  mediaRefs?: MediaRef[];
}
