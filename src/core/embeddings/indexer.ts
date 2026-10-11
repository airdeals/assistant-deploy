import type { Queryable } from "../../db/dataSource.js";
import type { EmbeddingProvider } from "./provider.js";
import {
  deleteEmbeddingsForMessage,
  EMBEDDING_DIM,
  selectPendingEmbeddings,
  upsertEmbedding,
} from "../../db/repos/embeddingsRepo.js";

/**
 * Джоба индексации эмбеддингов (G2-4).
 * - выбирает сообщения без вектора текущей модели;
 * - эмбеддит батчами через EmbeddingProvider;
 * - upsert в message_embeddings;
 * - контроль размерности: вектор провайдера обязан совпадать с колонкой
 *   vector(1536), иначе EmbeddingDimensionError (не пишем мусор в БД);
 * - edit/delete: invalidate() удаляет вектор, следующий прогон
 *   переиндексирует по актуальному тексту (ТЗ §7: изменение инвалидирует
 *   зависимые выводы — флаг messages.invalidated ставит ingestRepo).
 */

export class EmbeddingDimensionError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`Embedding dimension mismatch: expected ${expected}, got ${actual}`);
    this.name = "EmbeddingDimensionError";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface IndexerOptions {
  /** Размерность колонки vector(N); по умолчанию EMBEDDING_DIM (1536). */
  expectedDim?: number;
  /** Сколько сообщений берём за прогон (размер окна выборки). */
  windowSize?: number;
  /** Сколько текстов шлём провайдеру за один embed() вызов. */
  providerBatchSize?: number;
}

export interface IndexStats {
  /** Выбрано сообщений без вектора текущей модели. */
  selected: number;
  /** Успешно записано векторов. */
  embedded: number;
  /** Число вызовов провайдера. */
  providerCalls: number;
}

export class EmbeddingIndexer {
  private readonly expectedDim: number;
  private readonly windowSize: number;
  private readonly providerBatchSize: number;

  constructor(
    private readonly q: Queryable,
    private readonly provider: EmbeddingProvider,
    opts: IndexerOptions = {},
  ) {
    this.expectedDim = opts.expectedDim ?? EMBEDDING_DIM;
    this.windowSize = opts.windowSize ?? 100;
    this.providerBatchSize = opts.providerBatchSize ?? 16;
  }

  /** Один прогон: выборка → эмбеддинг → upsert. Возвращает статистику. */
  async runOnce(): Promise<IndexStats> {
    const pending = await selectPendingEmbeddings(this.q, this.provider.model, this.windowSize);
    const stats: IndexStats = { selected: pending.length, embedded: 0, providerCalls: 0 };

    for (let i = 0; i < pending.length; i += this.providerBatchSize) {
      const slice = pending.slice(i, i + this.providerBatchSize);
      const vectors = await this.provider.embed(slice.map((r) => r.text));
      stats.providerCalls += 1;
      if (vectors.length !== slice.length) {
        throw new Error(`provider returned ${vectors.length} vectors for ${slice.length} texts`);
      }
      for (let j = 0; j < slice.length; j++) {
        const vector = vectors[j]!;
        if (vector.length !== this.expectedDim) {
          throw new EmbeddingDimensionError(this.expectedDim, vector.length);
        }
        const row = slice[j]!;
        await upsertEmbedding(this.q, row.id, this.provider.model, vector);
        stats.embedded += 1;
      }
    }
    return stats;
  }

  /** Сообщение изменено/удалено — вектор снимаем, переиндексация позже. */
  async invalidate(messageId: string): Promise<void> {
    await deleteEmbeddingsForMessage(this.q, messageId);
  }
}
