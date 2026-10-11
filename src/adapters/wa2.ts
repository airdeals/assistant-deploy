import { NotConfiguredAdapter } from "./base.js";
import type { AdapterCapabilities } from "../contracts/adapter.js";

/**
 * wa2 — WhatsApp в режиме coexistence (основное приложение остаётся
 * активным, события приходят webhook-ом на сопряжённое устройство).
 * Live-события и скачивание вложений доступны; история — только импортом.
 * Исходящие отключены: ассистент read-mostly.
 */
export class Wa2Adapter extends NotConfiguredAdapter {
  readonly name = "wa2";

  private static readonly caps: AdapterCapabilities = {
    liveEvents: true,
    historyBackfill: false,
    historyImport: true,
    mediaDownload: true,
    sendMessages: false,
    editTracking: true,
    deleteTracking: true,
  };

  getCapabilities(): AdapterCapabilities {
    return { ...Wa2Adapter.caps };
  }
}
