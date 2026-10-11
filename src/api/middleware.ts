import type { DataSource } from "../db/dataSource.js";
import { authenticate } from "../auth/service.js";
import { sendJson, type Ctx, type Handler } from "./router.js";

/**
 * requireOwner: Bearer token → сессия → owner scope.
 * AT-21: без сессии — 401, сессия с чужим scope — 403. В ответах —
 * никаких данных и метаданных (единый текст ошибки, без подсказок,
 * существует ли такая сессия).
 */
export function requireOwner(ds: DataSource, handler: Handler, requiredScope = "owner"): Handler {
  return async (ctx: Ctx) => {
    const header = ctx.req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/.exec(header);
    const token = m ? (m[1] as string).trim() : "";
    if (!token) {
      sendJson(ctx.res, 401, { error: "unauthorized" });
      return;
    }
    const session = await authenticate(ds, token);
    if (!session) {
      sendJson(ctx.res, 401, { error: "unauthorized" });
      return;
    }
    if (session.scope !== requiredScope) {
      // Сессия валидная, но scope не тот — запрещено.
      sendJson(ctx.res, 403, { error: "forbidden" });
      return;
    }
    ctx.auth = {
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      scope: session.scope,
    };
    await handler(ctx);
  };
}
