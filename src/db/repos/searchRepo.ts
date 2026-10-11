import type { Queryable } from "../dataSource.js";
import { tokenizeQuery } from "../../core/search/tokenize.js";

/**
 * searchRepo: точный поиск и общая хронология поверх messages.
 * FR-04: фильтры (person/account/chat/period/type) применяются ДО
 * формирования выборки — все условия в WHERE на этапе запроса.
 * Возвращаются evidence-фрагменты: текст + источник (аккаунт, платформа,
 * внешний id чата) — без сокрытия происхождения.
 */

export interface SearchFilters {
  /** Поисковый запрос: пословный AND по термам (tokenizeQuery);
   *  фолбэк — сырая строка как подстрока, если термов нет. */
  q?: string | undefined;
  personId?: string | undefined;
  accountId?: string | undefined;
  chatId?: string | undefined;
  /** YYYY-MM-DD (включительно, по sent_at). */
  from?: string | undefined;
  to?: string | undefined;
  /** Тип чата: direct | group | channel. */
  chatType?: string | undefined;
  limit?: number | undefined;
}

export interface EvidenceHit {
  messageId: string;      // внутренний id сообщения
  externalMessageId: string;
  chatId: string;
  externalChatId: string;
  chatTitle: string | null;
  accountId: string;
  platform: string;
  ownExternalId: string;
  author: string;
  direction: "in" | "out";
  sentAt: Date;
  text: string;
}

export interface TimelinePage {
  messages: EvidenceHit[];
  /** Курсор следующей страницы; null — страниц больше нет. */
  nextCursor: string | null;
}

const HIT_SELECT = `
  SELECT m.id AS "messageId", m.message_id AS "externalMessageId",
         m.chat_id AS "chatId", c.external_chat_id AS "externalChatId",
         c.title AS "chatTitle", m.account_id AS "accountId",
         a.platform, a.own_external_id AS "ownExternalId",
         m.author, m.direction, m.sent_at AS "sentAt", m.text
  FROM messages m
  JOIN chats c ON c.id = m.chat_id
  JOIN accounts a ON a.id = m.account_id`;

const WHERE_FILTERS_TAIL = `
  AND ($F1::uuid IS NULL OR EXISTS (
        SELECT 1 FROM chat_participants cp
        JOIN identities i ON i.external_id = cp.external_id
        WHERE cp.chat_id = m.chat_id AND i.person_id = $F1))
  AND ($F2::uuid IS NULL OR m.account_id = $F2)
  AND ($F3::uuid IS NULL OR m.chat_id = $F3)
  AND ($F4::date IS NULL OR m.sent_at >= $F4::date)
  AND ($F5::date IS NULL OR m.sent_at < $F5::date + 1)
  AND ($F6::text IS NULL OR c.type = $F6)
  AND m.is_system = false
  AND m.deleted_at IS NULL`;

export async function searchMessages(q: Queryable, f: SearchFilters): Promise<EvidenceHit[]> {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 200);
  const raw = f.q?.trim() ?? "";
  // Пословный AND: термы из токенизатора; без термов — сырой запрос одним условием.
  const terms = tokenizeQuery(raw);
  const effective = terms.length > 0 ? terms : raw ? [raw] : [];

  // Позиции параметров: [термы…, сырая фраза (бонус ранжирования), фильтры 1..6].
  const phrasePos = effective.length + 1;
  const f1 = phrasePos + 1;
  const termClauses = effective
    .map((_, i) => `AND m.text ILIKE '%' || $${i + 1} || '%'`)
    .join("\n       ");
  const rankParts = effective.map(
    (_, i) => `(CASE WHEN m.text ILIKE '%' || $${i + 1} || '%' THEN 1 ELSE 0 END)`,
  );
  // Бонус за полное вхождение исходной фразы: точная цитата ранжируется выше
  // разрозненных совпадений термов.
  if (raw) rankParts.push(`(CASE WHEN m.text ILIKE '%' || $${phrasePos} || '%' THEN ${effective.length * 10} ELSE 0 END)`);
  const rankSql = rankParts.length > 0 ? rankParts.join(" + ") : "0";
  const where = WHERE_FILTERS_TAIL.replaceAll("$F1", `$${f1}`)
    .replaceAll("$F2", `$${f1 + 1}`)
    .replaceAll("$F3", `$${f1 + 2}`)
    .replaceAll("$F4", `$${f1 + 3}`)
    .replaceAll("$F5", `$${f1 + 4}`)
    .replaceAll("$F6", `$${f1 + 5}`);

  const res = await q.query<EvidenceHit>(
    `${HIT_SELECT}
     WHERE true
       ${effective.length > 0 ? termClauses : "AND m.text ILIKE '%' || $1 || '%'"}
       ${where}
     ORDER BY ${rankSql} DESC, m.sent_at DESC, m.id DESC
     LIMIT ${limit}`,
    [...effective, raw || null, f.personId ?? null, f.accountId ?? null, f.chatId ?? null,
     f.from ?? null, f.to ?? null, f.chatType ?? null],
  );
  return res.rows;
}

/** Keyset-курсор: base64("sentAtISO|messageUuid"). */
export function encodeCursor(sentAt: Date, messageId: string): string {
  return Buffer.from(`${sentAt.toISOString()}|${messageId}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { sentAt: Date; messageId: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf("|");
    if (idx === -1) return null;
    const sentAt = new Date(raw.slice(0, idx));
    const messageId = raw.slice(idx + 1);
    if (Number.isNaN(sentAt.getTime()) || !messageId) return null;
    return { sentAt, messageId };
  } catch {
    return null;
  }
}

/**
 * Общая хронология человека по всем аккаунтам (AT: timeline), убывание
 * времени, keyset-пагинация по (sent_at, id). pageSize+1 — детект хвоста.
 */
export async function personTimeline(
  q: Queryable,
  personId: string,
  opts: { cursor?: string | null | undefined; pageSize?: number | undefined } = {},
): Promise<TimelinePage> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
  const res = await q.query<EvidenceHit>(
    `${HIT_SELECT}
     WHERE true
       AND ($1::uuid IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM chat_participants cp
         JOIN identities i ON i.external_id = cp.external_id
         WHERE cp.chat_id = m.chat_id AND i.person_id = $1)
       AND m.is_system = false
       AND m.deleted_at IS NULL
       AND ($2::timestamptz IS NULL OR (m.sent_at, m.id) < ($2::timestamptz, $3::uuid))
     ORDER BY m.sent_at DESC, m.id DESC
     LIMIT ${pageSize + 1}`,
    [personId, decoded?.sentAt ?? null, decoded?.messageId ?? null],
  );
  const rows = res.rows;
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];
  return {
    messages: page,
    nextCursor: hasMore && last ? encodeCursor(last.sentAt, last.messageId) : null,
  };
}

/** Матрица coverage по аккаунтам (AT-16/17). */
export interface SourceCoverage {
  accountId: string;
  platform: string;
  adapter: string;
  ownExternalId: string;
  state: string;
  historyFrom: string | null;
  historyTo: string | null;
  lastSuccessfulSyncAt: Date | null;
  knownGaps: { from: string; to: string }[];
}

export async function getSourceCoverage(q: Queryable): Promise<SourceCoverage[]> {
  const res = await q.query<{
    accountId: string;
    platform: string;
    adapter: string;
    ownExternalId: string;
    state: string;
    historyFrom: string | null;
    historyTo: string | null;
    lastSuccessfulSyncAt: Date | null;
    knownGaps: unknown;
  }>(
    `SELECT id AS "accountId", platform, adapter, own_external_id AS "ownExternalId",
            state, history_from AS "historyFrom", history_to AS "historyTo",
            last_successful_sync_at AS "lastSuccessfulSyncAt", known_gaps AS "knownGaps"
     FROM accounts ORDER BY platform, adapter`,
  );
  return res.rows.map((r) => ({
    ...r,
    knownGaps: Array.isArray(r.knownGaps) ? (r.knownGaps as { from: string; to: string }[]) : [],
  }));
}

/**
 * Полный перечень сообщений за период (FR-04): НЕ ограничен LIMIT'ом и
 * НЕ зависит от векторов — векторные топ-N не заменяют полный перечень
 * (например, всех финансовых запросов за период). Маркер "period-full"
 * внутри SQL — для распознавания фейком DataSource в тестах.
 */
export async function listMessagesInPeriod(q: Queryable, f: Omit<SearchFilters, "q" | "limit">): Promise<EvidenceHit[]> {
  const res = await q.query<EvidenceHit>(
    `SELECT /* period-full */ m.id AS "messageId", m.message_id AS "externalMessageId",
            m.chat_id AS "chatId", c.external_chat_id AS "externalChatId",
            c.title AS "chatTitle", m.account_id AS "accountId",
            a.platform, a.own_external_id AS "ownExternalId",
            m.author, m.direction, m.sent_at AS "sentAt", m.text
     FROM messages m
     JOIN chats c ON c.id = m.chat_id
     JOIN accounts a ON a.id = m.account_id
     WHERE true
       AND ($1::uuid IS NULL OR EXISTS (
             SELECT 1 FROM chat_participants cp
             JOIN identities i ON i.external_id = cp.external_id
             WHERE cp.chat_id = m.chat_id AND i.person_id = $1))
       AND ($2::uuid IS NULL OR m.account_id = $2)
       AND ($3::uuid IS NULL OR m.chat_id = $3)
       AND ($4::date IS NULL OR m.sent_at >= $4::date)
       AND ($5::date IS NULL OR m.sent_at < $5::date + 1)
       AND ($6::text IS NULL OR c.type = $6)
       AND m.is_system = false
       AND m.deleted_at IS NULL
     ORDER BY m.sent_at ASC, m.id ASC`,
    [f.personId ?? null, f.accountId ?? null, f.chatId ?? null, f.from ?? null, f.to ?? null, f.chatType ?? null],
  );
  return res.rows;
}
