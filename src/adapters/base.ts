import {
  UnsupportedOperationError,
  type AdapterCapabilities,
  type AdapterState,
  type FetchHistoryResult,
  type HistoryCursor,
  type MediaDownloadResult,
  type SourceAdapter,
} from "../contracts/adapter.js";
import type { RawMessageEvent } from "../contracts/events.js";

/**
 * Базовая заглушка адаптера в состоянии not_configured.
 * Никаких реальных подключений и секретов: все сетевые операции
 * бросают UnsupportedOperationError, состояние меняется только
 * в пределах локального жизненного цикла (реального подключения нет).
 */
export abstract class NotConfiguredAdapter implements SourceAdapter {
  abstract readonly name: string;
  protected state: AdapterState = "not_configured";

  abstract getCapabilities(): AdapterCapabilities;

  getState(): AdapterState {
    return this.state;
  }

  protected unsupported<T>(operation: string): T {
    throw new UnsupportedOperationError(this.name, operation);
  }

  async fetchHistory(_cursor: HistoryCursor): Promise<FetchHistoryResult> {
    return this.unsupported("fetchHistory");
  }

  async *streamEvents(): AsyncIterable<RawMessageEvent> {
    throw new UnsupportedOperationError(this.name, "streamEvents");
  }

  async pollEvents(): Promise<RawMessageEvent[]> {
    return this.unsupported("pollEvents");
  }

  async downloadMedia(_ref: string): Promise<MediaDownloadResult> {
    return this.unsupported("downloadMedia");
  }

  async disconnect(): Promise<void> {
    this.state = "disconnected";
  }
}
