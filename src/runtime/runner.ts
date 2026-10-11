import type { DataSource } from "../db/dataSource.js";
import { upsertChat, insertMessage } from "../db/repos/ingestRepo.js";
import { upsertExpectation, listExpectations } from "../db/repos/pendingRepo.js";
import { insertTask } from "../db/repos/tasksRepo.js";
import { addEvent } from "../db/repos/settlementsRepo.js";
import { PendingReplyStore, type Expectation } from "../core/pendingReplies.js";
import { TaskStore, parseRelativeDue } from "../core/tasks.js";
import { Scheduler } from "../core/scheduler.js";
import { EmbeddingIndexer } from "../core/embeddings/indexer.js";
import {
  MockEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
  type EmbeddingProvider,
} from "../core/embeddings/provider.js";
import { Allowlist } from "../core/channels/allowlist.js";
import { OutboundDispatcher } from "../core/channels/outbound.js";
import {
  MockTgChannelProvider,
  MockWaChannelProvider,
} from "../core/channels/providers.js";
import type { SourceAdapter } from "../contracts/adapter.js";
import type { RawMessageEvent } from "../contracts/events.js";
import { createOwnerUser } from "../auth/service.js";
import { DemoSourceAdapter } from "./demoAdapters.js";
import {
  DEMO_OWNER_DISPLAY,
  DEMO_OWNER_PERSON,
  DEMO_PEOPLE,
  demoUuid,
  extractFinancialCue,
} from "./demoData.js";

/**
 * Runtime-оркестратор (G5-4): сводит адаптеры → ingest → анализ
 * (pendingReplies, tasks, settlements-кандидаты) → индексация эмбеддингов
 * → outbound (сводка, напоминания) в единый исполняемый цикл.
 * Без реальных подключений: каналы — mock, источники — demo
 * (waha/tdlib/webhook — только валидация конфига, live-подключение
 * требует секретов и делается на G6).
 */

export interface SourceConfig {
  name: string;
  /** demo работает без секретов; waha/tdlib/webhook — не поднимаются без env. */
  type: "demo" | "waha" | "tdlib" | "webhook";
  platform?: "whatsapp" | "telegram";
  connectionType?: "live" | "coexistence" | "import_only";
}

export interface RuntimeConfig {
  ownerExternalId: string;
  sources: SourceConfig[];
  embeddings: { kind: "mock" | "openai-compatible"; dim?: number; baseUrl?: string; apiKey?: string; model?: string };
  channels: { kind: "mock" };
  schedules: {
    pollMs?: number;
    indexMs?: number;
    digestMs?: number;
    /** Через сколько после вопроса напоминаем владельцу. */
    reminderAfterMs?: number;
  };
  demo?: { seed?: number; ownerPassword?: string; username?: string };
}

export interface RuntimeDeps {
  ds: DataSource;
  config: RuntimeConfig;
  /** Для тестов: готовые адаптеры по имени источника. */
  adapters?: Map<string, SourceAdapter>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface PollSummary {
  source: string;
  polled: number;
  inserted: number;
  duplicates: number;
  updated: number;
  pendingCreated: number;
  tasksCreated: number;
  financialEvents: number;
}

export function createEmbeddingProvider(cfg: RuntimeConfig["embeddings"]): EmbeddingProvider {
  // dim по умолчанию 1536 = размер колонки message_embeddings.vector(1536):
  // меньшая размерность сломает INSERT на реальной БД (PGlite/postgres).
  if (cfg.kind === "mock") return new MockEmbeddingProvider({ dim: cfg.dim ?? 1536 });
  return new OpenAiCompatibleEmbeddingProvider({
    baseUrl: cfg.baseUrl ?? "",
    apiKey: cfg.apiKey ?? "",
    model: cfg.model ?? "text-embedding-3-small",
  });
}

/** Фабрика адаптеров: demo — полностью; остальное — только с env (иначе null). */
export function createAdapterForSource(src: SourceConfig, env: NodeJS.ProcessEnv): SourceAdapter | null {
  if (src.type === "demo") {
    return new DemoSourceAdapter({ accountKey: src.name });
  }
  // waha/tdlib/webhook требуют секретов и live-окружения (G6).
  // Здесь — честный пропуск: без env подключение не поднимается.
  const required: Record<string, string[]> = {
    waha: ["WAHA_BASE_URL"],
    tdlib: ["TG_API_ID", "TG_API_HASH"],
    webhook: ["WA2_APP_SECRET"],
  };
  const missing = required[src.type]!.filter((k) => !env[k]);
  if (missing.length > 0) return null;
  return null; // создание live-адаптеров — G6; безопасный no-op
}

export class RuntimeRunner {
  readonly channels: { wa: MockWaChannelProvider; tg: MockTgChannelProvider };
  private readonly ds: DataSource;
  private readonly config: RuntimeConfig;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly pending = new PendingReplyStore();
  private readonly taskStore = new TaskStore();
  private readonly scheduler = new Scheduler();
  private readonly indexer: EmbeddingIndexer;
  private readonly dispatcher: OutboundDispatcher;
  private ownerId: string | null = null;
  private personIds = new Map<string, string>(); // authorExternalId → person_id
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopping = false;
  private started = false;
  private loop: Promise<void> | null = null;
  private sentReminders = new Set<string>();
  private reminderTexts = new Map<string, string>();
  private finEvidence = new Set<string>();
  private lastPollAt = new Map<string, number>();
  private digestRound = 0;

  constructor(deps: RuntimeDeps) {
    this.ds = deps.ds;
    this.config = deps.config;
    this.log = deps.log ?? ((l) => console.log(l));
    this.now = deps.now ?? (() => new Date());
    const provider = createEmbeddingProvider(deps.config.embeddings);
    const dim = "dim" in provider ? (provider as { dim: number }).dim : 1536;
    this.indexer = new EmbeddingIndexer(this.ds, provider, { expectedDim: dim });
    this.channels = { wa: new MockWaChannelProvider(), tg: new MockTgChannelProvider() };
    this.dispatcher = new OutboundDispatcher({
      allowlist: new Allowlist([deps.config.ownerExternalId]),
      wa: this.channels.wa,
      tg: this.channels.tg,
    });
    for (const src of deps.config.sources) {
      const a = deps.adapters?.get(src.name) ?? createAdapterForSource(src, process.env);
      if (a) this.adapters.set(src.name, a);
      else this.log(`source ${src.name} (${src.type}): skipped — not configured in this environment`);
    }
  }

  /** Сид: владелец, аккаунты, люди, идентичности, учётка для входа. Идемпотентно. */
  async seedDemo(): Promise<void> {
    const owner = await this.ds.query<{ id: string }>(
      `INSERT INTO owners (id, display_name, timezone) VALUES ($1, $2, 'UTC')
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [OWNER_UUID, DEMO_OWNER_DISPLAY],
    );
    this.ownerId = owner.rows[0]?.id ?? OWNER_UUID;

    const accountRows = await this.ds.query<{ id: string; adapter: string }>(`SELECT id, adapter FROM accounts`);
    const known = new Set(accountRows.rows.map((r) => r.adapter));
    for (const src of this.config.sources) {
      if (known.has(src.name)) continue;
      await this.ds.query(
        `INSERT INTO accounts (owner_id, platform, adapter, own_external_id, connection_type, state)
         VALUES ($1, $2, $3, $4, $5, 'live')`,
        [this.ownerId, src.platform ?? "whatsapp", src.name, `${src.name}-demo`, src.connectionType ?? "live"],
      );
    }

    // Люди: владелец + демо-собеседники; идентичности по authorExternalId.
    for (const p of [{ key: DEMO_OWNER_PERSON, displayName: DEMO_OWNER_DISPLAY, authorExternalId: DEMO_OWNER_PERSON }, ...DEMO_PEOPLE]) {
      const pid = demoUuid(`person:${p.key}`);
      await this.ds.query(
        `INSERT INTO persons (id, owner_id, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [pid, this.ownerId, p.displayName],
      );
      this.personIds.set(p.authorExternalId, pid);
      await this.ds.query(
        `INSERT INTO identities (person_id, external_id, id_scope, source, confirmed)
         VALUES ($1, $2, 'demo:person', 'demo', true)
         ON CONFLICT (id_scope, external_id) DO NOTHING`,
        [pid, p.authorExternalId],
      );
    }

    // Учётка владельца для входа в API/веб (демо-пароль, только demo-режим).
    const username = this.config.demo?.username ?? "demo";
    const existing = await this.ds.query(`SELECT id FROM owner_users WHERE username = $1`, [username]);
    if (existing.rows.length === 0) {
      await createOwnerUser(this.ds, this.ownerId, username, this.config.demo?.ownerPassword ?? "demo-password");
      this.log(`demo owner login: ${username} / ${this.config.demo?.ownerPassword ?? "demo-password"}`);
    }
  }

  /** Тик poll по одному источнику: события → ingest → анализ. */
  async pollOnce(sourceName: string): Promise<PollSummary> {
    const adapter = this.adapters.get(sourceName);
    const summary: PollSummary = {
      source: sourceName, polled: 0, inserted: 0, duplicates: 0, updated: 0,
      pendingCreated: 0, tasksCreated: 0, financialEvents: 0,
    };
    if (!adapter) return summary;
    const accountId = await this.accountIdFor(sourceName);
    const events = await adapter.pollEvents();
    summary.polled = events.length;
    this.lastPollAt.set(sourceName, this.now().getTime());
    if (events.length === 0) return summary;

    // Группировка по чатам — транзакционный батч на чат.
    const byChat = new Map<string, RawMessageEvent[]>();
    for (const e of events) {
      const list = byChat.get(e.externalChatId) ?? [];
      list.push(e);
      byChat.set(e.externalChatId, list);
    }

    for (const [externalChatId, batch] of byChat) {
      const chat = await upsertChat(this.ds, accountId, externalChatId, {});
      for (const e of batch) {
        const status = await insertMessage(this.ds, chat.id, {
          accountId,
          externalChatId,
          externalMessageId: e.externalMessageId,
          author: e.authorExternalId,
          direction: e.direction,
          sentAt: e.sentAt,
          text: e.text,
          isSystem: e.isSystem ?? false,
        });
        summary[status === "inserted" ? "inserted" : status === "updated" ? "updated" : "duplicates"] += 1;
        if (status !== "inserted") continue;

        const internal = await this.findMessageId(accountId, chat.id, e.externalMessageId);
        if (!internal) continue;

        // --- анализ вновь вставленного сообщения ---
        if (e.direction === "in") {
          const exps = this.pending.proposeFromIncoming([{
            messageId: internal, chatId: chat.id, chatType: "direct",
            isAssistantThread: false, authorExternalId: e.authorExternalId,
            direction: "in", text: e.text, sentAt: e.sentAt,
          }], this.now());
          for (const exp of exps) {
            await upsertExpectation(this.ds, exp);
            this.scheduleReminder(exp);
            summary.pendingCreated += 1;
          }

          const cue = extractFinancialCue(e.text);
          const personId = this.personIds.get(e.authorExternalId) ?? null;
          if (cue && personId && !this.finEvidence.has(internal)) {
            this.finEvidence.add(internal);
            await addEvent(this.ds, {
              fromPersonId: personId,
              toPersonId: this.personIds.get(DEMO_OWNER_PERSON)!,
              type: cue.type,
              amountMinor: cue.amountMinor,
              currency: cue.currency,
              occurredOn: e.sentAt.toISOString().slice(0, 10),
              origin: "extracted",
              evidenceMessageIds: [internal],
            });
            summary.financialEvents += 1;
          }
        }

        const due = parseRelativeDue(e.text, this.now(), "UTC");
        if (due && e.direction === "in") {
          const t = this.taskStore.upsert({
            assignee: "owner",
            personId: this.personIds.get(e.authorExternalId) ?? null,
            action: e.text.slice(0, 120),
            source: `runtime:${sourceName}`,
            due, // ParsedDue — это и есть relative-DueDate
            priority: "normal",
          }, this.now());
          if (this.ownerId) {
            await insertTask(this.ds, {
              ownerId: this.ownerId, assignee: "owner", personId: t.personId,
              action: t.action, source: t.source, due: t.due, priority: t.priority,
            });
            summary.tasksCreated += 1;
          }
        }
      }
    }
    if (summary.inserted > 0 || summary.polled > 0) {
      this.log(`poll ${sourceName}: ${summary.polled} events, inserted=${summary.inserted} dup=${summary.duplicates} pending+=${summary.pendingCreated} fin+=${summary.financialEvents} tasks+=${summary.tasksCreated}`);
    }
    return summary;
  }

  /** Один прогон индексации эмбеддингов. */
  async indexOnce(): Promise<{ embedded: number; selected: number }> {
    const stats = await this.indexer.runOnce();
    if (stats.embedded > 0) this.log(`indexer: embedded=${stats.embedded} (calls=${stats.providerCalls})`);
    return stats;
  }

  /** Тик scheduler: сводка + напоминания → outbound (только владелец, AT-34). */
  async dispatchDue(): Promise<void> {
    await this.scheduler.runDue(this.now(), async (task) => {
      if (task.action === "digest") {
        const counts = await this.counts();
        const text = `Сводка: сообщений ${counts.messages}, ожиданий ответа ${counts.pending}, задач ${counts.tasks}, финсобытий ${counts.financial}.`;
        const outcome = await this.dispatcher.send(this.config.ownerExternalId, text, { lastIncomingAt: this.now() });
        this.log(`digest sent via ${"platform" in outcome ? outcome.platform : "none"} (${outcome.status})`);
        this.digestRound += 1;
        this.scheduler.schedule({
          key: `digest#${this.digestRound}`, action: "digest",
          runAt: new Date(this.now().getTime() + (this.config.schedules.digestMs ?? 30_000)),
        }, this.now());
        return outcome.status === "sent" || outcome.status === "degraded"
          ? { ok: true }
          : { ok: false, error: `digest outcome ${outcome.status}` };
      }
      if (task.action === "reminder") {
        const text = this.reminderTexts.get(task.key) ?? "Напоминание";
        const outcome = await this.dispatcher.send(this.config.ownerExternalId, text, {
          lastIncomingAt: this.now(),
        });
        this.log(`reminder sent via ${"platform" in outcome ? outcome.platform : "none"} (${outcome.status})`);
        return outcome.status === "sent" || outcome.status === "degraded"
          ? { ok: true }
          : { ok: false, error: `reminder outcome ${outcome.status}` };
      }
      return { ok: true };
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const s = this.config.schedules;
    if (this.digestRound === 0 && !this.scheduler.get("digest#0")) {
      this.scheduler.schedule({ key: "digest#0", action: "digest", runAt: new Date(this.now().getTime() + (s.digestMs ?? 30_000)) }, this.now());
    }
    const tick = async (): Promise<void> => {
      if (this.stopping) return;
      for (const name of this.adapters.keys()) {
        await this.pollOnce(name);
        if (this.stopping) return;
      }
      await this.dispatchDue();
    };
    this.loop = (async () => {
      while (!this.stopping) {
        await tick();
        await sleep(s.pollMs ?? 2000, () => this.stopping);
      }
    })();
    if (s.indexMs) {
      this.timers.push(setInterval(() => {
        if (!this.stopping) void this.indexOnce().catch((e) => this.log(`indexer error: ${(e as Error).message}`));
      }, s.indexMs));
    }
  }

  /** Graceful shutdown: флаг → текущий тик доводится (батчи не рвутся). */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.loop) await this.loop.catch(() => undefined);
    for (const a of this.adapters.values()) await a.disconnect().catch(() => undefined);
  }

  /** Сколько напоминание-задач запланировано (для тестов/наблюдения). */
  get remindersPlanned(): number {
    return this.sentReminders.size;
  }

  private scheduleReminder(exp: Expectation): void {
    const key = `remind:${exp.id}`;
    if (this.sentReminders.has(key)) return;
    this.reminderTexts.set(key, `Ждёт ответа: ${exp.question.slice(0, 80)} (с ${exp.questionSentAt.toISOString().slice(0, 16)})`);
    this.scheduler.schedule({
      key,
      action: "reminder",
      runAt: new Date(exp.questionSentAt.getTime() + (this.config.schedules.reminderAfterMs ?? 60_000)),
      maxAttempts: 2,
    }, this.now());
    this.sentReminders.add(key);
  }

  private async accountIdFor(adapterName: string): Promise<string> {
    const r = await this.ds.query<{ id: string }>(`SELECT id FROM accounts WHERE adapter = $1`, [adapterName]);
    const row = r.rows[0];
    if (!row) throw new Error(`runtime: account not found for adapter ${adapterName} (seedDemo first)`);
    return row.id;
  }

  private async findMessageId(accountId: string, chatId: string, externalMessageId: string): Promise<string | null> {
    const r = await this.ds.query<{ id: string }>(
      `SELECT id FROM messages WHERE account_id = $1 AND chat_id = $2 AND message_id = $3`,
      [accountId, chatId, externalMessageId],
    );
    return r.rows[0]?.id ?? null;
  }

  private async counts(): Promise<{ messages: number; pending: number; tasks: number; financial: number }> {
    const q = async (table: string): Promise<number> => {
      const r = await this.ds.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      return r.rows[0]?.n ?? 0;
    };
    return {
      messages: await q("messages"),
      pending: (await listExpectations(this.ds, { status: "pending" })).length
        + (await listExpectations(this.ds, { status: "proposed" })).length,
      tasks: await q("tasks"),
      financial: await q("financial_events"),
    };
  }
}

const OWNER_UUID = demoUuid("owner:demo");
function sleep(ms: number, stopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(check, Math.min(ms, 250));
    function check(): void {
      if (stopped() || ms <= 250) return resolve();
      ms -= 250;
      setTimeout(check, Math.min(ms, 250));
    }
  });
}
