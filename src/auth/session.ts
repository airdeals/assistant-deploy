import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque session token: 32 байта энтропии (crypto.randomBytes),
 * base64url. В БД хранится только SHA-256 от токена — утечка БД
 * не раскрывает действующие сессии. Никаких данных токену не несёт.
 */

export const TOKEN_BYTES = 32;
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней

export interface SessionRecord {
  id: string;
  ownerUserId: string;
  scope: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isSessionActive(session: SessionRecord, now: Date = new Date()): boolean {
  return (
    session.revokedAt === null &&
    session.rotatedAt === null &&
    session.expiresAt.getTime() > now.getTime()
  );
}
