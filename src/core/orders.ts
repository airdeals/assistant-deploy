/**
 * Заказы (G3-3): OrderDraft из переписки → Order со статусами и ревизиями.
 * Пересылка сообщения-основания не плодит второй заказ: reconcile возвращает
 * merge (та же подтверждённая связь/клиент) или review (сомнительно).
 * Все изменения — через OrderRevision с основанием (сообщения-evidence).
 */

export type OrderStatus =
  | "draft"
  | "reviewed"
  | "confirmed"
  | "in_progress"
  | "done"
  | "cancelled";

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ["reviewed", "cancelled"],
  reviewed: ["confirmed", "draft", "cancelled"],
  confirmed: ["in_progress", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Invalid order transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export interface OrderLine {
  title: string;
  qty: number;
  unit: string;
  /** Минорные единицы, bigint — float запрещён на уровне схем ввода. */
  priceMinor: bigint;
  currency: string;
}

export interface OrderDraft {
  clientPersonId: string;
  lines: OrderLine[];
  delivery?: string;
  address?: string;
  dueOn?: string; // YYYY-MM-DD
  paymentTerms?: string;
  comments?: string;
  evidenceMessageIds: string[];
}

export interface OrderRevision {
  seq: number;
  at: Date;
  actor: string;
  reason: string;
  /** Сообщения-основания изменения. */
  evidenceMessageIds: string[];
  summary: string;
}

export interface Order {
  id: string;
  clientPersonId: string;
  status: OrderStatus;
  lines: OrderLine[];
  delivery: string | null;
  address: string | null;
  dueOn: string | null;
  paymentTerms: string | null;
  comments: string | null;
  evidenceMessageIds: string[];
  revisions: OrderRevision[];
  createdAt: Date;
}

export type ReconcileVerdict =
  | { action: "create" }
  | { action: "merge"; orderId: string; reason: string }
  | { action: "review"; orderId: string; reason: string };

function overlaps(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/**
 * Дедупликация черновика против существующих заказов.
 * Пересылка несёт те же message-evidence → пересечение множеств.
 * Тот же клиент (подтверждённая связь) → merge; иной клиент → review.
 */
export function reconcileDraft(orders: Order[], draft: OrderDraft): ReconcileVerdict {
  for (const o of orders) {
    const shared = overlaps(o.evidenceMessageIds, draft.evidenceMessageIds);
    if (shared.length === 0) continue;
    if (o.clientPersonId === draft.clientPersonId) {
      return { action: "merge", orderId: o.id, reason: `shared evidence: ${shared.join(",")}` };
    }
    return {
      action: "review",
      orderId: o.id,
      reason: `evidence shared with order of another client: ${shared.join(",")}`,
    };
  }
  return { action: "create" };
}

export class OrderStore {
  private orders = new Map<string, Order>();
  private nextId = 1;

  create(draft: OrderDraft, actor = "owner", at: Date = new Date()): Order {
    const order: Order = {
      id: `ord-${this.nextId++}`,
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
        {
          seq: 1,
          at,
          actor,
          reason: "created from draft",
          evidenceMessageIds: [...draft.evidenceMessageIds],
          summary: `lines=${draft.lines.length}`,
        },
      ],
      createdAt: at,
    };
    this.orders.set(order.id, order);
    return order;
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  all(): Order[] {
    return [...this.orders.values()];
  }

  private pushRevision(order: Order, r: Omit<OrderRevision, "seq">): OrderRevision {
    const rev: OrderRevision = { ...r, seq: order.revisions.length + 1 };
    order.revisions.push(rev);
    return rev;
  }

  update(id: string, patch: Partial<Omit<Order, "id" | "revisions" | "createdAt">>, reason: string, evidenceMessageIds: string[], actor = "owner", at: Date = new Date()): Order {
    const order = this.mustGet(id);
    if (order.status === "done" || order.status === "cancelled") {
      throw new Error(`update: order ${id} is ${order.status}`);
    }
    const changed: string[] = [];
    if (patch.lines) {
      order.lines = patch.lines.map((l) => ({ ...l }));
      changed.push("lines");
    }
    for (const key of ["delivery", "address", "dueOn", "paymentTerms", "comments"] as const) {
      if (patch[key] !== undefined && patch[key] !== order[key]) {
        (order as unknown as Record<string, unknown>)[key] = patch[key];
        changed.push(key);
      }
    }
    if (patch.evidenceMessageIds) {
      const merged = [...new Set([...order.evidenceMessageIds, ...patch.evidenceMessageIds])];
      order.evidenceMessageIds = merged;
      changed.push("evidence");
    }
    if (changed.length > 0) {
      this.pushRevision(order, { at, actor, reason, evidenceMessageIds, summary: changed.join(",") });
    }
    return order;
  }

  transition(id: string, to: OrderStatus, reason: string, evidenceMessageIds: string[], actor = "owner", at: Date = new Date()): Order {
    const order = this.mustGet(id);
    const allowed = ORDER_TRANSITIONS[order.status];
    if (!allowed.includes(to)) throw new InvalidTransitionError(order.status, to);
    const from = order.status;
    order.status = to;
    this.pushRevision(order, {
      at,
      actor,
      reason,
      evidenceMessageIds,
      summary: `status ${from} -> ${to}`,
    });
    return order;
  }

  private mustGet(id: string): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown order: ${id}`);
    return o;
  }
}
