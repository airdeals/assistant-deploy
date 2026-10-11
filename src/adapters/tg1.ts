import { NotConfiguredAdapter } from "./base.js";
import type { AdapterCapabilities } from "../contracts/adapter.js";

/**
 * tg1 — Telegram через TDLib, полноценный клиент.
 * Доступны live-события, бэкфилл истории и медиа.
 */
export class Tg1Adapter extends NotConfiguredAdapter {
  readonly name = "tg1";

  private static readonly caps: AdapterCapabilities = {
    liveEvents: true,
    historyBackfill: true,
    historyImport: true,
    mediaDownload: true,
    sendMessages: false,
    editTracking: true,
    deleteTracking: true,
  };

  getCapabilities(): AdapterCapabilities {
    return { ...Tg1Adapter.caps };
  }
}
