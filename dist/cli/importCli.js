// src/cli/importCli.ts
import { readFile } from "node:fs/promises";

// src/db/dataSource.ts
import pg from "pg";
var PostgresDataSource = class {
  pool;
  constructor(connectionString) {
    this.pool = new pg.Pool({ connectionString });
  }
  query(text, params) {
    return this.pool.query(text, params);
  }
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = {
        query: (text, params) => client.query(text, params)
      };
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => void 0);
      throw e;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
};
function createDataSource(databaseUrl) {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (see .env.example)");
  }
  return new PostgresDataSource(url);
}

// src/importer.ts
import { randomUUID } from "node:crypto";

// src/db/repos/ingestRepo.ts
async function upsertChat(q, accountId, externalChatId, opts = {}) {
  const res = await q.query(
    `INSERT INTO chats (account_id, external_chat_id, type, title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, external_chat_id)
     DO UPDATE SET title = COALESCE(excluded.title, chats.title)
     RETURNING id, (xmax = 0) AS created`,
    [accountId, externalChatId, opts.type ?? "direct", opts.title ?? null]
  );
  const row = res.rows[0];
  if (!row) throw new Error("upsertChat: no row returned");
  return row;
}
async function insertMessage(q, chatId, e) {
  const res = await q.query(
    `INSERT INTO messages
       (account_id, chat_id, message_id, author, direction, sent_at, source_tz,
        text, edited_at, deleted_at, is_system)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (account_id, chat_id, message_id) DO NOTHING
     RETURNING id`,
    [
      e.accountId,
      chatId,
      e.externalMessageId,
      e.author,
      e.direction,
      e.sentAt,
      e.sourceTz ?? null,
      e.text,
      e.editedAt ?? null,
      e.deletedAt ?? null,
      e.isSystem ?? false
    ]
  );
  if (res.rows[0]) return "inserted";
  const existing = await q.query(
    `SELECT id, text, deleted_at FROM messages
     WHERE account_id = $1 AND chat_id = $2 AND message_id = $3`,
    [e.accountId, chatId, e.externalMessageId]
  );
  const row = existing.rows[0];
  if (!row) throw new Error("insertMessage: conflict without existing row");
  const wantsDeleted = (e.deletedAt ?? null) !== null;
  const textChanged = e.text !== row.text;
  if (!textChanged && (!wantsDeleted || row.deleted_at !== null)) {
    return "duplicate";
  }
  const now = e.editedAt ?? e.deletedAt ?? /* @__PURE__ */ new Date();
  const seqRes = await q.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM message_revisions WHERE message_id = $1`,
    [row.id]
  );
  const nextSeq = seqRes.rows[0]?.next_seq ?? 1;
  await q.query(
    `INSERT INTO message_revisions (message_id, seq, kind, prev_text, new_text, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.id, nextSeq, wantsDeleted ? "delete" : "edit", row.text, wantsDeleted ? "" : e.text, now]
  );
  await q.query(
    `UPDATE messages
     SET text = $2, edited_at = $3, deleted_at = $4, invalidated = true
     WHERE id = $1`,
    [
      row.id,
      wantsDeleted ? row.text : e.text,
      e.editedAt ?? (textChanged ? now : null),
      wantsDeleted ? e.deletedAt ?? now : null
    ]
  );
  return "updated";
}
async function insertMessageBatch(ds, chatId, events) {
  return ds.transaction(async (tx) => {
    const result = { inserted: 0, updated: 0, duplicates: 0, total: events.length };
    for (const e of events) {
      const status = await insertMessage(tx, chatId, e);
      result[status === "inserted" ? "inserted" : status === "updated" ? "updated" : "duplicates"] += 1;
    }
    return result;
  });
}

// src/adapters/parseTgExport.ts
function flattenText(raw) {
  const entities = raw.text_entities ?? (Array.isArray(raw.text) ? raw.text : []);
  if (entities.length > 0) return entities.map((e) => e.text ?? "").join("");
  return typeof raw.text === "string" ? raw.text : "";
}
function parseTgExport(json, opts = {}) {
  let root;
  try {
    root = JSON.parse(json);
  } catch (e) {
    throw new Error(`parseTgExport: invalid JSON: ${e.message}`);
  }
  if (root === null || typeof root !== "object" || !Array.isArray(root.messages)) {
    throw new Error("parseTgExport: expected Telegram Desktop export object with messages[]");
  }
  const messages = [];
  for (const raw of root.messages) {
    const type = raw.type === "service" ? "service" : "message";
    if (type === "service" && opts.includeService !== true) continue;
    const senderId = raw.from_id ?? raw.actor_id ?? null;
    const senderName = raw.from ?? raw.actor ?? null;
    const unix = raw.date_unixtime ? Number(raw.date_unixtime) : NaN;
    let sentAt;
    if (Number.isFinite(unix)) {
      sentAt = new Date(unix * 1e3);
    } else if (raw.date) {
      sentAt = new Date(raw.date);
    } else {
      continue;
    }
    if (Number.isNaN(sentAt.getTime())) continue;
    const isVoiceOgg = typeof raw.file === "string" && raw.file.toLowerCase().endsWith(".ogg");
    messages.push({
      id: raw.id ?? -1,
      type,
      senderId,
      senderName,
      direction: opts.ownSenderId && senderId === opts.ownSenderId ? "out" : "in",
      sentAt,
      text: flattenText(raw),
      replyToMessageId: raw.reply_to_message_id ?? null,
      forwardFrom: raw.forwarded_from ?? raw.forward_from ?? null,
      mediaOgg: isVoiceOgg ? raw.file ?? null : null
    });
  }
  return {
    chatName: root.name ?? null,
    chatType: root.type ?? null,
    chatId: root.id ?? null,
    messages
  };
}

// src/adapters/parseWaExport.ts
var MESSAGE_RE = /^\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+(AM|PM))?\]\s*(.*)$/;
var SYSTEM_PHRASES = [
  "messages and calls are end-to-end encrypted",
  "messages are end-to-end encrypted",
  "changed the subject",
  "changed this group's icon",
  "changed the group name",
  "created group",
  "you created group",
  "added you",
  "you were added",
  "added ",
  "removed ",
  "left",
  "joined using this group's invite link",
  "joined using an invite link",
  "security code changed",
  "disappearing messages",
  "changed their phone number",
  "is a business account",
  "turned on read receipts",
  "this message was deleted",
  "pinned a message",
  "via a link in the chat",
  "\u0441\u043E\u0437\u0434\u0430\u043B \u0433\u0440\u0443\u043F\u043F\u0443",
  "\u0441\u043E\u0437\u0434\u0430\u043B\u0430 \u0433\u0440\u0443\u043F\u043F\u0443",
  "\u0438\u0437\u043C\u0435\u043D\u0438\u043B \u0442\u0435\u043C\u0443",
  "\u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430 \u0442\u0435\u043C\u0443",
  "\u0438\u0437\u043C\u0435\u043D\u0438\u043B(\u0430) \u0442\u0435\u043C\u0443",
  "\u0438\u0437\u043C\u0435\u043D\u0438\u043B \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435",
  "\u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435",
  "\u043F\u043E\u043A\u0438\u043D\u0443\u043B \u0433\u0440\u0443\u043F\u043F\u0443",
  "\u043F\u043E\u043A\u0438\u043D\u0443\u043B\u0430 \u0433\u0440\u0443\u043F\u043F\u0443",
  "\u043F\u0440\u0438\u0441\u043E\u0435\u0434\u0438\u043D\u0438\u043B\u0441\u044F",
  "\u043F\u0440\u0438\u0441\u043E\u0435\u0434\u0438\u043D\u0438\u043B\u0430\u0441\u044C",
  "\u043F\u0440\u0438\u0441\u043E\u0435\u0434\u0438\u043D\u0438\u043B\u0441\u044F(\u0430\u0441\u044C) \u043F\u043E \u0441\u0441\u044B\u043B\u043A\u0435",
  "\u043A\u043E\u0434 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0441\u044F",
  "\u0438\u0441\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F",
  "\u0438\u0437\u043C\u0435\u043D\u0438\u043B(\u0430) \u043D\u043E\u043C\u0435\u0440 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0430",
  "\u044D\u0442\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0431\u044B\u043B\u043E \u0443\u0434\u0430\u043B\u0435\u043D\u043E",
  "\u0437\u0430\u043A\u0440\u0435\u043F\u0438\u043B(\u0430) \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435"
];
function isSystemRecord(author, text) {
  const full = `${author}: ${text}`.toLowerCase();
  return SYSTEM_PHRASES.some((p) => full.startsWith(p) || full.includes(p));
}
function normalizeNumber(raw) {
  return raw.replace(/[^\d]/g, "");
}
function resolveDirection(author, opts) {
  const trimmed = author.trim();
  if (/^(you|вы)$/i.test(trimmed)) return "out";
  if (opts.ownName && trimmed.toLowerCase() === opts.ownName.trim().toLowerCase()) return "out";
  if (opts.ownNumber) {
    const a = normalizeNumber(trimmed);
    const b = normalizeNumber(opts.ownNumber);
    if (a.length > 0 && b.length > 0 && (a === b || a.endsWith(b) || b.endsWith(a))) return "out";
  }
  return "in";
}
function resolveDateLocale(a, b, opts) {
  if (opts.dateLocale && opts.dateLocale !== "auto") return opts.dateLocale;
  if (a > 12) return "dmy";
  if (b > 12) return "mdy";
  return "dmy";
}
function parseDate(m, opts) {
  const a = Number(m[1]);
  const b = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += year < 70 ? 2e3 : 1900;
  const locale = resolveDateLocale(a, b, opts);
  const day = locale === "dmy" ? a : b;
  const month = locale === "dmy" ? b : a;
  const hour24 = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ampm = m[7]?.toUpperCase();
  let hour = hour24;
  if (ampm === "AM") {
    if (hour === 12) hour = 0;
  } else if (ampm === "PM") {
    if (hour !== 12) hour += 12;
  } else if (hour24 > 23) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(d.getTime()) ? null : d;
}
function parseWaExport(input, opts = {}) {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const chatTitleLines = [];
  const messages = [];
  let current = null;
  const flush = (includeSystem) => {
    if (current && (includeSystem || !current.isSystem)) {
      messages.push(current);
    }
    current = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/‎/g, "").trimEnd();
    if (line.trim().length === 0) continue;
    const m = line.match(MESSAGE_RE);
    if (m) {
      flush(opts.includeSystem === true);
      const sentAt = parseDate(m, opts);
      const rest = m[8] ?? "";
      const colonIdx = rest.indexOf(": ");
      const author = colonIdx === -1 ? rest.trim() : rest.slice(0, colonIdx).trim();
      const text = colonIdx === -1 ? "" : rest.slice(colonIdx + 2);
      const isSystem = isSystemRecord(author, text);
      if (!sentAt) continue;
      current = {
        author,
        direction: resolveDirection(author, opts),
        sentAt,
        text,
        isSystem
      };
    } else {
      if (current) {
        current.text = current.text.length === 0 ? line : `${current.text}
${line}`;
        if (isSystemRecord(current.author, current.text)) current.isSystem = true;
      } else if (line.trimStart().startsWith("[") && isSystemRecord("", line)) {
        current = {
          author: "",
          direction: "in",
          sentAt: messages.length > 0 ? messages[messages.length - 1].sentAt ?? /* @__PURE__ */ new Date(0) : /* @__PURE__ */ new Date(0),
          text: line.trim(),
          isSystem: true
        };
      } else {
        chatTitleLines.push(line);
      }
    }
  }
  flush(opts.includeSystem === true);
  const chatTitle = chatTitleLines.length > 0 ? chatTitleLines.join("\n").trim() : null;
  return { chatTitle, messages };
}

// src/importer.ts
function stableChatId(seed) {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822507) >>> 0;
  }
  return `chat-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
function waToEvent(accountId, chatId, m) {
  const author = m.author.trim().length > 0 ? m.author.trim() : "system";
  return {
    accountId,
    externalChatId: chatId,
    externalMessageId: `${chatId}:${m.sentAt.getTime()}:${author}`,
    author,
    direction: m.direction,
    sentAt: m.sentAt,
    text: m.text,
    isSystem: m.isSystem
  };
}
function tgToEvent(accountId, chatId, m) {
  const author = m.senderId ?? m.senderName ?? "unknown";
  return {
    accountId,
    externalChatId: chatId,
    externalMessageId: `tg-${m.id}`,
    author,
    direction: m.senderId ? m.direction : "in",
    sentAt: m.sentAt,
    text: m.text,
    isSystem: m.type === "service"
  };
}
async function importFiles(ds, opts) {
  const batchId = randomUUID();
  const report = {
    batchId,
    status: "failed",
    total: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    errors: [],
    chats: []
  };
  await ds.query(
    `INSERT INTO import_batches (id, account_id, status, stats) VALUES ($1, $2, 'running', '{}'::jsonb)`,
    [batchId, opts.accountId]
  );
  try {
    for (const file of opts.files) {
      try {
        let title = file.title ?? null;
        if (opts.format === "wa") {
          title = parseWaExport(file.content, file.waOptions).chatTitle ?? title;
        } else {
          const parsedTg = parseTgExport(file.content, file.tgOptions);
          title = parsedTg.chatName ?? title;
        }
        const chatExternalId = file.chatExternalId ?? stableChatId(title ?? file.content.slice(0, 64));
        const chat = await upsertChat(ds, opts.accountId, chatExternalId, {
          title,
          type: "direct"
        });
        report.chats.push({ externalChatId: chatExternalId, internalChatId: chat.id });
        const events = [];
        if (opts.format === "wa") {
          const parsed = parseWaExport(file.content, file.waOptions);
          for (const m of parsed.messages) events.push(waToEvent(opts.accountId, chatExternalId, m));
        } else {
          const parsed = parseTgExport(file.content, file.tgOptions);
          for (const m of parsed.messages) events.push(tgToEvent(opts.accountId, chatExternalId, m));
        }
        let done = 0;
        const progress = opts.onProgress;
        const CHUNK = 500;
        for (let i = 0; i < events.length; i += CHUNK) {
          const chunk = events.slice(i, i + CHUNK);
          const r = await insertMessageBatch(ds, chat.id, chunk);
          report.total += r.total;
          report.inserted += r.inserted;
          report.updated += r.updated;
          report.duplicates += r.duplicates;
          done += chunk.length;
          progress?.({ done, total: events.length, chatExternalId });
        }
      } catch (e) {
        report.errors.push(`${file.chatExternalId ?? "file"}: ${e.message}`);
      }
    }
    report.status = report.errors.length > 0 && report.total === 0 ? "failed" : "done";
    await ds.query(
      `UPDATE import_batches SET status = $1, stats = $2, finished_at = now() WHERE id = $3`,
      [report.status, JSON.stringify({ total: report.total, inserted: report.inserted, updated: report.updated, duplicates: report.duplicates }), batchId]
    );
    return report;
  } catch (e) {
    await ds.query(
      `UPDATE import_batches SET status = 'failed', stats = $1, finished_at = now() WHERE id = $2`,
      [JSON.stringify({ error: e.message }), batchId]
    );
    throw e;
  }
}

// src/cli/importCli.ts
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = a.slice(m[1].length + 3);
  }
  return out;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const format = args.format;
  const account = args.account;
  const file = args.file;
  if (format !== "wa" && format !== "tg" || !account || !file) {
    console.error("usage: --format=wa|tg --account=<accountId> --file=<path> [--chat=..] [--own-name=..] [--own-number=..] [--own-sender=..]");
    process.exitCode = 1;
    return;
  }
  const content = await readFile(file, "utf8");
  const ds = createDataSource();
  try {
    const report = await importFiles(ds, {
      accountId: account,
      format,
      files: [
        {
          content,
          ...args.chat ? { chatExternalId: args.chat } : {},
          ...format === "wa" ? { waOptions: { ownName: args["own-name"], ownNumber: args["own-number"] } } : {},
          ...format === "tg" ? { tgOptions: { ownSenderId: args["own-sender"] } } : {}
        }
      ],
      onProgress: (p) => console.error(`progress: ${p.chatExternalId} ${p.done}/${p.total}`)
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await ds.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
