import type { RawMessageEvent } from "./events.js";

/**
 * ADR-001: интерфейс SourceAdapter.
 * Каждый адаптер явно декларирует capabilities. Неподдерживаемая операция
 * обязан бросать UnsupportedOperationError — никаких «тихих» заглушек,
 * возвращающих пустой результат.
 */

export type AdapterState =
  | "not_configured"   // нет учётных данных / конфигурации
  | "connecting"       // установка соединения
  | "importing"        // идёт разовый импорт истории
  | "live"             // активный канал событий
  | "degraded"         // работает частично (есть known_gaps)
  | "disconnected"     // соединение завершено/потеряно
  | "import_only";     // только импорт, live-канал недоступен

export interface AdapterCapabilities {
  /** live-подписка/поллинг событий. */
  liveEvents: boolean;
  /** выборка истории через fetchHistory (бэкфилл). */
  historyBackfill: boolean;
  /** импорт истории из экспортированного файла (через парсеры импорта). */
  historyImport: boolean;
  mediaDownload: boolean;
  sendMessages: boolean;
  editTracking: boolean;
  deleteTracking: boolean;
}

/** Курсор истории — непрозрачная строка, специфичная для адаптера. */
export interface HistoryCursor {
  value: string | null;
}

export interface FetchHistoryResult {
  events: RawMessageEvent[];
  /** null — история выбрана целиком. */
  nextCursor: HistoryCursor | null;
}

export interface MediaDownloadResult {
  ref: string;
  mime: string;
  bytes: Uint8Array;
}

/** Явная ошибка «операция не поддерживается адаптером». */
export class UnsupportedOperationError extends Error {
  readonly adapter: string;
  readonly operation: string;

  constructor(adapter: string, operation: string) {
    super(`Adapter "${adapter}" does not support operation "${operation}"`);
    this.name = "UnsupportedOperationError";
    this.adapter = adapter;
    this.operation = operation;
  }
}

export interface SourceAdapter {
  /** Стабильное имя адаптера, например "wa1". */
  readonly name: string;

  getCapabilities(): AdapterCapabilities;
  getState(): AdapterState;

  /** Выборка истории. Обязан бросать UnsupportedOperationError, если capabilities.historyBackfill === false. */
  fetchHistory(cursor: HistoryCursor): Promise<FetchHistoryResult>;

  /**
   * Подписка на live-события. Адаптеры, у которых возможен только поллинг,
   * могут реализовывать streamEvents() поверх pollEvents().
   */
  streamEvents(): AsyncIterable<RawMessageEvent>;

  /** Разовый опрос новых событий. */
  pollEvents(): Promise<RawMessageEvent[]>;

  /** Скачивание вложения. Обязан бросать UnsupportedOperationError, если mediaDownload === false. */
  downloadMedia(ref: string): Promise<MediaDownloadResult>;

  /** Завершение соединения. Безопасно вызывать повторно. */
  disconnect(): Promise<void>;
}
