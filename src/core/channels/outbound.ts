import { Allowlist } from "./allowlist.js";
import type { TgChannelProvider, WaChannelProvider } from "./providers.js";

/**
 * Диспетчер исходящих сообщений владельцу (G5).
 * - allowlist ПЕРЕД провайдерами: посторонний получатель отклонён до любой
 *   отправки (AT-34), в логах провайдеров — пусто;
 * - окно WhatsApp: free-form внутри 24 ч от последнего входящего владельца;
 *   вне окна — utility-шаблон; шаблон не одобрен / канал не настроен —
 *   честная деградация в Telegram, иначе статус "deferred" (AT-25/AT-33);
 * - разбивка длинных ответов по лимиту платформы (4096) с сохранением
 *   пагинации «ещё →»;
 * - своя переписка помощника помечается is_assistant_thread (AT-37) —
 *   через onAssistantThread-колбэк (в wiring — UPDATE chats).
 */

/** 24-часовое окно free-form от последнего входящего. */
export const WA_FREE_FORM_WINDOW_MS = 24 * 3600 * 1000;
/** Лимит текста одного сообщения платформы. */
export const PLATFORM_TEXT_LIMIT = 4096;

/** Имя utility-шаблона по умолчанию. */
export const UTILITY_TEMPLATE = "utility_update";

/**
 * Разбивка длинного текста по лимиту. Части, кроме последней, заканчиваются
 * маркером « (ещё →)», продолжения начинаются с «…» — пагинация сохраняется
 * при чтении подряд. Разбиение — по абзацам, затем по словам.
 */
export function splitMessage(text: string, limit: number = PLATFORM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  const marker = " (ещё →)";
  const cont = "…";
  const budget = limit - marker.length;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", budget);
    if (cut < Math.floor(budget / 2)) cut = rest.lastIndexOf(" ", budget);
    if (cut < Math.floor(budget / 2)) cut = budget;
    parts.push(rest.slice(0, cut).trimEnd() + marker);
    rest = cont + rest.slice(cut).trimStart();
  }
  parts.push(rest);
  return parts;
}

export type SendOutcome =
  | { status: "sent"; platform: "wa"; mode: "freeform" | "template"; parts: number; messageIds: string[] }
  | { status: "sent"; platform: "tg"; parts: number; messageIds: string[] }
  | { status: "degraded"; platform: "tg"; reason: string; parts: number; messageIds: string[] }
  | { status: "deferred"; reason: string; parts: number };

export interface OutboundDeps {
  allowlist: Allowlist;
  wa?: WaChannelProvider | null | undefined;
  tg?: TgChannelProvider | null | undefined;
  /** Шаблон для отправки вне окна. */
  utilityTemplate?: string | undefined;
  windowMs?: number | undefined;
  now?: (() => Date) | undefined;
  /** Пометить переписку как ассистентский тред (AT-37). */
  onAssistantThread?: ((externalChatId: string) => void | Promise<void>) | undefined;
}

export class OutboundDispatcher {
  private readonly wa: WaChannelProvider | null;
  private readonly tg: TgChannelProvider | null;
  private readonly utilityTemplate: string;
  private readonly windowMs: number;
  private readonly now: () => Date;
  private readonly onAssistantThread?: OutboundDeps["onAssistantThread"];

  constructor(private readonly deps: OutboundDeps) {
    this.wa = deps.wa ?? null;
    this.tg = deps.tg ?? null;
    this.utilityTemplate = deps.utilityTemplate ?? UTILITY_TEMPLATE;
    this.windowMs = deps.windowMs ?? WA_FREE_FORM_WINDOW_MS;
    this.now = deps.now ?? (() => new Date());
    this.onAssistantThread = deps.onAssistantThread;
  }

  /** Открыто ли 24-ч окно от последнего входящего владельца. */
  isWindowOpen(lastIncomingAt: Date | null, now: Date = this.now()): boolean {
    if (lastIncomingAt === null) return false;
    return now.getTime() - lastIncomingAt.getTime() <= this.windowMs;
  }

  async send(
    to: string,
    text: string,
    meta: { lastIncomingAt?: Date | null | undefined } = {},
  ): Promise<SendOutcome> {
    // AT-34: allowlist раньше любого провайдера.
    this.deps.allowlist.assertCanSend(to);
    const parts = splitMessage(text);
    await this.onAssistantThread?.(to);

    const lastIncoming = meta.lastIncomingAt ?? null;
    if (this.isWindowOpen(lastIncoming)) {
      if (this.wa) {
        const ids: string[] = [];
        for (const part of parts) ids.push((await this.wa.sendFreeForm(to, part)).messageId);
        return { status: "sent", platform: "wa", mode: "freeform", parts: parts.length, messageIds: ids };
      }
      // WA не настроен внутри окна — честная деградация в TG.
      return this.viaTelegram(to, parts, "wa channel not configured inside window");
    }

    if (this.wa && this.wa.isTemplateApproved(this.utilityTemplate)) {
      const ids: string[] = [];
      for (const part of parts) {
        ids.push((await this.wa.sendTemplate(to, this.utilityTemplate, { body: part })).messageId);
      }
      return { status: "sent", platform: "wa", mode: "template", parts: parts.length, messageIds: ids };
    }

    const reason = !this.wa
      ? "wa channel not configured"
      : `template "${this.utilityTemplate}" is not approved`;
    return this.viaTelegram(to, parts, reason);
  }

  /** Деградация в Telegram; если и TG нет — отложено с честным статусом. */
  private async viaTelegram(to: string, parts: string[], reason: string): Promise<SendOutcome> {
    if (!this.tg) {
      return { status: "deferred", reason, parts: parts.length };
    }
    const ids: string[] = [];
    for (const part of parts) ids.push((await this.tg.send(to, part)).messageId);
    return { status: "degraded", platform: "tg", reason, parts: parts.length, messageIds: ids };
  }
}
