import { createHash } from "node:crypto";

/**
 * Провайдеры эмбеддингов (G2-4, активация отложена протоколом G0-6).
 * Интерфейс минимален: embed(texts) -> векторы, model — имя модели,
 * записываемое в message_embeddings. Реальная активация — конфигурацией;
 * в тестах только MockEmbeddingProvider. Никаких ключей в коде: apiKey
 * и baseUrl — только из конфига/env.
 */

export interface EmbeddingProvider {
  /** Имя модели, идентифицирует вектор в message_embeddings. */
  readonly model: string;
  /** Векторы в том же порядке, что и входные тексты. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Детерминированный мок: вектор — псевдослучайные значения из sha256 текста.
 * Одинаковый текст → одинаковый вектор; похожие тексты НЕ близки
 * (мок не имитирует семантику, только контракт). Для тестов.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;

  constructor(opts: { dim?: number; model?: string } = {}) {
    this.dim = opts.dim ?? 1536;
    this.model = opts.model ?? `mock-${this.dim}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorFor(t));
  }

  vectorFor(text: string): number[] {
    const out = new Array<number>(this.dim);
    // 32 байта хеша растягиваем на dim измерений с повторным хешированием.
    let seed = createHash("sha256").update(text, "utf8").digest();
    for (let i = 0; i < this.dim; i++) {
      if (i > 0 && i % 32 === 0) {
        seed = createHash("sha256").update(seed).update(String(i)).digest();
      }
      out[i] = seed[i % 32]! / 128 - 1;
    }
    return out;
  }
}

export interface OpenAiCompatibleEmbeddingsConfig {
  /** Базовый URL без /embeddings, например https://api.example.com/v1. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Максимум токенов на батч (по умолчанию 2048). */
  maxTokensPerBatch?: number;
  maxRetries?: number;
  /** Для тестов/кастомного рантайма. */
  fetchImpl?: typeof fetch;
  /** backoff-сон, инжектируется (по умолчанию setTimeout). */
  sleepMs?: (ms: number) => Promise<void>;
}

interface OpenAiEmbeddingsResponse {
  data?: { embedding?: number[] }[];
}

/** Грубая оценка токенов: ~4 символа на токен. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Провайдер к OpenAI-совместимому /embeddings endpoint.
 * Batching: вход режется на батчи ≤ maxTokensPerBatch токенов.
 * Повторы: 429/5xx → экспоненциальный backoff, максимум maxRetries попыток
 * на батч. НЕ используется в тестах.
 */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxTokensPerBatch: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepMs: (ms: number) => Promise<void>;

  constructor(cfg: OpenAiCompatibleEmbeddingsConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.maxTokensPerBatch = cfg.maxTokensPerBatch ?? 2048;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.sleepMs = cfg.sleepMs ?? defaultSleep;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;
    for (const t of texts) {
      const tokens = estimateTokens(t);
      if (current.length > 0 && currentTokens + tokens > this.maxTokensPerBatch) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(t);
      currentTokens += tokens;
    }
    if (current.length > 0) batches.push(current);

    const out: number[][] = [];
    for (const batch of batches) {
      const vectors = await this.embedBatchWithRetry(batch);
      out.push(...vectors);
    }
    return out;
  }

  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        return await this.embedBatch(batch);
      } catch (e) {
        lastError = e as Error;
        // Неретраябельные 4xx не повторяем.
        if ((e as { retriable?: boolean }).retriable === false) break;
        if (attempt > this.maxRetries) break;
        await this.sleepMs(1000 * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new Error("embeddings request failed");
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: batch }),
    });
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`embeddings HTTP ${res.status}`);
    }
    if (!res.ok) {
      // 4xx (кроме 429) — повторы бесполезны, но контракт retry решает;
      // бросаем неретраябельную ошибку с маркером.
      const err = new Error(`embeddings HTTP ${res.status}`) as Error & { retriable?: boolean };
      err.retriable = false;
      throw err;
    }
    const json = (await res.json()) as OpenAiEmbeddingsResponse;
    const data = json.data ?? [];
    if (data.length !== batch.length) {
      throw new Error(`embeddings: expected ${batch.length} vectors, got ${data.length}`);
    }
    return data.map((d, i) => {
      const v = d.embedding;
      if (!v || v.length === 0) throw new Error(`embeddings: empty vector at index ${i}`);
      return v;
    });
  }
}
