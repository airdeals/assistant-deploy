/**
 * Провайдеры исходящих каналов (G5). Интерфейсы минимальны, реализации
 * за конфигурацией; в тестах — моки с memory-логом (проверка «никому
 * кроме владельца» — AT-34: до провайдера посторонний не доходит).
 */

export interface WaChannelProvider {
  readonly name: string;
  /** Free-form сообщение внутри 24-ч окна. */
  sendFreeForm(to: string, text: string): Promise<{ messageId: string }>;
  /** Utility-шаблон вне окна. */
  sendTemplate(to: string, template: string, vars: Record<string, string>): Promise<{ messageId: string }>;
  /** Одобрен ли шаблон (без одобрения — только free-form). */
  isTemplateApproved(template: string): boolean;
}

export interface TgChannelProvider {
  readonly name: string;
  send(to: string, text: string): Promise<{ messageId: string }>;
}

export interface WaSentEntry {
  kind: "freeform" | "template";
  to: string;
  text: string;
  template?: string;
}

export interface TgSentEntry {
  to: string;
  text: string;
}

/** Мок WA-провайдера: пишет всё в memory-лог, messageId вида wa-N. */
export class MockWaChannelProvider implements WaChannelProvider {
  readonly name = "wa-mock";
  readonly sent: WaSentEntry[] = [];
  private counter = 0;
  private readonly approved: Set<string>;

  constructor(opts: { approvedTemplates?: string[] } = {}) {
    this.approved = new Set(opts.approvedTemplates ?? []);
  }

  isTemplateApproved(template: string): boolean {
    return this.approved.has(template);
  }

  approveTemplate(template: string): void {
    this.approved.add(template);
  }

  async sendFreeForm(to: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ kind: "freeform", to, text });
    this.counter += 1;
    return { messageId: `wa-${this.counter}` };
  }

  async sendTemplate(to: string, template: string, vars: Record<string, string>): Promise<{ messageId: string }> {
    this.sent.push({ kind: "template", to, text: vars.body ?? "", template });
    this.counter += 1;
    return { messageId: `wa-${this.counter}` };
  }
}

/** Мок TG-провайдера: memory-лог. */
export class MockTgChannelProvider implements TgChannelProvider {
  readonly name = "tg-mock";
  readonly sent: TgSentEntry[] = [];
  private counter = 0;

  async send(to: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ to, text });
    this.counter += 1;
    return { messageId: `tg-${this.counter}` };
  }
}
