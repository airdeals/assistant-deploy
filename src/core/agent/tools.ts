import { z } from "zod";

/**
 * Контракты инструментов агента (G1): zod-схемы входов и выходов.
 * Только валидация — никаких LLM-вызовов и side effects.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const messageHit = z.object({
  accountId: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  sentAt: z.string(),
  author: z.string(),
  text: z.string(),
});

export const tools = {
  search_messages: {
    description: "Поиск сообщений по тексту с фильтрами по чату и датам.",
    input: z.object({
      query: z.string().min(1),
      chatId: z.string().optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.number().int().min(1).max(200).default(20),
    }),
    output: z.object({ messages: z.array(messageHit) }),
  },

  get_conversation: {
    description: "Фрагмент переписки по чату (окно сообщений с курсором).",
    input: z.object({
      chatId: z.string(),
      before: z.string().optional(), // курсор: messageId
      limit: z.number().int().min(1).max(100).default(20),
    }),
    output: z.object({
      chatId: z.string(),
      messages: z.array(messageHit),
      nextCursor: z.string().nullable(),
    }),
  },

  resolve_person: {
    description: "Найти person по идентичности; кандидаты на слияние без автослияния.",
    input: z.object({
      externalId: z.string(),
      idScope: z.string().optional(),
    }),
    output: z.object({
      person: z
        .object({
          id: z.string(),
          displayName: z.string(),
          identityIds: z.array(z.string()),
        })
        .nullable(),
      sameNameCandidates: z.array(z.string()), // id других persons, требуют подтверждения
    }),
  },

  get_source_coverage: {
    description: "Покрытие источников: что доступно по каждому аккаунту.",
    input: z.object({
      accountId: z.string().optional(),
    }),
    output: z.object({
      accounts: z.array(
        z.object({
          accountId: z.string(),
          platform: z.enum(["whatsapp", "telegram"]),
          state: z.enum([
            "not_configured",
            "connecting",
            "importing",
            "live",
            "degraded",
            "disconnected",
            "import_only",
          ]),
          historyFrom: z.string().nullable(),
          historyTo: z.string().nullable(),
          lastSuccessfulSyncAt: z.string().nullable(),
          knownGaps: z.array(z.object({ from: z.string(), to: z.string() })),
        }),
      ),
    }),
  },

  get_balance: {
    description: "Баланс между владельцем и контактом по валютам.",
    input: z.object({
      personId: z.string(),
      includeCandidates: z.boolean().default(false),
    }),
    output: z.object({
      confirmed: z.array(
        z.object({ currency: z.string(), amountMinor: z.string() }),
      ),
      candidates: z.array(
        z.object({ currency: z.string(), amountMinor: z.string() }),
      ),
      unknownOpening: z.boolean(),
    }),
  },

  extract_order_draft: {
    description: "Черновик заказа из переписки (без записи — только черновик).",
    input: z.object({
      chatId: z.string(),
      messageIds: z.array(z.string()).min(1),
    }),
    output: z.object({
      draft: z.object({
        counterpartyPersonId: z.string().nullable(),
        lines: z.array(
          z.object({
            title: z.string(),
            qty: z.number().positive(),
            unitPriceMinor: z.string(),
            currency: z.string(),
          }),
        ),
        note: z.string(),
      }),
    }),
  },

  propose_task: {
    description: "Предложить задачу из переписки на подтверждение владельцу.",
    input: z.object({
      chatId: z.string(),
      title: z.string().min(1),
      dueOn: isoDate.nullable().default(null),
      evidenceMessageIds: z.array(z.string()),
    }),
    output: z.object({ taskId: z.string(), status: z.enum(["pending_owner_confirmation"]) }),
  },

  get_pending_replies: {
    description: "Список ожидающих ответов (кому владелец должен ответить).",
    input: z.object({
      chatId: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    output: z.object({
      pending: z.array(
        z.object({
          chatId: z.string(),
          messageId: z.string(),
          fromPersonId: z.string(),
          text: z.string(),
          waitingSince: z.string(),
        }),
      ),
    }),
  },

  create_owner_reminder: {
    description: "Напоминание владельцу (только владельцу, никому больше).",
    input: z.object({
      key: z.string().min(1), // ключ идемпотентности
      text: z.string().min(1),
      remindAt: z.string(),
    }),
    output: z.object({ reminderId: z.string(), scheduled: z.boolean() }),
  },

  export_user_data: {
    description: "Экспорт всех данных владельца (GDPR-стиль).",
    input: z.object({ format: z.enum(["json"]).default("json") }),
    output: z.object({
      exportId: z.string(),
      format: z.enum(["json"]),
      includes: z.array(z.string()),
    }),
  },
} as const;

export type ToolName = keyof typeof tools;

export const TOOL_NAMES = Object.keys(tools) as ToolName[];

export type ToolInput<T extends ToolName> = z.infer<(typeof tools)[T]["input"]>;
export type ToolOutput<T extends ToolName> = z.infer<(typeof tools)[T]["output"]>;

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: "${name}"`);
    this.name = "UnknownToolError";
  }
}

/** Валидация входа инструмента. Возвращает typed-данные или ошибку zod. */
export function validateToolInput<T extends ToolName>(
  name: T,
  payload: unknown,
): ToolInput<T> {
  const result = tools[name].input.safeParse(payload);
  if (!result.success) {
    throw new Error(`Invalid input for tool "${name}": ${result.error.message}`);
  }
  return result.data as ToolInput<T>;
}

/** Валидация выхода инструмента (контракт агента <-> рантайм). */
export function validateToolOutput<T extends ToolName>(
  name: T,
  payload: unknown,
): ToolOutput<T> {
  const result = tools[name].output.safeParse(payload);
  if (!result.success) {
    throw new Error(`Invalid output for tool "${name}": ${result.error.message}`);
  }
  return result.data as ToolOutput<T>;
}
