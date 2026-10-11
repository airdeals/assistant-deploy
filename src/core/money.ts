/**
 * Money: денежная величина в минорных единицах (bigint), валюта ISO 4217.
 * Арифметика — только в пределах одной валюты. float нигде не используется.
 */

export class CurrencyMismatchError extends Error {
  readonly left: string;
  readonly right: string;

  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} vs ${right}`);
    this.name = "CurrencyMismatchError";
    this.left = left;
    this.right = right;
  }
}

export interface Money {
  amountMinor: bigint;
  /** ISO 4217, верхний регистр, 3 буквы. */
  currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

function assertCurrency(currency: string): string {
  const c = currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(c)) {
    throw new Error(`Invalid ISO 4217 currency code: "${currency}"`);
  }
  return c;
}

/**
 * Конструктор Money. Принимает только целые минорные единицы
 * (bigint, целое number или строку с целым числом). Дробный number
 * отклоняется — никакого float.
 */
export function money(amountMinor: bigint | number | string, currency: string): Money {
  let minor: bigint;
  if (typeof amountMinor === "bigint") {
    minor = amountMinor;
  } else if (typeof amountMinor === "number") {
    if (!Number.isInteger(amountMinor)) {
      throw new Error("money(): fractional number is not allowed, use integer minor units");
    }
    minor = BigInt(amountMinor);
  } else {
    if (!/^-?\d+$/.test(amountMinor.trim())) {
      throw new Error(`money(): invalid integer string "${amountMinor}"`);
    }
    minor = BigInt(amountMinor.trim());
  }
  return { amountMinor: minor, currency: assertCurrency(currency) };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

/** Умножение на безразмерный целый коэффициент. */
export function mul(a: Money, factor: bigint | number): Money {
  const f = typeof factor === "bigint" ? factor : BigInt(factor);
  return { amountMinor: a.amountMinor * f, currency: a.currency };
}

export function negate(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/** Сравнение; бросает CurrencyMismatchError при разных валютах. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

/** "123.45 RUB" для целого major/minor представления (строка, не float). */
export function format(a: Money): string {
  const negative = a.amountMinor < 0n;
  const abs = negative ? -a.amountMinor : a.amountMinor;
  const major = abs / 100n;
  const minor = abs % 100n;
  const minorStr = minor.toString().padStart(2, "0");
  return `${negative ? "-" : ""}${major.toString()}.${minorStr} ${a.currency}`;
}
