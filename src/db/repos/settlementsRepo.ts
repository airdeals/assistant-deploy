import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Queryable } from "../dataSource.js";
import { Ledger, type Balance, type FinancialEventType } from "../../core/settlements.js";
import { money } from "../../core/money.js";

/**
 * settlementsRepo: persistence financial_events.
 * - amount_minor bigint, currency char(3) — валюты не смешиваются;
 * - confirmation_state: unconfirmed -> confirmed|rejected;
 * - корректировки — новые записи с correction_of (журнал, не перезапись);
 * - provenance: origin manual|extracted + evidence (message ids);
 * - float запрещён на уровне zod-схемы: только целые минорные единицы.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Целые минорные единицы: bigint, целое число или строка-целое. Никакого float. */
export const minorUnitsSchema = z
  .union([z.bigint(), z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform((v) => (typeof v === "bigint" ? v : BigInt(v as number | string)));

export const financialEventInputSchema = z.object({
  fromPersonId: z.string().min(1),
  toPersonId: z.string().min(1),
  type: z.enum(["obligation", "advance", "payment_reported", "refund", "discount", "cancel", "promise"]),
  amountMinor: minorUnitsSchema,
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()),
  occurredOn: isoDate,
  orderId: z.string().nullable().optional(),
  evidenceMessageIds: z.array(z.string()).default([]),
  origin: z.enum(["manual", "extracted"]).default("manual"),
});

export type FinancialEventInput = z.infer<typeof financialEventInputSchema>;

/** Вход addEvent: поля с дефолтами схемы необязательны, minor units — любой целый вид. */
export type NewFinancialEvent = Omit<FinancialEventInput, "amountMinor" | "origin" | "evidenceMessageIds" | "orderId"> & {
  amountMinor: bigint | number | string;
  origin?: "manual" | "extracted" | undefined;
  evidenceMessageIds?: string[] | undefined;
  orderId?: string | null | undefined;
};

export interface FinancialEventRow {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  type: FinancialEventType;
  amountMinor: bigint;
  currency: string;
  occurredOn: string;
  confirmationState: "unconfirmed" | "confirmed" | "rejected";
  origin: "manual" | "extracted";
  orderId: string | null;
  correctionOf: string | null;
  evidenceMessageIds: string[];
  createdAt: Date;
}

export async function addEvent(q: Queryable, input: NewFinancialEvent): Promise<FinancialEventRow> {
  const origin = input.origin ?? "manual";
  const evidence = input.evidenceMessageIds ?? [];
  const minor = BigInt(input.amountMinor as bigint | number | string);
  const id = randomUUID();
  await q.query(
    `INSERT INTO financial_events
       (id, order_id, from_person_id, to_person_id, type, amount_minor, currency,
        occurred_on, confirmation_state, origin, evidence, correction_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unconfirmed', $9, $10, NULL)`,
    [
      id,
      input.orderId ?? null,
      input.fromPersonId,
      input.toPersonId,
      input.type,
      minor,
      input.currency,
      input.occurredOn,
      origin,
      JSON.stringify(evidence),
    ],
  );
  return {
    id,
    fromPersonId: input.fromPersonId,
    toPersonId: input.toPersonId,
    type: input.type,
    amountMinor: minor,
    currency: input.currency,
    occurredOn: input.occurredOn,
    confirmationState: "unconfirmed",
    origin,
    orderId: input.orderId ?? null,
    correctionOf: null,
    evidenceMessageIds: evidence,
    createdAt: new Date(),
  };
}

export async function getEvent(q: Queryable, id: string): Promise<FinancialEventRow | null> {
  const res = await q.query<FinancialEventRow>(selectSql("WHERE id = $1"), [id]);
  return res.rows[0] ?? null;
}

export async function listEventsForPerson(q: Queryable, personId: string): Promise<FinancialEventRow[]> {
  const res = await q.query<FinancialEventRow>(
    selectSql("WHERE from_person_id = $1 OR to_person_id = $1 ORDER BY occurred_on"),
    [personId],
  );
  return res.rows;
}

function selectSql(where: string): string {
  return `SELECT id, order_id AS "orderId", from_person_id AS "fromPersonId",
            to_person_id AS "toPersonId", type, amount_minor AS "amountMinor",
            currency, occurred_on AS "occurredOn", confirmation_state AS "confirmationState",
            origin, correction_of AS "correctionOf", evidence AS "evidenceMessageIds",
            created_at AS "createdAt"
          FROM financial_events ${where}`;
}

export async function confirmEvent(q: Queryable, id: string): Promise<FinancialEventRow | null> {
  await q.query(
    `UPDATE financial_events SET confirmation_state = 'confirmed'
     WHERE id = $1 AND confirmation_state = 'unconfirmed'`,
    [id],
  );
  return getEvent(q, id);
}

export async function rejectEvent(q: Queryable, id: string): Promise<FinancialEventRow | null> {
  await q.query(
    `UPDATE financial_events SET confirmation_state = 'rejected'
     WHERE id = $1 AND confirmation_state = 'unconfirmed'`,
    [id],
  );
  return getEvent(q, id);
}

/**
 * Корректировка: создаёт НОВУЮ запись с correction_of → оригинал.
 * Оригинал не изменяется и не удаляется — журнал корректировок.
 */
export async function correctEvent(
  q: Queryable,
  id: string,
  patch: Partial<Pick<FinancialEventInput, "amountMinor" | "currency" | "occurredOn" | "type">>,
  reason: string,
): Promise<FinancialEventRow | null> {
  const original = await getEvent(q, id);
  if (!original) return null;
  const corrected = await addEvent(q, {
    fromPersonId: original.fromPersonId,
    toPersonId: original.toPersonId,
    type: patch.type ?? original.type,
    amountMinor: patch.amountMinor ?? original.amountMinor,
    currency: patch.currency ?? original.currency,
    occurredOn: patch.occurredOn ?? original.occurredOn,
    orderId: original.orderId,
    evidenceMessageIds: [...original.evidenceMessageIds, `correction:${reason}`],
    origin: original.origin,
  });
  await q.query(`UPDATE financial_events SET correction_of = $1 WHERE id = $2`, [id, corrected.id]);
  return { ...corrected, correctionOf: id };
}

/** Загрузить события пары людей в core Ledger (rejected исключаются). */
export async function loadLedger(q: Queryable, personA: string, personB: string): Promise<Ledger> {
  const rows = await q.query<FinancialEventRow>(
    selectSql(`WHERE (from_person_id = $1 AND to_person_id = $2)
                 OR (from_person_id = $2 AND to_person_id = $1)`),
    [personA, personB],
  );
  const ledger = new Ledger();
  for (const r of rows.rows) {
    if (r.confirmationState === "rejected") continue;
    ledger.add({
      id: r.id,
      fromPersonId: r.fromPersonId,
      toPersonId: r.toPersonId,
      type: r.type,
      amount: money(r.amountMinor, r.currency),
      occurredOn: r.occurredOn,
      confirmationState: r.confirmationState === "confirmed" ? "confirmed" : "candidate",
      orderId: r.orderId,
      correctionOf: r.correctionOf,
    });
  }
  return ledger;
}

/** Баланс personId против каждого встречного контрагента (AT-08/10). */
export async function balancesForPerson(
  q: Queryable,
  personId: string,
): Promise<{ counterpartPersonId: string; balance: Balance }[]> {
  const rows = await listEventsForPerson(q, personId);
  const counterparts = new Set<string>();
  for (const r of rows) {
    if (r.confirmationState === "rejected") continue;
    counterparts.add(r.fromPersonId === personId ? r.toPersonId : r.fromPersonId);
  }
  const out: { counterpartPersonId: string; balance: Balance }[] = [];
  for (const cp of counterparts) {
    const ledger = await loadLedger(q, personId, cp);
    out.push({ counterpartPersonId: cp, balance: ledger.balance(personId, cp) });
  }
  return out;
}
