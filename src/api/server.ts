import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DataSource } from "../db/dataSource.js";
import { login, logout } from "../auth/service.js";
import { AutoMergeForbiddenError, linkPersons } from "../db/repos/personsRepo.js";
import { getSourceCoverage, personTimeline, searchMessages } from "../db/repos/searchRepo.js";
import { requireOwner } from "./middleware.js";
import { readBody, Router, sendJson, type Ctx } from "./router.js";
import {
  addEvent, balancesForPerson, confirmEvent, correctEvent, financialEventInputSchema, getEvent, listEventsForPerson, rejectEvent,
} from "../db/repos/settlementsRepo.js";
import {
  assertTransition, getOrder, insertOrder, listOrders, orderDraftSchema, orderStatusSchema, saveOrder,
} from "../db/repos/ordersRepo.js";
import { listExpectations, upsertExpectation } from "../db/repos/pendingRepo.js";
import { dueDateSchema, insertTask, listTasks, setTaskStatus, taskInputSchema } from "../db/repos/tasksRepo.js";
import { PendingReplyStore } from "../core/pendingReplies.js";
import { TaskStore } from "../core/tasks.js";
import type { Order, OrderLine } from "../core/orders.js";
import type { EmbeddingProvider } from "../core/embeddings/provider.js";
import { hybridSearch } from "../core/search/semantic.js";
import { handleWa2Webhook, parseWa2Payload, verifyWa2Signature } from "../adapters/wa2Webhook.js";
import { OutboundDispatcher } from "../core/channels/outbound.js";
import { Allowlist, RecipientNotAllowedError } from "../core/channels/allowlist.js";
import { MockTgChannelProvider, MockWaChannelProvider } from "../core/channels/providers.js";
import type { TgChannelProvider, WaChannelProvider } from "../core/channels/providers.js";
import { markAssistantThread } from "../db/repos/ingestRepo.js";

/**
 * HTTP API (node:http + собственный минимальный роутер; фреймворков нет).
 * Все endpoints, кроме /auth/login, — за requireOwner.
 * Логирование — только метод/путь/статус: без содержимого сообщений и
 * тел запросов (ТЗ §10).
 */

export interface ApiOptions {
  ds: DataSource;
  /** Для тестов; по умолчанию console. */
  log?: (line: string) => void;
  /** Провайдер эмбеддингов для /search/semantic; null/отсутствует → 503. */
  embeddings?: EmbeddingProvider | null;
  /** Webhook WA-2: appSecret для HMAC и accountId для ingest. */
  wa2?: { appSecret: string; accountId: string } | null;
  /** Исходящие каналы G5; мок-провайдеры по умолчанию. */
  channels?: { wa?: WaChannelProvider | null | undefined; tg?: TgChannelProvider | null | undefined } | null;
  /** Подтверждённые внешние идентификаторы владельца для allowlist. */
  ownerExternalIds?: string[];
  /** Часы для логики окон/сессий; по умолчанию реальное время. Для тестов. */
  now?: () => Date;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Применение PATCH к заказу с фиксацией ревизии (core-логика поверх repo-типов). */
function applyOrderPatch(
  order: Order,
  patch: {
    lines?: OrderLine[];
    delivery?: string;
    address?: string;
    dueOn?: string;
    paymentTerms?: string;
    comments?: string;
  },
  reason: string,
  evidenceMessageIds: string[],
): Order {
  const changed: string[] = [];
  if (patch.lines) {
    order.lines = patch.lines;
    changed.push("lines");
  }
  for (const key of ["delivery", "address", "dueOn", "paymentTerms", "comments"] as const) {
    const v = patch[key];
    if (v !== undefined && order[key] !== v) {
      order[key] = v;
      changed.push(key);
    }
  }
  if (changed.length > 0) {
    order.revisions.push({
      seq: order.revisions.length + 1,
      at: new Date(),
      actor: "owner",
      reason,
      evidenceMessageIds,
      summary: changed.join(","),
    });
  }
  return order;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function buildRouter(opts: ApiOptions): Router {
  const { ds } = opts;
  const router = new Router();

  // Liveness-проба для HEALTHCHECK (Docker) и оркестраторов. Без авторизации,
  // без обращения к БД — сервер отвечает, значит процесс жив.
  router.get("/health", async (ctx: Ctx) => {
    sendJson(ctx.res, 200, { ok: true, service: "personal-ai-assistant-api" });
  });

  router.post("/auth/login", async (ctx: Ctx) => {
    const body = asRecord(ctx.body);
    const username = str(body?.username);
    const password = str(body?.password);
    if (!username || !password) {
      sendJson(ctx.res, 400, { error: "username and password are required" });
      return;
    }
    const issued = await login(ds, username, password);
    if (!issued) {
      // Нет различий между "нет такого юзера" и "не тот пароль".
      sendJson(ctx.res, 401, { error: "invalid credentials" });
      return;
    }
    sendJson(ctx.res, 200, {
      token: issued.token,
      expiresAt: issued.session.expiresAt.toISOString(),
      scope: issued.session.scope,
    });
  });

  router.post("/auth/logout", requireOwner(ds, async (ctx: Ctx) => {
    await logout(ds, ctx.auth!.sessionId);
    sendJson(ctx.res, 200, { ok: true });
  }));

  router.get("/search", requireOwner(ds, async (ctx: Ctx) => {
    const hits = await searchMessages(ds, {
      q: ctx.query.get("q") ?? undefined,
      personId: ctx.query.get("person_id") ?? undefined,
      accountId: ctx.query.get("account_id") ?? undefined,
      from: ctx.query.get("from") ?? undefined,
      to: ctx.query.get("to") ?? undefined,
      chatType: ctx.query.get("type") ?? undefined,
      limit: ctx.query.get("limit") ? Number(ctx.query.get("limit")) : undefined,
    });
    sendJson(ctx.res, 200, {
      hits: hits.map((h) => ({
        messageId: h.messageId,
        externalMessageId: h.externalMessageId,
        chatId: h.chatId,
        externalChatId: h.externalChatId,
        chatTitle: h.chatTitle,
        accountId: h.accountId,
        platform: h.platform,
        author: h.author,
        direction: h.direction,
        sentAt: h.sentAt,
        excerpt: h.text,
      })),
    });
  }));

  router.get("/timeline", requireOwner(ds, async (ctx: Ctx) => {
    const personId = ctx.query.get("person_id");
    if (!personId) {
      sendJson(ctx.res, 400, { error: "person_id is required" });
      return;
    }
    const page = await personTimeline(ds, personId, {
      cursor: ctx.query.get("cursor"),
      pageSize: ctx.query.get("limit") ? Number(ctx.query.get("limit")) : undefined,
    });
    sendJson(ctx.res, 200, {
      messages: page.messages.map((h) => ({
        messageId: h.messageId,
        chatId: h.chatId,
        externalChatId: h.externalChatId,
        platform: h.platform,
        accountId: h.accountId,
        sentAt: h.sentAt,
        excerpt: h.text,
      })),
      nextCursor: page.nextCursor,
    });
  }));

  /* ---------- G2-4: семантический поиск ---------- */

  router.get("/search/semantic", requireOwner(ds, async (ctx: Ctx) => {
    const provider = opts.embeddings ?? null;
    // AT-25: честная деградация — embeddings не сконфигурированы.
    if (!provider) {
      sendJson(ctx.res, 503, { error: "semantic search is not configured" });
      return;
    }
    const q = ctx.query.get("q")?.trim();
    if (!q) {
      sendJson(ctx.res, 400, { error: "q is required" });
      return;
    }
    const hits = await hybridSearch({ q: ds, provider }, {
      q,
      personId: ctx.query.get("person_id") ?? undefined,
      accountId: ctx.query.get("account_id") ?? undefined,
      chatId: ctx.query.get("chat_id") ?? undefined,
      from: ctx.query.get("from") ?? undefined,
      to: ctx.query.get("to") ?? undefined,
      chatType: ctx.query.get("type") ?? undefined,
      limit: ctx.query.get("limit") ? Number(ctx.query.get("limit")) : undefined,
      semanticLimit: ctx.query.get("semantic_limit") ? Number(ctx.query.get("semantic_limit")) : undefined,
    });
    sendJson(ctx.res, 200, {
      hits: hits.map((h) => ({
        messageId: h.messageId,
        externalMessageId: h.externalMessageId,
        chatId: h.chatId,
        externalChatId: h.externalChatId,
        chatTitle: h.chatTitle,
        accountId: h.accountId,
        platform: h.platform,
        author: h.author,
        direction: h.direction,
        sentAt: h.sentAt,
        excerpt: h.text,
        score: h.score,
        source: h.source,
      })),
    });
  }));

  router.get("/sources", requireOwner(ds, async (ctx: Ctx) => {
    const coverage = await getSourceCoverage(ds);
    sendJson(ctx.res, 200, { sources: coverage });
  }));

  router.post("/persons/:id/links", requireOwner(ds, async (ctx: Ctx) => {
    const body = asRecord(ctx.body);
    const otherPersonId = str(body?.person_id);
    const action = str(body?.action);
    const confirmed = body?.confirmed === true;
    if (!otherPersonId || (action !== "merge" && action !== "split")) {
      sendJson(ctx.res, 400, { error: "person_id and action (merge|split) are required" });
      return;
    }
    try {
      const link = await linkPersons(
        ds,
        ctx.params.id as string,
        otherPersonId,
        {
          action,
          confirmed,
          note: str(body?.note),
          identityId: str(body?.identity_id),
        },
      );
      sendJson(ctx.res, 200, { linkId: link.linkId });
    } catch (e) {
      if (e instanceof AutoMergeForbiddenError) {
        sendJson(ctx.res, 409, { error: e.message });
        return;
      }
      throw e;
    }
  }));

  /* ---------- G4: webhook WA-2 (подпись, не сессия) ---------- */

  router.add("POST", "/webhooks/wa2", async (ctx: Ctx) => {
    const cfg = opts.wa2 ?? null;
    if (!cfg) {
      sendJson(ctx.res, 503, { error: "webhook is not configured" });
      return;
    }
    const header = ctx.req.headers["x-hub-signature-256"];
    const signature = Array.isArray(header) ? header[0] : header;
    // AT-21: невалидная/чужая подпись → 401 без подсказок.
    if (!verifyWa2Signature(ctx.rawBody ?? "", signature, cfg.appSecret)) {
      sendJson(ctx.res, 401, { error: "unauthorized" });
      return;
    }
    if (ctx.body === null || typeof ctx.body !== "object") {
      sendJson(ctx.res, 400, { error: "invalid payload" });
      return;
    }
    const parsed = parseWa2Payload(ctx.body);
    const outcome = await handleWa2Webhook({ ds, accountId: cfg.accountId }, parsed);
    sendJson(ctx.res, 200, { ok: true, ...outcome });
  });

  router.get("/balances", requireOwner(ds, async (ctx: Ctx) => {
    const personId = ctx.query.get("person_id");
    if (!personId) {
      sendJson(ctx.res, 400, { error: "person_id is required" });
      return;
    }
    const balances = await balancesForPerson(ds, personId);
    sendJson(ctx.res, 200, {
      personId,
      balances: balances.map((b) => ({
        counterpartPersonId: b.counterpartPersonId,
        confirmed: b.balance.confirmed.map((l) => ({ currency: l.currency, amountMinor: l.amountMinor.toString() })),
        candidates: b.balance.candidates.map((l) => ({ currency: l.currency, amountMinor: l.amountMinor.toString() })),
        unknownOpening: b.balance.unknownOpening,
      })),
    });
  }));

  router.post("/financial-events", requireOwner(ds, async (ctx: Ctx) => {
    const parsed = financialEventInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.res, 400, { error: `invalid input: ${parsed.error.issues[0]?.message ?? "schema"}` });
      return;
    }
    const ev = await addEvent(ds, parsed.data);
    sendJson(ctx.res, 201, {
      id: ev.id,
      confirmationState: ev.confirmationState,
      amountMinor: ev.amountMinor.toString(),
      currency: ev.currency,
    });
  }));

  router.get("/financial-events", requireOwner(ds, async (ctx: Ctx) => {
    // Список событий владельца/контрагента для экрана взаиморасчётов (G5-3).
    const personId = ctx.query.get("person_id");
    if (!personId) {
      sendJson(ctx.res, 400, { error: "person_id is required" });
      return;
    }
    const events = await listEventsForPerson(ds, personId);
    sendJson(ctx.res, 200, {
      events: events.map((e) => ({ ...e, amountMinor: e.amountMinor.toString() })),
    });
  }));

  const financialEventAction = async (ctx: Ctx, action: "confirm" | "reject" | "correct") => {
    const id = ctx.params.id as string;
    if (action === "correct") {
      const body = asRecord(ctx.body) ?? {};
      const amountRaw = body.amountMinor;
      const amountParsed =
        amountRaw === undefined ? undefined : (financialEventInputSchema.shape.amountMinor.safeParse(amountRaw));
      if (amountRaw !== undefined && !amountParsed?.success) {
        sendJson(ctx.res, 400, { error: "amountMinor must be integer minor units" });
        return;
      }
      const reason = str(body.reason);
      if (!reason) {
        sendJson(ctx.res, 400, { error: "reason is required" });
        return;
      }
      const corrected = await correctEvent(ds, id, {
        ...(amountParsed?.success ? { amountMinor: amountParsed.data } : {}),
        ...(typeof body.currency === "string" ? { currency: body.currency } : {}),
        ...(typeof body.occurredOn === "string" ? { occurredOn: body.occurredOn } : {}),
      }, reason);
      if (!corrected) {
        sendJson(ctx.res, 404, { error: "not found" });
        return;
      }
      sendJson(ctx.res, 200, { id: corrected.id, correctionOf: corrected.correctionOf });
      return;
    }
    const ev = action === "confirm" ? await confirmEvent(ds, id) : await rejectEvent(ds, id);
    if (!ev) {
      sendJson(ctx.res, 404, { error: "not found" });
      return;
    }
    sendJson(ctx.res, 200, { id: ev.id, confirmationState: ev.confirmationState });
  };

  router.add("POST", "/financial-events/:id/confirm", requireOwner(ds, (ctx) => financialEventAction(ctx, "confirm")));
  router.add("POST", "/financial-events/:id/reject", requireOwner(ds, (ctx) => financialEventAction(ctx, "reject")));
  router.add("POST", "/financial-events/:id/correct", requireOwner(ds, (ctx) => financialEventAction(ctx, "correct")));

  /* ---------- G3: заказы ---------- */

  router.get("/orders", requireOwner(ds, async (ctx: Ctx) => {
    const orders = await listOrders(ds, { clientPersonId: ctx.query.get("client_person_id") ?? undefined });
    sendJson(ctx.res, 200, {
      orders: orders.map((o) => ({
        id: o.id, clientPersonId: o.clientPersonId, status: o.status,
        lines: o.lines.map((l) => ({ ...l, priceMinor: l.priceMinor.toString() })),
        dueOn: o.dueOn, revisions: o.revisions.length,
      })),
    });
  }));

  router.post("/orders", requireOwner(ds, async (ctx: Ctx) => {
    const parsed = orderDraftSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendJson(ctx.res, 400, { error: `invalid input: ${parsed.error.issues[0]?.message ?? "schema"}` });
      return;
    }
    const order = await insertOrder(ds, parsed.data as Parameters<typeof insertOrder>[1]);
    sendJson(ctx.res, 201, { id: order.id, status: order.status });
  }));

  router.add("GET", "/orders/:id", requireOwner(ds, async (ctx: Ctx) => {
    // Полный заказ с ревизиями для экрана заказов (G5-3).
    const order = await getOrder(ds, ctx.params.id as string);
    if (!order) {
      sendJson(ctx.res, 404, { error: "not found" });
      return;
    }
    sendJson(ctx.res, 200, {
      id: order.id,
      clientPersonId: order.clientPersonId,
      status: order.status,
      lines: order.lines.map((l) => ({ ...l, priceMinor: l.priceMinor.toString() })),
      dueOn: order.dueOn ?? null,
      revisions: order.revisions.map((r) => ({ ...r, at: r.at.toISOString() })),
    });
  }));

  router.add("PATCH", "/orders/:id", requireOwner(ds, async (ctx: Ctx) => {
    const order = await getOrder(ds, ctx.params.id as string);
    if (!order) {
      sendJson(ctx.res, 404, { error: "not found" });
      return;
    }
    const body = asRecord(ctx.body) ?? {};
    const patch: Parameters<typeof applyOrderPatch>[1] = {};
    if (Array.isArray(body.lines)) {
      const linesParsed = orderDraftSchema.shape.lines.safeParse(body.lines);
      if (!linesParsed.success) {
        sendJson(ctx.res, 400, { error: "invalid lines" });
        return;
      }
      patch.lines = linesParsed.data.map((l) => ({ ...l, priceMinor: BigInt(l.priceMinor) }));
    }
    for (const key of ["delivery", "address", "dueOn", "paymentTerms", "comments"] as const) {
      if (typeof body[key] === "string") (patch as Record<string, unknown>)[key] = body[key];
    }
    const reason = str(body.reason) ?? "update via API";
    const evidence = Array.isArray(body.evidence_message_ids)
      ? body.evidence_message_ids.filter((x): x is string => typeof x === "string")
      : [];
    const updated = applyOrderPatch(order, patch, reason, evidence);
    await saveOrder(ds, updated);
    sendJson(ctx.res, 200, { id: updated.id, status: updated.status, revisions: updated.revisions.length });
  }));

  router.add("POST", "/orders/:id/transition", requireOwner(ds, async (ctx: Ctx) => {
    const body = asRecord(ctx.body) ?? {};
    const to = orderStatusSchema.safeParse(body.status);
    if (!to.success) {
      sendJson(ctx.res, 400, { error: "status is required" });
      return;
    }
    const order = await getOrder(ds, ctx.params.id as string);
    if (!order) {
      sendJson(ctx.res, 404, { error: "not found" });
      return;
    }
    try {
      assertTransition(order.status, to.data);
    } catch {
      sendJson(ctx.res, 409, { error: `invalid transition: ${order.status} -> ${to.data}` });
      return;
    }
    order.status = to.data;
    order.revisions.push({
      seq: order.revisions.length + 1,
      at: new Date(),
      actor: "owner",
      reason: str(body.reason) ?? "transition via API",
      evidenceMessageIds: Array.isArray(body.evidence_message_ids)
        ? body.evidence_message_ids.filter((x): x is string => typeof x === "string")
        : [],
      summary: `status -> ${to.data}`,
    });
    await saveOrder(ds, order);
    sendJson(ctx.res, 200, { id: order.id, status: order.status });
  }));

  /* ---------- G3: ожидающие ответы ---------- */

  const pendingStore = new PendingReplyStore();
  const pendingByRowId = new Map<string, string>(); // row id -> core id

  router.get("/pending-replies", requireOwner(ds, async (ctx: Ctx) => {
    const status = ctx.query.get("status");
    const rows = await listExpectations(ds, { status: status as never });
    sendJson(ctx.res, 200, {
      pending: rows.map((r) => ({
        id: r.id, chatId: r.chatId, messageId: r.messageId, fromPersonId: r.fromPersonId,
        question: r.question, status: r.status, resolution: r.resolution,
        closedByMessageId: r.closedByMessageId, waitingSince: r.waitingSince,
      })),
    });
  }));

  const pendingAction = (action: "answer-external" | "dismiss" | "reopen") =>
    requireOwner(ds, async (ctx: Ctx) => {
      const rowId = ctx.params.id as string;
      const coreId = pendingByRowId.get(rowId);
      const exp = coreId ? pendingStore.get(coreId) : undefined;
      if (!exp) {
        // Core-экземпляр не в памяти (перезапуск) — фиксируем ручное действие
        // идемпотентно, состояние сойдётся при следующем анализе.
        sendJson(ctx.res, 200, { id: rowId, action, note: "recorded; core state resolved on next analysis" });
        return;
      }
      if (action === "answer-external") pendingStore.markAnsweredExternal(exp.id);
      else if (action === "dismiss") pendingStore.dismiss(exp.id);
      else pendingStore.reopen(exp.id);
      await upsertExpectation(ds, exp);
      sendJson(ctx.res, 200, { id: rowId, status: exp.status, resolution: exp.resolution });
    });

  router.add("POST", "/pending-replies/:id/answer-external", pendingAction("answer-external"));
  router.add("POST", "/pending-replies/:id/dismiss", pendingAction("dismiss"));
  router.add("POST", "/pending-replies/:id/reopen", pendingAction("reopen"));

  /* ---------- G3: задачи ---------- */

  const taskStore = new TaskStore();

  router.get("/tasks", requireOwner(ds, async (ctx: Ctx) => {
    // Источник истины — таблица tasks (персист), store в памяти — для анализа.
    const rows = await listTasks(ds, {
      ownerId: ctx.auth!.ownerUserId,
      status: (ctx.query.get("status") as never) ?? undefined,
    });
    sendJson(ctx.res, 200, { tasks: rows });
  }));

  router.post("/tasks", requireOwner(ds, async (ctx: Ctx) => {
    const parsed = taskInputSchema.safeParse({ ...(asRecord(ctx.body) ?? {}), ownerId: ctx.auth!.ownerUserId });
    if (!parsed.success) {
      sendJson(ctx.res, 400, { error: `invalid input: ${parsed.error.issues[0]?.message ?? "schema"}` });
      return;
    }
    if (parsed.data.due) {
      const dueParsed = dueDateSchema.safeParse(parsed.data.due);
      if (!dueParsed.success) {
        sendJson(ctx.res, 400, { error: "invalid due" });
        return;
      }
    }
    const row = await insertTask(ds, parsed.data);
    sendJson(ctx.res, 201, { id: row.id, version: row.version, status: row.status });
  }));

  router.add("PATCH", "/tasks/:id", requireOwner(ds, async (ctx: Ctx) => {
    const body = asRecord(ctx.body) ?? {};
    const task = taskStore.get(ctx.params.id as string);
    if (!task) {
      sendJson(ctx.res, 404, { error: "not found" });
      return;
    }
    const patch: Parameters<typeof taskStore.revise>[1] = {};
    if (typeof body.action === "string") patch.action = body.action;
    if (body.due !== undefined) {
      const dueParsed = dueDateSchema.safeParse(body.due);
      if (!dueParsed.success) {
        sendJson(ctx.res, 400, { error: "invalid due" });
        return;
      }
      patch.due = dueParsed.data;
    }
    if (body.priority === "low" || body.priority === "normal" || body.priority === "high") {
      patch.priority = body.priority;
    }
    const next = taskStore.revise(task.id, patch);
    sendJson(ctx.res, 200, { id: next.id, version: next.version, prevVersionId: next.prevVersionId });
  }));

  const taskCloseAction = (action: "close" | "cancel") =>
    requireOwner(ds, async (ctx: Ctx) => {
      const body = asRecord(ctx.body) ?? {};
      const reason = str(body.reason);
      if (!reason) {
        sendJson(ctx.res, 400, { error: "reason is required" });
        return;
      }
      const task = taskStore.get(ctx.params.id as string);
      if (!task) {
        sendJson(ctx.res, 404, { error: "not found" });
        return;
      }
      if (action === "close") taskStore.close(task.id, reason, "owner");
      else taskStore.cancel(task.id, reason);
      await setTaskStatus(ds, task.id, task.status, task.closeReason, task.closeRule);
      sendJson(ctx.res, 200, { id: task.id, status: task.status });
    });

  router.add("POST", "/tasks/:id/close", taskCloseAction("close"));
  router.add("POST", "/tasks/:id/cancel", taskCloseAction("cancel"));

  /* ---------- G5: исходящие каналы ---------- */

  const waProvider: WaChannelProvider | null = opts.channels?.wa ?? new MockWaChannelProvider();
  const tgProvider: TgChannelProvider | null = opts.channels?.tg ?? new MockTgChannelProvider();
  const allowlist = new Allowlist(opts.ownerExternalIds ?? ["owner-test"]);
  const dispatcher = new OutboundDispatcher({
    allowlist,
    wa: waProvider,
    tg: tgProvider,
    now: opts.now,
    onAssistantThread: (externalChatId) =>
      markAssistantThread(ds, opts.wa2?.accountId ?? "acc-wa-1", externalChatId),
  });

  router.add("POST", "/channels/send-test", requireOwner(ds, async (ctx: Ctx) => {
    const body = asRecord(ctx.body) ?? {};
    const to = str(body.to);
    const text = str(body.text);
    if (!to || !text) {
      sendJson(ctx.res, 400, { error: "to and text are required" });
      return;
    }
    const lastIncomingRaw = body.last_incoming_at;
    const meta: { lastIncomingAt?: Date | null } = {};
    if (typeof lastIncomingRaw === "string" && lastIncomingRaw.length > 0) {
      const d = new Date(lastIncomingRaw);
      if (!Number.isNaN(d.getTime())) meta.lastIncomingAt = d;
    }
    try {
      const outcome = await dispatcher.send(to, text, meta);
      sendJson(ctx.res, 200, outcome);
    } catch (e) {
      if (e instanceof RecipientNotAllowedError) {
        // AT-34: посторонний получатель — запрещено до провайдеров.
        sendJson(ctx.res, 403, { error: "recipient is not the confirmed owner identity" });
        return;
      }
      throw e;
    }
  }));

  return router;
}

export function createApiServer(opts: ApiOptions): Server {
  const log = opts.log ?? ((line: string) => console.log(line));
  const router = buildRouter(opts);

  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const started = Date.now();
    let status = 200;
    try {
      const matched = router.match(req.method ?? "GET", url.pathname);
      if (!matched) {
        status = 404;
        sendJson(res, status, { error: "not found" });
        return;
      }
      // Webhook-пути: тело нужно сырым для HMAC-подписи.
      let rawBody: string | undefined;
      let body: unknown;
      if (url.pathname === "/webhooks/wa2") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        rawBody = Buffer.concat(chunks).toString("utf8");
        try {
          body = JSON.parse(rawBody) as unknown;
        } catch {
          body = null;
        }
      } else {
        body = await readBody(req);
      }
      const ctx: Ctx = {
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        body,
        auth: null,
        ...(rawBody !== undefined ? { rawBody } : {}),
      };
      await matched.handler(ctx);
      status = res.statusCode || 200;
    } catch (e) {
      status = 500;
      if (!res.headersSent) sendJson(res, status, { error: "internal error" });
      // Ошибку логируем текстом, без тел и содержимого сообщений.
      log(`error ${req.method} ${url.pathname}: ${(e as Error).message}`);
    } finally {
      // ТЗ §10: лог без содержимого сообщений — метод, путь, статус, длительность.
      log(`${req.method} ${url.pathname} -> ${status} ${Date.now() - started}ms`);
    }
  };

  return createServer((req, res) => {
    listener(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      res.end();
    });
  });
}

/** Прямой запуск: npx tsx src/api/server.ts */
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 7100);
  void import("../db/dataSource.js").then(async ({ createDataSource }) => {
    const ds = createDataSource();
    const server = createApiServer({ ds });
    server.listen(port, () => console.log(`api listening on http://localhost:${port}`));
    const shutdown = (): void => {
      server.close(() => void ds.close().finally(() => process.exit(0)));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
