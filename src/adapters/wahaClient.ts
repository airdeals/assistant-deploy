import type { DataSource } from "../db/dataSource.js";
import type {
  AdapterCapabilities,
  AdapterState,
  FetchHistoryResult,
  HistoryCursor,
  MediaDownloadResult,
  SourceAdapter,
} from "../contracts/adapter.js";
import type { RawMessageEvent } from "../contracts/events.js";
import { getCheckpoint, saveCheckpoint } from "../db/repos/ingestRepo.js";

/**
 * WAHA-клиент (NOWEB/GOWS) и адаптер WA-1 поверх него, G4.
 * Только HTTP-обёртка: baseUrl/apiKey — из конфига, ничего не хардкодим.
 * В тестах transport инжектируется (fetch мокается), реальные подключения
 * не создаются.
 */

export interface HttpTransport {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

/** Transport по умолчанию поверх fetch; apiKey — только из конфига. */
export function fetchTransport(baseUrl: string, opts: { apiKey?: string | undefined; fetchImpl?: typeof fetch } = {}): HttpTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`WAHA HTTP ${res.status} for ${method} ${path}`);
    const text = await res.text();
    return text.length > 0 ? (JSON.parse(text) as unknown) : null;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
  };
}

export interface WahaConfig {
  session: string;
  transport: HttpTransport;
}

export interface WahaSessionInfo {
  name: string;
  status: string;
}

export interface WahaMessage {
  id: string;
  /** Внешний id чата (phone/группа). */
  from: string;
  to?: string;
  /** Свои сообщения — с телефона владельца. */
  fromMe: boolean;
  /** Unix seconds. */
  timestamp: number;
  body?: string;
  hasMedia?: boolean;
  /** Идентификатор медиа для скачивания. */
  mediaId?: string;
  mimetype?: string;
}

export class WahaClient {
  constructor(private readonly cfg: WahaConfig) {}

  getSession(): Promise<WahaSessionInfo> {
    return this.cfg.transport.get(`/api/sessions/${encodeURIComponent(this.cfg.session)}`) as Promise<WahaSessionInfo>;
  }

  requestPairingQr(): Promise<{ qr: string }> {
    return this.cfg.transport.post(`/api/${encodeURIComponent(this.cfg.session)}/auth/qr`) as Promise<{ qr: string }>;
  }

  /** Выборка сообщений; since — unix seconds, отсекаем на сервере. */
  async getMessages(opts: { chatId?: string | undefined; limit?: number | undefined; offsetDate?: number | undefined } = {}): Promise<WahaMessage[]> {
    const p = new URLSearchParams();
    if (opts.chatId !== undefined) p.set("chatId", opts.chatId);
    p.set("limit", String(opts.limit ?? 100));
    if (opts.offsetDate !== undefined) p.set("offsetDate", String(opts.offsetDate));
    const res = await this.cfg.transport.get(`/api/${encodeURIComponent(this.cfg.session)}/messages?${p.toString()}`);
    return Array.isArray(res) ? (res as WahaMessage[]) : [];
  }

  /** Скачивание медиа: WAHA возвращает base64 в JSON. */
  async downloadMedia(mediaId: string): Promise<{ mime: string; bytes: Uint8Array }> {
    const res = (await this.cfg.transport.get(
      `/api/${encodeURIComponent(this.cfg.session)}/media/${encodeURIComponent(mediaId)}`,
    )) as { mimetype?: string; data?: string };
    return {
      mime: res.mimetype ?? "application/octet-stream",
      bytes: new Uint8Array(Buffer.from(res.data ?? "", "base64")),
    };
  }
}

/** WAHA message → RawMessageEvent: fromMe → direction "out", голосовые/медиа — attachment-ref. */
export function normalizeWahaMessage(m: WahaMessage): RawMessageEvent {
  const event: RawMessageEvent = {
    externalChatId: m.from,
    externalMessageId: m.id,
    authorExternalId: m.fromMe ? "me" : m.from,
    direction: m.fromMe ? "out" : "in",
    sentAt: new Date(m.timestamp * 1000),
    text: m.body ?? "",
  };
  if (m.hasMedia && m.mediaId) {
    event.mediaRefs = [{ externalId: m.mediaId, ...(m.mimetype ? { mime: m.mimetype } : {}) }];
  }
  return event;
}

interface WahaCheckpoint {
  offsetDate: number | null;
}

/**
 * Адаптер WA-1 (WAHA NOWEB/GOWS): poll-цикл с checkpoint в
 * sync_checkpoints. Повторный poll продолжает с последнего
 * offsetDate — повторная выборка не дублирует события; ingest
 * дополнительно идемпотентен по натуральному ключу (AT-06).
 */
export class WahaWa1Adapter implements SourceAdapter {
  readonly name = "wa1-waha";
  private state: AdapterState = "connecting";

  private static readonly caps: AdapterCapabilities = {
    liveEvents: true,
    historyBackfill: true,
    historyImport: false,
    mediaDownload: true,
    sendMessages: false,
    editTracking: false,
    deleteTracking: false,
  };

  constructor(
    private readonly deps: { ds: DataSource; accountId: string; client: WahaClient },
  ) {}

  getCapabilities(): AdapterCapabilities {
    return { ...WahaWa1Adapter.caps };
  }

  getState(): AdapterState {
    return this.state;
  }

  private async loadCheckpoint(): Promise<WahaCheckpoint> {
    const raw = await getCheckpoint(this.deps.ds, this.deps.accountId);
    if (raw !== null && typeof raw === "object") {
      const c = raw as { offsetDate?: unknown };
      return { offsetDate: typeof c.offsetDate === "number" ? c.offsetDate : null };
    }
    return { offsetDate: null };
  }

  /** Один poll: сообщения после checkpoint → нормализация → новый checkpoint. */
  async pollEvents(): Promise<RawMessageEvent[]> {
    const since = await this.loadCheckpoint();
    const messages = await this.deps.client.getMessages(
      since.offsetDate !== null ? { offsetDate: since.offsetDate } : {},
    );
    const events = messages.map(normalizeWahaMessage);
    const maxTs = messages.reduce<number | null>((acc, m) => {
      const t = Math.floor(m.timestamp);
      return acc === null || t > acc ? t : acc;
    }, null);
    if (maxTs !== null) {
      await saveCheckpoint(this.deps.ds, this.deps.accountId, { offsetDate: maxTs });
    }
    this.state = "live";
    return events;
  }

  /** Бэкфилл: тот же poll, но курсор берём из аргумента. */
  async fetchHistory(cursor: HistoryCursor): Promise<FetchHistoryResult> {
    const start = ((): number | null => {
      if (cursor.value === null) return null;
      try {
        const parsed = JSON.parse(cursor.value) as { offsetDate?: unknown };
        return typeof parsed.offsetDate === "number" ? parsed.offsetDate : null;
      } catch {
        return null;
      }
    })();
    const messages = await this.deps.client.getMessages(start !== null ? { offsetDate: start } : {});
    const events = messages.map(normalizeWahaMessage);
    const maxTs = messages.reduce<number | null>((acc, m) => {
      const t = Math.floor(m.timestamp);
      return acc === null || t > acc ? t : acc;
    }, null);
    return {
      events,
      nextCursor: { value: maxTs !== null ? JSON.stringify({ offsetDate: maxTs }) : null },
    };
  }

  /** Поллинговый стрим: pollEvents() с паузой. Не используется в тестах. */
  async *streamEvents(): AsyncIterable<RawMessageEvent> {
    for (;;) {
      const events = await this.pollEvents();
      for (const e of events) yield e;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  async downloadMedia(ref: string): Promise<MediaDownloadResult> {
    const { mime, bytes } = await this.deps.client.downloadMedia(ref);
    return { ref, mime, bytes };
  }

  async disconnect(): Promise<void> {
    this.state = "disconnected";
  }
}
