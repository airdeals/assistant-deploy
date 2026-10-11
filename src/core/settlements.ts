import { money, type Money } from "./money.js";

/**
 * Settlements: расчёты между людьми.
 *
 * Принципы:
 * - «переведу завтра» (promise) — НЕ платёж: попадает только в кандидаты
 *   и никогда не меняет подтверждённый баланс.
 * - Подтверждённый баланс считается только по событиям
 *   confirmationState="confirmed"; неподтверждённые кандидаты возвращаются
 *   отдельно; неизвестный начальный остаток помечается флагом.
 * - Дедупликация оплаты по пересылке/цитированию: по умолчанию каждое
 *   сообщение — отдельный кандидат; слить в одну операцию можно ТОЛЬКО
 *   явным правилом (linkAsDuplicate).
 * - Валюты не смешиваются: баланс — список сумм по валютам (AT-09).
 */

export type FinancialEventType =
  | "obligation"   // долг: from должен to
  | "advance"      // предоплата: from дал to раньше обязательства
  | "payment_reported" // сообщение об оплате
  | "refund"       // возврат
  | "discount"     // скидка/прощение части долга
  | "cancel"       // отмена ранее внесённого события
  | "promise";     // обещание заплатить (не платёж!)

export type ConfirmationState = "confirmed" | "candidate";

export interface FinancialEvent {
  id: string;
  orderId?: string | null;
  fromPersonId: string;
  toPersonId: string;
  type: FinancialEventType;
  amount: Money;
  occurredOn: string; // YYYY-MM-DD
  confirmationState: ConfirmationState;
  /** Для cancel: id отменяемого события. */
  correctionOf?: string | null;
  /** Для promise: когда обещано. */
  promiseDueOn?: string | null;
  /** Если установлено через linkAsDuplicate — ссылка на каноническое событие. */
  duplicateOf?: string | null;
}

export interface BalanceLine {
  currency: string;
  amountMinor: bigint;
}

export interface Balance {
  /** Подтверждённый остаток: положительный — toPerson должен fromPerson. */
  confirmed: BalanceLine[];
  /** Неподтверждённые кандидаты (promises, неподтверждённые оплаты, дубли). */
  candidates: BalanceLine[];
  /** true — до первого известного события остаток неизвестен. */
  unknownOpening: boolean;
}

/** Знаковый вклад события в баланс (долг toPerson перед fromPerson). */
function signedAmount(e: FinancialEvent): bigint {
  const a = e.amount.amountMinor;
  switch (e.type) {
    case "obligation":
    case "promise":
      return a;
    case "advance":
    case "payment_reported":
    case "refund":
      return -a;
    case "discount":
      return -a;
    case "cancel":
      return 0n; // вклад считается через correctionOf
  }
}

export class Ledger {
  private events = new Map<string, FinancialEvent>();

  add(event: FinancialEvent): FinancialEvent {
    if (this.events.has(event.id)) {
      // Идемпотентность по id события.
      return this.events.get(event.id) as FinancialEvent;
    }
    if (event.type === "promise") {
      // Обещание никогда не бывает подтверждённым платежом.
      event = { ...event, confirmationState: "candidate" };
    }
    this.events.set(event.id, event);
    return event;
  }

  get(id: string): FinancialEvent | undefined {
    return this.events.get(id);
  }

  all(): FinancialEvent[] {
    return [...this.events.values()];
  }

  /**
   * Явное правило владельца: события eventIds описывают ОДНУ оплату.
   * Первый id списка становится каноническим, остальные помечаются
   * duplicateOf и исключаются из сумм.
   */
  linkAsDuplicate(eventIds: string[]): void {
    if (eventIds.length < 2) return;
    const [canonicalId, ...dupIds] = eventIds as [string, ...string[]];
    if (!this.events.has(canonicalId)) {
      throw new Error(`linkAsDuplicate: unknown event ${canonicalId}`);
    }
    for (const id of dupIds) {
      const ev = this.events.get(id);
      if (!ev) throw new Error(`linkAsDuplicate: unknown event ${id}`);
      this.events.set(id, { ...ev, duplicateOf: canonicalId });
    }
  }

  /** Баланс между двумя людьми (по умолчанию — все события в обе стороны). */
  balance(fromPersonId: string, toPersonId: string): Balance {
    const confirmedBy = new Map<string, bigint>();
    const candidatesBy = new Map<string, bigint>();
    let unknownOpening = true;

    const apply = (map: Map<string, bigint>, currency: string, delta: bigint) => {
      map.set(currency, (map.get(currency) ?? 0n) + delta);
    };

    for (const e of this.events.values()) {
      const involves =
        (e.fromPersonId === fromPersonId && e.toPersonId === toPersonId) ||
        (e.fromPersonId === toPersonId && e.toPersonId === fromPersonId);
      if (!involves) continue;

      let delta = signedAmount(e);
      // Событие в обратную сторону меняет знак.
      const forward = e.fromPersonId === fromPersonId && e.toPersonId === toPersonId;
      const signed = forward ? delta : -delta;

      if (e.duplicateOf) continue; // дубль по явному правилу — не считаем
      if (e.type === "cancel" && e.correctionOf) {
        const target = this.events.get(e.correctionOf);
        if (target) {
          const tForward = target.fromPersonId === fromPersonId && target.toPersonId === toPersonId;
          const tSigned = signedAmount(target) * (tForward ? 1n : -1n);
          delta = -tSigned;
          apply(e.confirmationState === "confirmed" ? confirmedBy : candidatesBy, e.amount.currency, delta);
          continue;
        }
      }

      const map = e.confirmationState === "confirmed" ? confirmedBy : candidatesBy;
      if (e.type !== "promise") {
        unknownOpening = false;
      }
      apply(map, e.amount.currency, signed);
    }

    const toLines = (m: Map<string, bigint>): BalanceLine[] =>
      [...m.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor }));

    return {
      confirmed: toLines(confirmedBy),
      candidates: toLines(candidatesBy),
      unknownOpening,
    };
  }
}

/** Сумма по валюте из списка строк баланса. */
export function balanceLineAmount(lines: BalanceLine[], currency: string): Money {
  const line = lines.find((l) => l.currency === currency);
  return money(line ? line.amountMinor : 0n, currency);
}
