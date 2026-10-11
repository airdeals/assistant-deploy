import { NotConfiguredAdapter } from "./base.js";
import type { AdapterCapabilities } from "../contracts/adapter.js";

/**
 * wa1 — обычный WhatsApp (одно устройство), режим read-mostly.
 * Live-канал и бэкфилл истории недоступны: история попадает только
 * через импорт экспортированного чата (parseWaExport).
 */
export class Wa1Adapter extends NotConfiguredAdapter {
  readonly name = "wa1";

  private static readonly caps: AdapterCapabilities = {
    liveEvents: false,
    historyBackfill: false,
    historyImport: true,
    mediaDownload: false,
    sendMessages: false,
    editTracking: false,
    deleteTracking: false,
  };

  getCapabilities(): AdapterCapabilities {
    return { ...Wa1Adapter.caps };
  }
}
