/**
 * bot — Telegram-бот личного помощника (первый рабочий контур).
 *
 * Принципы:
 *   - Только официальный Bot API, long polling (входящий порт не нужен —
 *     подходит для виртуального хостинга без root).
 *   - Доступ строго по Telegram user ID владельца (D-15): чужие сообщения
 *     игнорируются с вежливым отказом, попытки фиксируются в логе.
 *   - Никаких ответов третьим лицам, никакой отправки наружу (D-10).
 *   - Команды честно сообщают, если часть системы ещё не подключена.
 *
 * Запуск:  TG_BOT_TOKEN=... TG_OWNER_ID=... DATABASE_URL=... node dist/bot/bot.js
 */
import { Client } from "pg";
const TOKEN = process.env.TG_BOT_TOKEN ?? "";
const OWNER_ID = Number(process.env.TG_OWNER_ID ?? "0");
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT_S = 30;
if (!TOKEN) {
    console.error("[bot] ERROR: TG_BOT_TOKEN не задан (см. .env.example)");
    process.exit(1);
}
if (!OWNER_ID) {
    console.error("[bot] ERROR: TG_OWNER_ID не задан — без него доступ не ограничить");
    process.exit(1);
}
const startedAt = Date.now();
let offset = 0;
async function tgApi(method, params = {}) {
    const res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
    });
    const data = (await res.json());
    if (!data.ok)
        throw new Error(`Telegram API ${method}: ${data.description ?? "unknown error"}`);
    return data.result;
}
async function sendMessage(chatId, text) {
    // Парсинг резервирован для Telegram; без него reply_markup не передаётся.
    await tgApi("sendMessage", { chat_id: chatId, text });
}
async function checkDb() {
    if (!DATABASE_URL)
        return { ok: false, detail: "DATABASE_URL не задан" };
    const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
    try {
        await client.connect();
        const tables = await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
        let messages = "—";
        let chats = "—";
        try {
            const m = await client.query("SELECT count(*)::int AS n FROM messages");
            messages = String(m.rows[0].n);
            const c = await client.query("SELECT count(*)::int AS n FROM chats");
            chats = String(c.rows[0].n);
        }
        catch { /* миграции ещё не применены */ }
        await client.end();
        return { ok: true, detail: `БД на связи, таблиц: ${tables.rows[0].n}, чатов: ${chats}, сообщений: ${messages}` };
    }
    catch (e) {
        try {
            await client.end();
        }
        catch { /* ignore */ }
        return { ok: false, detail: `БД недоступна: ${e.message}` };
    }
}
/** Простой текстовый поиск по загруженной переписке (все слова, регистр не важен). */
async function searchMessages(query) {
    const words = query.toLowerCase().split(/\s+/).map(w => w.replace(/[%_\\]/g, "")).filter(w => w.length >= 2).slice(0, 6);
    if (words.length === 0)
        return { error: "Введите слово для поиска, например: доставка" };
    if (!DATABASE_URL)
        return { error: "База данных пока не подключена." };
    const cond = words.map((_, i) => `lower(m.text) LIKE $${i + 1}`).join(" AND ");
    const params = words.map(w => `%${w}%`);
    const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
    try {
        await client.connect();
        const r = await client.query(`SELECT c.title AS title, m.sent_at AS sent_at, m.direction AS direction, m.text AS text
       FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.deleted_at IS NULL AND NOT m.is_system AND length(m.text) > 0 AND ${cond}
       ORDER BY m.sent_at DESC LIMIT 10`, params);
        const cnt = await client.query(`SELECT count(*)::int AS n FROM messages m
       WHERE m.deleted_at IS NULL AND NOT m.is_system AND length(m.text) > 0 AND ${cond}`, params);
        await client.end();
        return { items: r.rows, total: cnt.rows[0].n };
    }
    catch (e) {
        try {
            await client.end();
        }
        catch { /* ignore */ }
        return { error: `Ошибка поиска: ${e.message}` };
    }
}
async function handleSearch(query, chatId) {
    const res = await searchMessages(query);
    if ("error" in res) {
        await sendMessage(chatId, res.error);
        return;
    }
    if (res.items.length === 0) {
        await sendMessage(chatId, "По этому запросу ничего не нашлось. Возможные причины: пока загружен только первый Telegram-аккаунт, либо сообщения с этими словами были позже удалены.");
        return;
    }
    const lines = res.items.map((it) => {
        const d = new Date(it.sent_at);
        const ds = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
        const snippet = it.text.replace(/\s+/g, " ").slice(0, 160);
        const tag = it.direction === "out" ? " · ваше" : "";
        return `• ${ds} · ${it.title ?? "чат"}${tag}: ${snippet}`;
    });
    const header = res.total > res.items.length
        ? `Нашёл ${res.total} сообщений, показываю ${res.items.length} последних:`
        : `Нашёл ${res.total} сообщений:`;
    await sendMessage(chatId, (header + "\n\n" + lines.join("\n\n")).slice(0, 3500));
}
async function handleCommand(command, chatId) {
    switch (command) {
        case "/start":
            await sendMessage(chatId, "Здравствуйте! Я — ваш личный помощник.\n\n" +
                "Пока я умею немного, но фундамент работает:\n" +
                "/status — состояние системы\n" +
                "/help — что я умею\n\n" +
                "Подключение переписки и AI-функции включаются по мере готовности.");
            break;
        case "/help":
            await sendMessage(chatId, "Команды:\n" +
                "/start — приветствие\n" +
                "/status — состояние системы и базы данных\n" +
                "/help — эта справка\n\n" +
                "Доступ к боту ограничен вашим Telegram ID.");
            break;
        case "/status": {
            const uptimeMin = Math.floor((Date.now() - startedAt) / 60000);
            const db = await checkDb();
            await sendMessage(chatId, `Статус помощника:\n` +
                `• бот работает: ${uptimeMin} мин\n` +
                `• ${db.ok ? "✅" : "⚠️"} ${db.detail}\n` +
                `• источники: Telegram-аккаунт 1 загружен; второй — в очереди\n` +
                `• поиск по переписке: включён (просто напишите слова)`);
            break;
        }
        default:
            await sendMessage(chatId, "Пока я знаю только команды из /help.");
    }
}
async function pollOnce() {
    const updates = (await tgApi("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ["message"],
    }));
    for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || !msg.text)
            continue;
        const fromId = msg.from?.id ?? 0;
        if (fromId !== OWNER_ID) {
            console.log(`[bot] отказано: сообщение от чужого id=${fromId}`);
            try {
                await sendMessage(msg.chat.id, "Этот бот — личный помощник его владельца. Доступ ограничен.");
            }
            catch { /* ignore */ }
            continue;
        }
        const text = msg.text.trim();
        console.log(`[bot] сообщение от владельца: ${text.slice(0, 40)}`);
        try {
            if (text.startsWith("/")) {
                await handleCommand(text.split(/\s/)[0], msg.chat.id);
            }
            else {
                await handleSearch(text, msg.chat.id);
            }
        }
        catch (e) {
            console.error(`[bot] ошибка обработки: ${e.message}`);
            try {
                await sendMessage(msg.chat.id, "Произошла ошибка, попробуйте ещё раз.");
            }
            catch { /* ignore */ }
        }
    }
}
async function main() {
    const me = (await tgApi("getMe"));
    console.log(`[bot] запущен: @${me.username}, доступ только id=${OWNER_ID}`);
    console.log(`[bot] ${await checkDb().then(d => d.detail)}`);
    while (true) {
        try {
            await pollOnce();
        }
        catch (e) {
            console.error(`[bot] ошибка polling: ${e.message}; пауза 5 сек`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}
const shutdown = async () => {
    console.log("\n[bot] остановка...");
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((e) => {
    console.error(`[bot] фатальная ошибка: ${e.message}`);
    process.exit(1);
});
