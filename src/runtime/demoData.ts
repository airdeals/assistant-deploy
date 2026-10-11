/**
 * Демо-данные runtime (G5-4): детерминированный сценарий синтетических
 * событий. 4 аккаунта (wa-1, wa-2, tg-1, tg-2), два человека (Ахмед —
 * ru/ar, Мехмет — tr/en), финансовые фразы для settlements-кандидатов,
 * вопросы для pendingReplies, голосовые как attachment-refs.
 * Ничего реального: все имена/номера вымышленные.
 */

export interface DemoPerson {
  key: string;
  displayName: string;
  authorExternalId: string;
  langs: string[];
}

export interface DemoStep {
  accountKey: string;
  chatExternalId: string;
  chatTitle: string;
  personKey: string;
  direction: "in" | "out";
  text: string;
  lang: "ru" | "tr" | "en" | "ar";
  /** Голосовое — текст расшифровки, вложение audio/ogg. */
  voice?: boolean;
  /** Смещение минут от начала сценария (детерминированные метки времени). */
  atMin: number;
}

export const DEMO_OWNER_PERSON = "owner";
export const DEMO_OWNER_DISPLAY = "Владелец (демо)";

export const DEMO_PEOPLE: DemoPerson[] = [
  { key: "ahmed", displayName: "Ахмед Аль-Рашид", authorExternalId: "demo:ahmed", langs: ["ru", "ar"] },
  { key: "mehmet", displayName: "Мехмет Йылмаз", authorExternalId: "demo:mehmet", langs: ["tr", "en"] },
];

/** Детерминированный UUID v4-формата из строки (стабильные сиды). */
export function demoUuid(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  const hex = (n: number, len: number) => (n >>> 0).toString(16).padStart(len, "0");
  const a = hex(h, 8);
  const b = hex(Math.imul(h, 2654435761), 8);
  const c = hex(Math.imul(h ^ 0x9e3779b9, 1597334677), 8);
  const d = hex(Math.imul(h ^ 0x85ebca6b, 3812015801), 8);
  return `${a.slice(0, 8)}-${a.slice(0, 4)}-4${a.slice(4, 7)}-8${b.slice(1, 4)}-${b.slice(0, 6)}${c.slice(0, 6)}`;
}

/**
 * Сценарий: фиксированные шаги, идемпотентные externalMessageId.
 * Ахмед пишет в wa-1 и tg-1 (один человек — две идентичности),
 * Мехмет — в wa-2 и tg-2. Есть межъязыковые пары (ru-вопрос ↔
 * tr-договорённость) — как в evals и fixtures веба.
 */
export function buildDemoSteps(): DemoStep[] {
  return [
    // --- wa-1 · Ахмед (ru/ar) ---
    { accountKey: "wa-1", chatExternalId: "wa1-ahmed", chatTitle: "Ахмед (WA-1)", personKey: "ahmed", direction: "in", text: "Салам! Напоминаю: долг 20000 рублей до пятницы, ок?", lang: "ru", atMin: 0 },
    { accountKey: "wa-1", chatExternalId: "wa1-ahmed", chatTitle: "Ахмед (WA-1)", personKey: "ahmed", direction: "out", text: "Ок, в пятницу переведу", lang: "ru", atMin: 2 },
    { accountKey: "wa-1", chatExternalId: "wa1-ahmed", chatTitle: "Ахмед (WA-1)", personKey: "ahmed", direction: "in", text: "Скинешь реквизиты? Или как прошлый раз?", lang: "ru", atMin: 5 },
    { accountKey: "wa-1", chatExternalId: "wa1-ahmed", chatTitle: "Ахмед (WA-1)", personKey: "ahmed", direction: "in", text: "هل استلمت المبلغ؟ أخبرني من فضلك", lang: "ar", atMin: 8 },
    { accountKey: "wa-1", chatExternalId: "wa1-ahmed", chatTitle: "Ахмед (WA-1)", personKey: "ahmed", direction: "in", text: "[голосовое] Завтра привезу заказ, три коробки", lang: "ru", voice: true, atMin: 11 },

    // --- tg-1 · тот же Ахмед (ru) — сквозная идентичность человека ---
    { accountKey: "tg-1", chatExternalId: "tg1-ahmed", chatTitle: "Ахмед (TG)", personKey: "ahmed", direction: "in", text: "Обещаю: завтра переведу 3000 рублей частично", lang: "ru", atMin: 15 },
    { accountKey: "tg-1", chatExternalId: "tg1-ahmed", chatTitle: "Ахмед (TG)", personKey: "ahmed", direction: "in", text: "Ты получил моё голосовое про заказ?", lang: "ru", atMin: 18 },

    // --- wa-2 · Мехмет (tr/en) — coexistence live ---
    { accountKey: "wa-2", chatExternalId: "wa2-mehmet", chatTitle: "Mehmet (WA-2)", personKey: "mehmet", direction: "in", text: "Yarın 5000 lira göndereceğim, söz veriyorum", lang: "tr", atMin: 22 },
    { accountKey: "wa-2", chatExternalId: "wa2-mehmet", chatTitle: "Mehмет (WA-2)", personKey: "mehmet", direction: "out", text: "Tamam, bekliyorum", lang: "tr", atMin: 24 },
    { accountKey: "wa-2", chatExternalId: "wa2-mehmet", chatTitle: "Mehmet (WA-2)", personKey: "mehmet", direction: "in", text: "Did you receive the invoice for the cargo?", lang: "en", atMin: 27 },
    { accountKey: "wa-2", chatExternalId: "wa2-mehmet", chatTitle: "Mehmet (WA-2)", personKey: "mehmet", direction: "in", text: "[voice] Paid 150 USD today, check your bank", lang: "en", voice: true, atMin: 30 },

    // --- tg-2 · Мехмет (en), резервный бот, import_only ---
    { accountKey: "tg-2", chatExternalId: "tg2-mehmet", chatTitle: "Mehmet (TG-2)", personKey: "mehmet", direction: "in", text: "I owe you 200 USD from March, remember?", lang: "en", atMin: 34 },
    { accountKey: "tg-2", chatExternalId: "tg2-mehmet", chatTitle: "Mehmet (TG-2)", personKey: "mehmet", direction: "in", text: "Yarın gelecek misin toplantıya?", lang: "tr", atMin: 37 },
  ];
}

/** externalMessageId: детерминированный, устойчивый к повторам (AT-06). */
export function demoMessageId(step: DemoStep): string {
  return `demo-${step.accountKey}-${step.chatExternalId}-${step.atMin}`;
}

export interface FinancialCue {
  type: "obligation" | "payment_reported" | "promise";
  amountMinor: number;
  currency: "RUB" | "USD" | "TRY";
}

const CURRENCY_PATTERNS: { re: RegExp; currency: FinancialCue["currency"] }[] = [
  { re: /(\d[\d\s]*)\s*(?:руб(?:лей|ля)?|р\.|₽)/i, currency: "RUB" },
  { re: /(\d[\d\s]*)\s*(?:долларов|долл\.?|\$|usd)/i, currency: "USD" },
  { re: /(\d[\d\s]*)\s*(?:лир(?:ы|а)?|₺|try|lira)/i, currency: "TRY" },
];

const TYPE_KEYWORDS: { type: FinancialCue["type"]; words: RegExp }[] = [
  { type: "obligation", words: /долг|должен|должна|borçlu|owe|i owe/i },
  { type: "payment_reported", words: /оплатил|оплата|перев(ё|е)л|paid|ödedi|gönderdim/i },
  { type: "promise", words: /обещаю|promise|söz ver|sözü/i },
];

/**
 * Простой лексический извлекатель финансовых сигналов (демо-уровень,
 * не претендует на полноту G3-экстрактора). Первая пара «сумма+валюта»
 * и первый типовой маркер в тексте.
 */
export function extractFinancialCue(text: string): FinancialCue | null {
  let amount: number | null = null;
  let currency: FinancialCue["currency"] | null = null;
  for (const { re, currency: c } of CURRENCY_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      amount = Number(m[1]!.replace(/\s/g, ""));
      currency = c;
      break;
    }
  }
  if (amount === null || currency === null) return null;
  for (const { type, words } of TYPE_KEYWORDS) {
    if (words.test(text)) return { type, amountMinor: amount, currency };
  }
  return null;
}
