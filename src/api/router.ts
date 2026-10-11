import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Минимальный HTTP-роутер поверх node:http — без фреймворков
 * (решение зафиксировано: зависимостей сверх перечисленных в G1 нет).
 * Метод + путь с параметрами ":name", JSON-тело, query string.
 */

export interface RouteParams {
  [key: string]: string;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: RouteParams;
  query: URLSearchParams;
  /** Распарсенное JSON-тело (null, если тела не было или битый JSON). */
  body: unknown;
  /** Заполняется middleware requireOwner. */
  auth: { sessionId: string; ownerUserId: string; scope: string } | null;
  /** Сырое тело запроса (только для webhook-путей, где нужен HMAC). */
  rawBody?: string;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
  }

  get(pattern: string, h: Handler): void { this.add("GET", pattern, h); }
  post(pattern: string, h: Handler): void { this.add("POST", pattern, h); }

  match(method: string, pathname: string): { handler: Handler; params: RouteParams } | null {
    const segs = pathname.split("/").filter(Boolean);
    outer: for (const r of this.routes) {
      if (r.method !== method || r.segments.length !== segs.length) continue;
      const params: RouteParams = {};
      for (let i = 0; i < segs.length; i++) {
        const pat = r.segments[i] as string;
        const seg = segs[i] as string;
        if (pat.startsWith(":")) params[pat.slice(1)] = decodeURIComponent(seg);
        else if (pat !== seg) continue outer;
      }
      return { handler: r.handler, params };
    }
    return null;
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
