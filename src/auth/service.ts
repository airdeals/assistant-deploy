import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/dataSource.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  DEFAULT_TTL_MS,
  generateToken,
  hashToken,
  isSessionActive,
  type SessionRecord,
} from "./session.js";

/**
 * Auth-сервис: учётные записи владельца (owner_users) и сессии.
 * Проверка Bearer-токена — только по SHA-256; истёкшая/отозванная
 * сессия не аутентифицирует. Ротация: старая сессия заменяется
 * на новую ссылкой replaced_by.
 */

export interface OwnerUserRow {
  id: string;
  owner_id: string;
  username: string;
  password_hash: string;
}

export interface IssuedSession {
  token: string;
  session: SessionRecord;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

function rowToSession(r: Record<string, unknown>): SessionRecord {
  return {
    id: r.id as string,
    ownerUserId: r.owner_user_id as string,
    scope: r.scope as string,
    tokenHash: r.token_hash as string,
    createdAt: new Date(r.created_at as string | Date),
    expiresAt: new Date(r.expires_at as string | Date),
    rotatedAt: r.rotated_at ? new Date(r.rotated_at as string | Date) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string | Date) : null,
    replacedBy: (r.replaced_by as string | null) ?? null,
  };
}

/** Создать учётную запись владельца (первичная настройка; username уникален). */
export async function createOwnerUser(
  ds: Queryable,
  ownerId: string,
  username: string,
  password: string,
): Promise<OwnerUserRow> {
  const passwordHash = await hashPassword(password);
  const res = await ds.query<OwnerUserRow>(
    `INSERT INTO owner_users (owner_id, username, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, owner_id, username, password_hash`,
    [ownerId, username, passwordHash],
  );
  const row = res.rows[0];
  if (!row) throw new AuthError("createOwnerUser: insert failed");
  return row;
}

/** Вход: проверка пароля, выпуск сессии. Неверный пароль — null (без различий "нет юзера"/"не тот пароль"). */
export async function login(
  ds: Queryable,
  username: string,
  password: string,
  opts: { scope?: string; ttlMs?: number; now?: Date } = {},
): Promise<IssuedSession | null> {
  const res = await ds.query<OwnerUserRow>(
    `SELECT id, owner_id, username, password_hash FROM owner_users WHERE username = $1`,
    [username],
  );
  const user = res.rows[0];
  if (!user) return null;
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;
  return issueSession(ds, user.id, opts.scope ?? "owner", opts.ttlMs ?? DEFAULT_TTL_MS, opts.now);
}

export async function issueSession(
  ds: Queryable,
  ownerUserId: string,
  scope: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await ds.query(
    `INSERT INTO sessions (id, owner_user_id, scope, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, ownerUserId, scope, tokenHash, now, expiresAt],
  );
  return {
    token,
    session: {
      id,
      ownerUserId,
      scope,
      tokenHash,
      createdAt: now,
      expiresAt,
      rotatedAt: null,
      revokedAt: null,
      replacedBy: null,
    },
  };
}

/** Аутентификация по Bearer-токену. Возвращает активную сессию или null. */
export async function authenticate(
  ds: Queryable,
  token: string,
  now: Date = new Date(),
): Promise<SessionRecord | null> {
  if (!token || token.length < 16) return null;
  const tokenHash = hashToken(token);
  const res = await ds.query(
    `SELECT id, owner_user_id, scope, token_hash, created_at, expires_at,
            rotated_at, revoked_at, replaced_by
     FROM sessions WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const session = rowToSession(row);
  return isSessionActive(session, now) ? session : null;
}

/** Выход: отзыв текущей сессии. */
export async function logout(ds: Queryable, sessionId: string, now: Date = new Date()): Promise<void> {
  await ds.query(`UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [
    now,
    sessionId,
  ]);
}

/**
 * Ротация: выпуск новой сессии со старой scope; старая помечается
 * rotated_at + replaced_by и перестаёт аутентифицировать (revoked_at
 * не требуется — ротация сама по себе завершает сессию).
 */
export async function rotateSession(
  ds: Queryable,
  sessionId: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: Date = new Date(),
): Promise<IssuedSession | null> {
  const res = await ds.query(
    `SELECT id, owner_user_id, scope, token_hash, created_at, expires_at,
            rotated_at, revoked_at, replaced_by
     FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const old = rowToSession(row);
  if (!isSessionActive(old, now)) return null;
  const fresh = await issueSession(ds, old.ownerUserId, old.scope, ttlMs, now);
  await ds.query(
    `UPDATE sessions SET rotated_at = $1, replaced_by = $2 WHERE id = $3`,
    [now, fresh.session.id, sessionId],
  );
  return fresh;
}

export async function getOwnerUser(
  ds: Queryable,
  ownerUserId: string,
): Promise<OwnerUserRow | null> {
  const res = await ds.query<OwnerUserRow>(
    `SELECT id, owner_id, username, password_hash FROM owner_users WHERE id = $1`,
    [ownerUserId],
  );
  return res.rows[0] ?? null;
}
