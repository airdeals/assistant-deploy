import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Queryable } from "../dataSource.js";
import {
  ORDER_TRANSITIONS,
  type Order,
  type OrderDraft,
  type OrderLine,
  type OrderRevision,
  type OrderStatus,
} from "../../core/orders.js";
import { minorUnitsSchema } from "./settlementsRepo.js";

/** Персист заказов: payload целиком в jsonb, статус отдельной колонкой. */

const orderLineSchema = z.object({
  title: z.string().min(1),
  qty: z.number().positive(),
  unit: z.string().default("шт"),
  priceMinor: minorUnitsSchema,
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()),
});

export const orderDraftSchema = z.object({
  clientPersonId: z.string().min(1),
  lines: z.array(orderLineSchema).min(1),
  delivery: z.string().optional(),
  address: z.string().optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentTerms: z.string().optional(),
  comments: z.string().optional(),
  evidenceMessageIds: z.array(z.string()).default([]),
});

export const orderStatusSchema = z.enum(["draft", "reviewed", "confirmed", "in_progress", "done", "cancelled"]);

function serialize(order: Order): Record<string, unknown> {
  return {
    ...order,
    lines: order.lines.map((l) => ({ ...l, priceMinor: l.priceMinor.toString() })),
  };
}

function deserialize(row: Record<string, unknown>): Order {
  const p = row.payload as Record<string, unknown>;
  return {
    ...(p as unknown as Order),
    lines: ((p.lines as Record<string, unknown>[]) ?? []).map(
      (l) => ({ ...l, priceMinor: BigInt(l.priceMinor as string) }) as OrderLine,
    ),
    revisions: (p.revisions as OrderRevision[]) ?? [],
  };
}

export async function insertOrder(q: Queryable, draft: OrderDraft, at: Date = new Date()): Promise<Order> {
  const order: Order = {
    id: randomUUID(),
    clientPersonId: draft.clientPersonId,
    status: "draft",
    lines: draft.lines.map((l) => ({ ...l })),
    delivery: draft.delivery ?? null,
    address: draft.address ?? null,
    dueOn: draft.dueOn ?? null,
    paymentTerms: draft.paymentTerms ?? null,
    comments: draft.comments ?? null,
    evidenceMessageIds: [...draft.evidenceMessageIds],
    revisions: [
      { seq: 1, at, actor: "owner", reason: "created from draft", evidenceMessageIds: [...draft.evidenceMessageIds], summary: `lines=${draft.lines.length}` },
    ],
    createdAt: at,
  };
  await q.query(
    `INSERT INTO orders (id, chat_id, counterparty_person_id, status, payload)
     VALUES ($1, $2, $3, 'draft', $4)`,
    [order.id, draft.evidenceMessageIds[0] ?? "00000000-0000-0000-0000-000000000000", draft.clientPersonId, JSON.stringify(serialize(order))],
  );
  return order;
}

export async function getOrder(q: Queryable, id: string): Promise<Order | null> {
  const res = await q.query<{ payload: unknown; status: OrderStatus }>(
    `SELECT payload, status FROM orders WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return deserialize({ payload: row.payload });
}

export async function listOrders(q: Queryable, opts: { clientPersonId?: string | undefined } = {}): Promise<Order[]> {
  const res = await q.query<{ payload: unknown }>(
    `SELECT payload FROM orders
     ${opts.clientPersonId ? "WHERE counterparty_person_id = $1" : ""}
     ORDER BY (payload->>'createdAt') DESC`,
    opts.clientPersonId ? [opts.clientPersonId] : [],
  );
  return res.rows.map((r) => deserialize(r as Record<string, unknown>));
}

export async function saveOrder(q: Queryable, order: Order): Promise<void> {
  await q.query(`UPDATE orders SET status = $1, payload = $2 WHERE id = $3`, [
    order.status,
    JSON.stringify(serialize(order)),
    order.id,
  ]);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    throw Object.assign(new Error(`Invalid order transition: ${from} -> ${to}`), { name: "InvalidTransitionError" });
  }
}

export type { OrderDraft };
