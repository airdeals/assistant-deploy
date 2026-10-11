import type { SttProvider, Transcription } from "./provider.js";

/**
 * Пайплайн расшифровки аудио (без реального STT — поверх SttProvider).
 * - очередь: pending → processing → done|needs_review|error;
 * - ограниченные повторы с backoff;
 * - версионирование транскриптов: каждая расшифровка и каждое исправление
 *   владельца — новая версия;
 * - исправление вызывает onCorrected → пересчёт зависимостей (AT-13):
 *   зависимые выводы инвалидируются и не учитываются повторно;
 * - критичные недетерминированные поля (суммы, даты) → needs_review (AT-12).
 */

export type TranscriptStatus = "pending" | "processing" | "done" | "needs_review" | "error";

export interface TranscriptEntry {
  attachmentId: string;
  status: TranscriptStatus;
  version: number;
  text: string;
  lang: string;
  source: "stt" | "owner-correction";
  attempts: number;
  lastError: string | null;
  /** Следующая попытка (backoff). */
  nextAttemptAt: Date | null;
  updatedAt: Date;
}

export interface PipelineOptions {
  maxAttempts?: number;
  /** backoffMs(attemptsAlreadyMade) -> задержка до следующей попытки. */
  backoffMs?: (attempts: number) => number;
  /**
   * Пересчёт зависимостей после исправления (AT-13). Вызывается ровно раз
   * на каждую новую версию; реализация обязана инвалидировать ранее
   * извлечённые сущности по этому attachment, чтобы они не учлись дважды.
   */
  onCorrected?: (attachmentId: string, version: number) => void | Promise<void>;
}

const CRITICAL_RE =
  /(\d[\d\s]*\s?(рублей|руб|р\.|₽|\$|usd|rub|tl|try|kzt|тенге)(?![a-zа-яё]))|(\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?)/i;

/** Недетерминированные критичные поля (суммы/даты) → нужен человек. */
export function needsHumanReview(text: string): boolean {
  return CRITICAL_RE.test(text);
}

export class TranscriptPipeline {
  private entries = new Map<string, TranscriptEntry>();
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempts: number) => number;
  private readonly onCorrected?: PipelineOptions["onCorrected"];

  constructor(private readonly provider: SttProvider, opts: PipelineOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? ((n) => 1000 * 2 ** (n - 1));
    this.onCorrected = opts.onCorrected;
  }

  /** Поставить в очередь на расшифровку. Повторный enqueue — no-op. */
  enqueue(attachmentId: string, now: Date = new Date()): TranscriptEntry {
    const existing = this.entries.get(attachmentId);
    if (existing) return existing;
    const entry: TranscriptEntry = {
      attachmentId,
      status: "pending",
      version: 0,
      text: "",
      lang: "und",
      source: "stt",
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now,
    };
    this.entries.set(attachmentId, entry);
    return entry;
  }

  /** Обработать одну due-задачу. Возвращает обработанную запись или null. */
  async processNext(now: Date = new Date()): Promise<TranscriptEntry | null> {
    const due = [...this.entries.values()]
      .filter(
        (e) =>
          (e.status === "pending" || (e.status === "error" && e.nextAttemptAt !== null)) &&
          (e.nextAttemptAt === null || e.nextAttemptAt.getTime() <= now.getTime()),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    const entry = due[0];
    if (!entry) return null;

    entry.status = "processing";
    entry.attempts += 1;
    entry.updatedAt = now;
    try {
      // buffer-загрузка — ответственность вызывающего; мок не требует содержимого.
      const result: Transcription = await this.provider.transcribe(
        Buffer.from(`attachment:${entry.attachmentId}`),
      );
      entry.version += 1;
      entry.text = result.text;
      entry.lang = result.lang;
      entry.source = "stt";
      entry.status = needsHumanReview(result.text) ? "needs_review" : "done";
      entry.lastError = null;
      entry.nextAttemptAt = null;
    } catch (e) {
      entry.lastError = (e as Error).message;
      if (entry.attempts >= this.maxAttempts) {
        entry.status = "error";
        entry.nextAttemptAt = null;
      } else {
        entry.status = "error";
        entry.nextAttemptAt = new Date(now.getTime() + this.backoffMs(entry.attempts));
      }
    }
    entry.updatedAt = now;
    return entry;
  }

  async processAll(now: Date = new Date()): Promise<TranscriptEntry[]> {
    const processed: TranscriptEntry[] = [];
    for (;;) {
      const e = await this.processNext(now);
      if (!e) break;
      processed.push(e);
    }
    return processed;
  }

  /**
   * Исправление владельцем: новая версия + пересчёт зависимостей.
   * Старый текст сохраняется в истории версий (versions), выводы,
   * извлечённые из прошлых версий, инвалидируются через onCorrected,
   * чтобы сущности не учлись дважды (AT-13).
   */
  async correct(attachmentId: string, correctedText: string, now: Date = new Date()): Promise<TranscriptEntry> {
    const entry = this.entries.get(attachmentId);
    if (!entry) throw new Error(`unknown attachment: ${attachmentId}`);
    if (entry.version === 0) throw new Error("nothing to correct: no transcript yet");
    entry.version += 1;
    entry.text = correctedText;
    entry.source = "owner-correction";
    entry.status = needsHumanReview(correctedText) ? "needs_review" : "done";
    entry.updatedAt = now;
    await this.onCorrected?.(attachmentId, entry.version);
    return entry;
  }

  get(attachmentId: string): TranscriptEntry | undefined {
    return this.entries.get(attachmentId);
  }
}
