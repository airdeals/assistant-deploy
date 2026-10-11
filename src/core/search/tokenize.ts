/**
 * Токенизация поискового запроса (G2-4, улучшение по результатам eval):
 * пословный AND вместо «вся строка как подстрока».
 *
 * Многословный запрос «Ахмед орехи» не является подстрокой сообщения
 * «Ахмед должен 37000 лир за орехи…» — поэтому поиск разбивает запрос на
 * термы (unicode-aware: кириллица, латиница, арабская, CJK), приводит к
 * нижнему регистру, отбрасывает стоп-слова и короткие термы (< 2 символов),
 * и требует вхождения ВСЕХ термов (AND).
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  // ru
  "и", "в", "не", "на", "я", "что", "по", "за", "от", "до", "у", "к", "с", "а", "о", "это", "как",
  // en
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "i", "you", "for", "on",
  "what", "was", "were", "it", "at", "as", "be", "have", "has", "with", "how", "do", "does",
  // tr
  "ve", "ile", "için", "bir", "bu", "şu", "ne", "mi", "mı", "de", "da", "ben", "sen",
]);

const MIN_TERM_LENGTH = 2;

/**
 * Возвращает термы запроса. Пустой массив — запрос без значимых термов
 * (тогда вызывающий код фолбэком использует сырую строку как подстроку).
 */
export function tokenizeQuery(raw: string): string[] {
  const matches = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  for (const t of matches) {
    if (t.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(t)) continue;
    terms.push(t);
  }
  return terms;
}
