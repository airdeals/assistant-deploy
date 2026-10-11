/**
 * Серверная проверка получателя исходящих сообщений (AT-21/AT-34).
 * Исходящие разрешены ТОЛЬКО владельцу — и только по подтверждённому
 * внешнему идентификатору (identity id), никогда по отображаемому имени.
 */

export class RecipientNotAllowedError extends Error {
  readonly recipient: string;

  constructor(recipient: string) {
    super(`Outgoing messages are allowed only to the owner; recipient "${recipient}" is not the confirmed owner identity`);
    this.name = "RecipientNotAllowedError";
    this.recipient = recipient;
  }
}

export class Allowlist {
  /** Подтверждённые внешние идентификаторы владельца (телефон/user id). */
  private readonly ownerIds: Set<string>;

  constructor(ownerExternalIds: Iterable<string>) {
    this.ownerIds = new Set([...ownerExternalIds].map((s) => s.trim()));
    if (this.ownerIds.size === 0) {
      throw new Error("Allowlist: at least one confirmed owner identity is required");
    }
  }

  /** true, если получатель — подтверждённый владелец. */
  canSend(recipientExternalId: string): boolean {
    return this.ownerIds.has(recipientExternalId.trim());
  }

  /** Проверка перед отправкой: бросает RecipientNotAllowedError для посторонних. */
  assertCanSend(recipientExternalId: string): void {
    if (!this.canSend(recipientExternalId)) {
      throw new RecipientNotAllowedError(recipientExternalId);
    }
  }
}
