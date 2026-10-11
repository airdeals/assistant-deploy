import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MediaDownloadResult } from "../contracts/adapter.js";
import type { RawMessageEvent } from "../contracts/events.js";

/**
 * TDLib через JSON-интерфейс, G4.
 * - конфиг: apiId/apiHash из env/конфига (никогда в коде), databaseDir
 *   per account: ДВА аккаунта = два инстанса TdlibClient с отдельными
 *   процессами и отдельными счётчиками @extra — connection_id не смешиваются;
 * - авторизация: state machine WaitPhoneNumber→WaitCode→WaitPassword→Ready,
 *   код/пароль запрашиваются ТОЛЬКО через инжектируемые callback'и
 *   (владелец вводит в UI) — НИКОГДА не из чатов/репозиториев;
 * - процесс tdlib скрыт за интерфейсом TdlibProcess: реальный — spawn
 *   бинаря (stdio ndjson), тестовый — scripted (очередь ответов).
 */

/** Запрос/ответ JSON-интерфейса TDLib: @type/@extra. */
export type TdlibObject = Record<string, unknown>;

export interface TdlibProcess {
  send(req: TdlibObject): void;
  /** Один ответ TDLib (update или результат запроса). */
  nextResponse(): Promise<TdlibObject>;
  close(): Promise<void>;
}

export interface TdlibClientConfig {
  apiId: number;
  apiHash: string;
  databaseDir: string;
  phoneNumber: string;
  /** Код из SMS/Telegram — спрашиваем владельца через UI. */
  authCodeProvider: () => Promise<string>;
  /** Облачный пароль 2FA — аналогично. */
  authPasswordProvider?: (() => Promise<string>) | undefined;
  /** По умолчанию создаётся SpawnTdlibProcess (не используется в тестах). */
  process?: TdlibProcess | undefined;
  /** Путь к tdlib-json бинарю; по умолчанию из env TD_JSON_CLI. */
  binaryPath?: string | undefined;
}

export class TdlibAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TdlibAuthError";
  }
}

/** Реальный процесс: spawn бинаря, ndjson поверх stdio. Не спавним в тестах. */
export class SpawnTdlibProcess implements TdlibProcess {
  private readonly child: ChildProcess;
  private readonly buffer: string[] = [];
  private waiters: Array<(line: TdlibObject) => void> = [];

  constructor(binaryPath: string) {
    this.child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "inherit"] });
    let acc = "";
    this.child.stdout!.on("data", (chunk: Buffer) => {
      acc += chunk.toString("utf8");
      let idx: number;
      while ((idx = acc.indexOf("\n")) >= 0) {
        const line = acc.slice(0, idx);
        acc = acc.slice(idx + 1);
        if (line.trim().length === 0) continue;
        let parsed: TdlibObject;
        try {
          parsed = JSON.parse(line) as TdlibObject;
        } catch {
          continue;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter(parsed);
        else this.buffer.push(line);
      }
    });
  }

  send(req: TdlibObject): void {
    this.child.stdin!.write(`${JSON.stringify(req)}\n`);
  }

  nextResponse(): Promise<TdlibObject> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve(JSON.parse(buffered) as TdlibObject);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async close(): Promise<void> {
    this.child.kill();
  }
}

export interface TdlibMessage {
  id: number;
  chatId: number;
  senderExternalId: string;
  text: string;
  date: number;
  editDate?: number | undefined;
  mediaFileId?: number | undefined;
}

/** message TDLib → наше сырое событие. */
export function normalizeTdlibMessage(m: TdlibMessage, deletedAt?: Date): RawMessageEvent {
  const event: RawMessageEvent = {
    externalChatId: String(m.chatId),
    externalMessageId: String(m.id),
    authorExternalId: m.senderExternalId,
    direction: m.senderExternalId === "me" ? "out" : "in",
    sentAt: new Date(m.date * 1000),
    text: m.text,
  };
  if (m.editDate !== undefined) event.editedAt = new Date(m.editDate * 1000);
  if (deletedAt !== undefined) event.deletedAt = deletedAt;
  if (m.mediaFileId !== undefined) {
    event.mediaRefs = [{ externalId: `tgfile:${m.mediaFileId}` }];
  }
  return event;
}

export class TdlibClient {
  private readonly proc: TdlibProcess;
  private extraCounter = 0;
  private readonly connectionId = randomUUID();

  constructor(private readonly cfg: TdlibClientConfig) {
    this.proc =
      cfg.process ??
      new SpawnTdlibProcess(cfg.binaryPath ?? process.env.TD_JSON_CLI ?? "tdlib-json");
  }

  /** Уникальный идентификатор инстанса (диагностика изоляции аккаунтов). */
  getConnectionId(): string {
    return this.connectionId;
  }

  /** Запрос с сопоставлением ответа по @extra. */
  private async request<T extends TdlibObject>(fn: string, params: TdlibObject = {}): Promise<T> {
    this.extraCounter += 1;
    const extra = `${this.connectionId}:${this.extraCounter}`;
    this.proc.send({ "@type": fn, ...params, "@extra": extra });
    for (;;) {
      const resp = await this.proc.nextResponse();
      if (resp["@extra"] === extra) return resp as T;
      // Чужой @extra — чужой инстанс или update; updates обрабатывает caller.
      this.unmatched.push(resp);
    }
  }

  /** Ответы, пришедшие не под наш @extra (прокидываются в collectUpdate). */
  private unmatched: TdlibObject[] = [];

  drainUnmatched(): TdlibObject[] {
    const out = this.unmatched;
    this.unmatched = [];
    return out;
  }

  /** Машина состояний авторизации: до Ready или ошибки. */
  async start(): Promise<void> {
    for (let guard = 0; guard < 50; guard++) {
      const state = await this.request<TdlibObject>("getAuthorizationState");
      const t = String(state["@type"] ?? "");
      if (t === "authorizationStateReady") return;
      if (t === "authorizationStateWaitPhoneNumber") {
        await this.request("setAuthenticationPhoneNumber", { phone_number: this.cfg.phoneNumber });
      } else if (t === "authorizationStateWaitCode") {
        const code = await this.cfg.authCodeProvider();
        await this.request("checkAuthenticationCode", { code });
      } else if (t === "authorizationStateWaitPassword") {
        const provider = this.cfg.authPasswordProvider;
        if (!provider) throw new TdlibAuthError("2FA password required but no provider configured");
        const password = await provider();
        await this.request("checkAuthenticationPassword", { password });
      } else if (t === "authorizationStateWaitTdlibParameters") {
        await this.request("setTdlibParameters", {
          parameters: {
            database_directory: this.cfg.databaseDir,
            api_id: this.cfg.apiId,
            api_hash: this.cfg.apiHash,
            system_language_code: "en",
            device_model: "kimi-assistant",
            application_version: "0.1.0",
          },
        });
      } else if (t === "authorizationStateClosed" || t === "authorizationStateLogOut") {
        throw new TdlibAuthError(`authorization state: ${t}`);
      } else {
        // Прочие промежуточные состояния — спрашиваем снова.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    throw new TdlibAuthError("authorization state machine did not reach Ready");
  }

  /**
   * История чата: pagination по offset_id (0 — с конца, дальше —
   * last_message_id предыдущей страницы).
   */
  async getHistoryPage(opts: { chatId: number; offsetId?: number | undefined; limit?: number | undefined }): Promise<TdlibObject[]> {
    const resp = await this.request<TdlibObject>("getChatHistory", {
      chat_id: opts.chatId,
      from_message_id: opts.offsetId ?? 0,
      offset: 0,
      limit: opts.limit ?? 100,
      only_local: false,
    });
    const messages = resp.messages;
    return Array.isArray(messages) ? (messages as TdlibObject[]) : [];
  }

  /**
   * Разбор update'ов: updateNewMessage / updateEditMessage /
   * updateDeleteMessages → RawMessageEvent.
   */
  collectUpdate(update: TdlibObject, now: Date = new Date()): RawMessageEvent[] {
    const t = String(update["@type"] ?? "");
    if (t === "updateNewMessage" || t === "updateEditMessage") {
      const msg = (update.message ?? null) as TdlibObject | null;
      if (!msg) return [];
      const sender = (msg.sender_id ?? {}) as TdlibObject;
      const raw = normalizeTdlibMessage(
        {
          id: Number(msg.id ?? 0),
          chatId: Number(msg.chat_id ?? 0),
          senderExternalId: sender.user_id !== undefined ? String(sender.user_id) : "me",
          text: extractTdlibText(msg),
          date: Number(msg.date ?? 0),
          ...(t === "updateEditMessage" ? { editDate: Math.floor(now.getTime() / 1000) } : {}),
        },
      );
      return [raw];
    }
    if (t === "updateDeleteMessages") {
      const chatId = Number(update.chat_id ?? 0);
      const ids = Array.isArray(update.message_ids) ? (update.message_ids as number[]) : [];
      return ids.map((id) =>
        normalizeTdlibMessage(
          {
            id,
            chatId,
            senderExternalId: "unknown",
            text: "",
            date: Math.floor(now.getTime() / 1000),
          },
          now,
        ),
      );
    }
    return [];
  }

  /** downloadFile → media ref (байты из local path — забота вызывающего). */
  async downloadFile(fileId: number): Promise<MediaDownloadResult> {
    const resp = await this.request<TdlibObject>("downloadFile", {
      file_id: fileId,
      priority: 1,
      offset: 0,
      limit: 0,
      synchronous: true,
    });
    const file = (resp.file ?? resp) as TdlibObject;
    const local = (file.local ?? {}) as TdlibObject;
    const path = String(local.path ?? "");
    if (!path) throw new Error(`downloadFile: no local path for file ${fileId}`);
    const { readFile } = await import("node:fs/promises");
    const bytes = new Uint8Array(await readFile(path));
    return { ref: `tgfile:${fileId}`, mime: "application/octet-stream", bytes };
  }

  async close(): Promise<void> {
    await this.proc.close();
  }
}

/** Текст message-объекта TDLib: messageText.text.plain_text либо caption. */
function extractTdlibText(msg: TdlibObject): string {
  const content = (msg.content ?? {}) as TdlibObject;
  if (content["@type"] === "messageText") {
    const textObj = (content.text ?? {}) as TdlibObject;
    return String(textObj.plain_text ?? "");
  }
  const caption = (content.caption ?? {}) as TdlibObject;
  return String(caption.plain_text ?? "");
}
