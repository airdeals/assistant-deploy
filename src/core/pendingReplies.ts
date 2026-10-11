/**
 * Ожидающие ответа вопросы (G3-4). Без LLM — правила закрытия чистые.
 * LLM-извлечение кандидатов — позже; сейчас rule-based детектор вопросов
 * помечает кандидатов статусом proposed.
 *
 * Ключевые правила:
 * - ответ засчитывается ТОЛЬКО если исходящий от владельца тому же
 *   подтверждённому person_id (тот же чат ИЛИ подтверждённая связь
 *   в другом аккаунте) и по теме;
 * - сообщение на другую тему не закрывает (AT-05);
 * - «ОК»-подобное не закрывает вопрос про оплату/счёт;
 * - неизвестная связь человека → needs_review, не уверенное закрытие;
 * - ручные действия (manual) переживают повторный анализ;
 * - чаты is_assistant_thread не анализируются (AT-37).
 */

export type ExpectationStatus = "pending" | "proposed" | "answered" | "dismissed" | "needs_review";
export type ExpectationResolution = "none" | "rule" | "manual";

export interface Expectation {
  id: string;
  personId: string | null;   // null — связь не подтверждена
  personKnown: boolean;      // подтверждённая идентичность?
  chatId: string;
  messageId: string;         // входящее сообщение-основание
  question: string;
  questionSentAt: Date;
  status: ExpectationStatus;
  resolution: ExpectationResolution;
  closedByMessageId: string | null;
  createdAt: Date;
}

/** Входящее сообщение-кандидат. */
export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  isAssistantThread: boolean;
  authorExternalId: string;
  direction: "in" | "out";
  text: string;
  sentAt: Date;
}

/** Исходящее сообщение владельца (потенциальный ответ). */
export interface OutgoingMessage {
  messageId: string;
  chatId: string;
  text: string;
  sentAt: Date;
  /** person_id получателя, если связь подтверждена; null — неизвестно. */
  toPersonId: string | null;
  toPersonKnown: boolean;
}

const QUESTION_WORDS = [
  // RU
  "что", "как", "сколько", "когда", "можно ли", "не могли бы", "зачем", "где", "успеете", "пришлёте", "пришлете", "какой", "какая", "какие",
  // TR
  "ne ", " ne", "kaç", "kac", "nasıl", "nasil", "ne zaman", "musun", "mısın", "misin",
  // EN
  "what", "how", "how much", "when", "can you", "could you",
  // AR
  "ماذا", "كم", "هل",
];

export function isQuestion(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.includes("?") || t.includes("؟")) return true;
  return QUESTION_WORDS.some((w) => t.includes(w));
}

const PAYMENT_RE = /(оплат|сч[её]т|счета|долг|перевод|предоплат|доплат|invoice|payment|paid|ödeme|fatura|utar|hisse)/i;

export function isPaymentQuestion(text: string): boolean {
  return PAYMENT_RE.test(text);
}

const OK_WORDS = new Set([
  "ок", "окей", "оки", "ок.", "ok", "okay", "kk", "да", "yes", "evet", "tamam", "хорошо",
  "отлично", "супер", "👍", "👌", "+", "го", "agreed", "good",
]);

/** «ОК»-подобное подтверждение (не содержание ответа). */
export function isOkLike(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[!\.\s]+$/u, "");
  if (t.length === 0) return false;
  if (OK_WORDS.has(t)) return true;
  return t.length <= 3 && !PAYMENT_RE.test(t) && /^[\p{L}0-9+👍👌]+$/u.test(t);
}

export interface TopicContext {
  sameChat: boolean;
  toPersonKnown: boolean; // подтверждённая связь получателя
}

/**
 * Тематическое соответствие вопроса и ответа (эвристика G3).
 * - «ОК»-подобное не закрывает вопрос про оплату/счёт;
 * - «ОК» засчитывается только в том же чате и при известной связи;
 * - содержательный ответ закрывает в том же чате или (cross-account)
 *   при подтверждённой связи с тем же человеком.
 */
export function topicMatches(question: string, answer: string, ctx: TopicContext): boolean {
  const answerOk = isOkLike(answer);
  if (isPaymentQuestion(question)) {
    return !answerOk && answer.trim().length > 0 && (ctx.sameChat || ctx.toPersonKnown);
  }
  if (answerOk) {
    return ctx.sameChat && ctx.toPersonKnown;
  }
  return ctx.sameChat || ctx.toPersonKnown;
}

export class PendingReplyStore {
  private expectations = new Map<string, Expectation>();
  private nextId = 1;

  /**
   * Детектор кандидатов: входящие от собеседника с признаками вопроса.
   * Чаты is_assistant_thread пропускаются (AT-37). Связь неизвестна —
   * personId null, personKnown false.
   */
  proposeFromIncoming(msgs: IncomingMessage[], at: Date = new Date()): Expectation[] {
    const created: Expectation[] = [];
    for (const m of msgs) {
      if (m.direction !== "in") continue;
      if (m.isAssistantThread) continue;
      if (!isQuestion(m.text)) continue;
      // Уже зарегистрировано?
      const dup = [...this.expectations.values()].find((e) => e.messageId === m.messageId);
      if (dup) continue;
      const exp: Expectation = {
        id: `exp-${this.nextId++}`,
        personId: null,
        personKnown: false,
        chatId: m.chatId,
        messageId: m.messageId,
        question: m.text,
        questionSentAt: m.sentAt,
        status: "proposed",
        resolution: "none",
        closedByMessageId: null,
        createdAt: at,
      };
      this.expectations.set(exp.id, exp);
      created.push(exp);
    }
    return created;
  }

  /**
   * Повторный анализ: ручные resolution НЕ трогаем (AT-18-аналог).
   * Иначе ищем исходящий ответ владельца тому же подтверждённому
   * человеку по теме → answered/rule; связь неизвестна → needs_review.
   */
  analyze(expId: string, outgoing: OutgoingMessage[]): Expectation {
    const exp = this.mustGet(expId);
    if (exp.resolution === "manual") return exp; // ручное решение переживает анализ

    const candidates = outgoing
      .filter((o) => o.sentAt.getTime() >= exp.questionSentAt.getTime())
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

    if (!exp.personKnown) {
      exp.status = "needs_review";
      return exp;
    }

    for (const o of candidates) {
      const samePerson = o.toPersonKnown && o.toPersonId === exp.personId;
      if (!samePerson) continue;
      const ctx: TopicContext = { sameChat: o.chatId === exp.chatId, toPersonKnown: o.toPersonKnown };
      if (topicMatches(exp.question, o.text, ctx)) {
        exp.status = "answered";
        exp.resolution = "rule";
        exp.closedByMessageId = o.messageId;
        return exp;
      }
    }
    exp.status = exp.status === "proposed" ? "proposed" : "pending";
    exp.closedByMessageId = null;
    return exp;
  }

  attachPerson(expId: string, personId: string): Expectation {
    const exp = this.mustGet(expId);
    exp.personId = personId;
    exp.personKnown = true;
    // Кандидат детектора с подтверждённой связью — полноценное ожидание.
    if (exp.status === "needs_review" || exp.status === "proposed") exp.status = "pending";
    return exp;
  }

  markAnsweredExternal(expId: string, at: Date = new Date()): Expectation {
    const exp = this.mustGet(expId);
    exp.status = "answered";
    exp.resolution = "manual";
    void at;
    return exp;
  }

  dismiss(expId: string, at: Date = new Date()): Expectation {
    const exp = this.mustGet(expId);
    exp.status = "dismissed";
    exp.resolution = "manual";
    void at;
    return exp;
  }

  reopen(expId: string): Expectation {
    const exp = this.mustGet(expId);
    exp.status = exp.personKnown ? "pending" : "needs_review";
    exp.resolution = "none";
    exp.closedByMessageId = null;
    return exp;
  }

  get(expId: string): Expectation | undefined {
    return this.expectations.get(expId);
  }

  all(): Expectation[] {
    return [...this.expectations.values()];
  }

  private mustGet(id: string): Expectation {
    const e = this.expectations.get(id);
    if (!e) throw new Error(`unknown expectation: ${id}`);
    return e;
  }
}
