import type {
  AdapterCapabilities,
  AdapterState,
  FetchHistoryResult,
  HistoryCursor,
  MediaDownloadResult,
  SourceAdapter,
} from "../contracts/adapter.js";
import type { RawMessageEvent } from "../contracts/events.js";
import {
  buildDemoSteps,
  demoMessageId,
  type DemoStep,
} from "./demoData.js";

/**
 * Демо-адаптер (G5-4): источник детерминированных синтетических событий.
 * Реализует контракт SourceAdapter: pollEvents() отдаёт следующую порцию
 * сценария, затем пустые массивы — повторные poll того же сценария
 * не порождают новых событий (idempotency на стороне ingest, AT-06).
 */

export interface DemoAdapterOptions {
  /** Ключ аккаунта (wa-1, wa-2, tg-1, tg-2) — фильтрует шаги сценария. */
  accountKey: string;
  /** Сколько шагов отдаём за один poll. */
  batchSize?: number;
  /** Базовое время сценария: atMin сдвигает sentAt от него. */
  baseTime?: Date;
}

export class DemoSourceAdapter implements SourceAdapter {
  readonly name: string;
  private state: AdapterState = "live";
  private readonly steps: DemoStep[];
  private cursor = 0;
  private readonly batchSize: number;
  private readonly baseTime: Date;

  private static readonly caps: AdapterCapabilities = {
    liveEvents: true,
    historyBackfill: false,
    historyImport: false,
    mediaDownload: false,
    sendMessages: false,
    editTracking: false,
    deleteTracking: false,
  };

  constructor(opts: DemoAdapterOptions) {
    this.name = `demo-${opts.accountKey}`;
    this.steps = buildDemoSteps().filter((s) => s.accountKey === opts.accountKey);
    this.batchSize = opts.batchSize ?? 3;
    this.baseTime = opts.baseTime ?? new Date("2026-10-08T08:00:00Z");
  }

  getCapabilities(): AdapterCapabilities {
    return { ...DemoSourceAdapter.caps };
  }

  getState(): AdapterState {
    return this.state;
  }

  /** Один poll: следующая порция шагов; сценарий исчерпан → []. */
  async pollEvents(): Promise<RawMessageEvent[]> {
    const slice = this.steps.slice(this.cursor, this.cursor + this.batchSize);
    this.cursor += slice.length;
    return slice.map((s) => this.toEvent(s));
  }

  async *streamEvents(): AsyncIterable<RawMessageEvent> {
    for (let e = await this.pollEvents(); e.length > 0; e = await this.pollEvents()) {
      for (const ev of e) yield ev;
    }
  }

  fetchHistory(_cursor: HistoryCursor): Promise<FetchHistoryResult> {
    return Promise.reject(new Error("demo adapter: history backfill not supported"));
  }

  downloadMedia(_ref: string): Promise<MediaDownloadResult> {
    return Promise.reject(new Error("demo adapter: media download not supported"));
  }

  async disconnect(): Promise<void> {
    this.state = "disconnected";
  }

  private toEvent(s: DemoStep): RawMessageEvent {
    const event: RawMessageEvent = {
      externalChatId: s.chatExternalId,
      externalMessageId: demoMessageId(s),
      authorExternalId: `demo:${s.personKey}`,
      direction: s.direction,
      sentAt: new Date(this.baseTime.getTime() + s.atMin * 60_000),
      text: s.text,
    };
    if (s.voice) event.mediaRefs = [{ externalId: `${demoMessageId(s)}-voice`, mime: "audio/ogg" }];
    return event;
  }
}
