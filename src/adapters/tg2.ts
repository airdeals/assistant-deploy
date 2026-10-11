import { NotConfiguredAdapter } from "./base.js";
import type { AdapterCapabilities } from "../contracts/adapter.js";

/**
 * tg2 — Telegram через TDLib в ограниченном режиме (история недоступна
 * даже через бэкфилл — например, из-за настроек приватности/спама).
 * События доступны только с момента подключения; старая история —
 * только импортом result.json (parseTgExport). Медиа по старым
 * сообщениям недоступно.
 */
export class Tg2Adapter extends NotConfiguredAdapter {
  readonly name = "tg2";

  private static readonly caps: AdapterCapabilities = {
    liveEvents: true,
    historyBackfill: false,
    historyImport: true,
    mediaDownload: true,
    sendMessages: false,
    editTracking: true,
    deleteTracking: false,
  };

  getCapabilities(): AdapterCapabilities {
    return { ...Tg2Adapter.caps };
  }
}
