import type { Queryable } from "../../db/dataSource.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { searchSimilar, type SemanticFilters } from "../../db/repos/embeddingsRepo.js";
import { listMessagesInPeriod, searchMessages, type EvidenceHit, type SearchFilters } from "../../db/repos/searchRepo.js";

/**
 * Гибридный поиск (G2-4): точный (searchRepo, ILIKE) ∪ векторный
 * (pgvector cosine, фильтры до выборки — FR-04), склейка по score
 * с явной пометкой источника хита. Векторные топ-N — НЕ замена полного
 * перечня: за полнотой периода — listMessagesInPeriod (FR-04).
 */

export type HitSource = "exact" | "semantic";

export interface HybridHit extends EvidenceHit {
  score: number;
  source: HitSource;
}

export interface HybridSearchDeps {
  q: Queryable;
  provider: EmbeddingProvider;
}

export interface HybridSearchFilters extends SearchFilters {
  /** Сколько векторных хитов берём (по умолчанию 20). */
  semanticLimit?: number | undefined;
}

/**
 * Точный хит считаем максимально релевантным (score 1): он подтверждён
 * подстрокой. Склейка: union по messageId, exact побеждает semantic,
 * сортировка по score desc, при равенстве — свежие первыми.
 */
export async function hybridSearch(deps: HybridSearchDeps, f: HybridSearchFilters): Promise<HybridHit[]> {
  const q = f.q?.trim() ?? "";
  if (!q) return [];

  const merged = new Map<string, HybridHit>();

  const vectors = await deps.provider.embed([q]);
  const queryVector = vectors[0];
  if (!queryVector) throw new Error("provider returned no vector for the query");

  const semanticFilters: SemanticFilters = {
    ...(f.personId !== undefined ? { personId: f.personId } : {}),
    ...(f.accountId !== undefined ? { accountId: f.accountId } : {}),
    ...(f.chatId !== undefined ? { chatId: f.chatId } : {}),
    ...(f.from !== undefined ? { from: f.from } : {}),
    ...(f.to !== undefined ? { to: f.to } : {}),
    ...(f.chatType !== undefined ? { chatType: f.chatType } : {}),
    ...(f.semanticLimit !== undefined ? { limit: f.semanticLimit } : {}),
  };
  const semantic = await searchSimilar(deps.q, queryVector, deps.provider.model, semanticFilters);
  for (const h of semantic) {
    merged.set(h.messageId, { ...h, source: "semantic" });
  }

  const exact = await searchMessages(deps.q, { ...f, q, limit: f.limit ?? 20 });
  // Порядок searchMessages (покрытие термами → фраза → свежесть) сохраняем
  // микро-затуханием score: exact-хиты идут в своём порядке, все выше любого
  // semantic (cosine < 1); при дубле exact перезаписывает semantic (source).
  exact.forEach((h, idx) => {
    merged.set(h.messageId, { ...h, score: 1 - idx * 1e-6, source: "exact" });
  });

  return [...merged.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.sentAt.getTime() - a.sentAt.getTime();
  });
}

/** Полный перечень сообщений за период — без векторов и без топ-N (FR-04). */
export async function fullPeriodListing(
  q: Queryable,
  f: Omit<SearchFilters, "q" | "limit">,
): Promise<EvidenceHit[]> {
  return listMessagesInPeriod(q, f);
}
