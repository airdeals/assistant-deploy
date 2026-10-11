import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Хеширование пароля владельца через node:crypto scrypt.
 * Константы RFC 7914: N=16384, r=8, p=1, длина ключа 64 байта.
 * Формат хранения: "<salt_hex>:<hash_hex>". Соль — per-user, 16 байт.
 * Сравнение — только timingSafeEqual (константное время). Без зависимостей.
 */

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const KEY_LENGTH = 64;
export const SALT_LENGTH = 16;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error("hashPassword: empty password");
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts as [string, string];
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  const derived = await scryptAsync(password, salt);
  // Константное сравнение; при разной длине — не равны без утечки префикса.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
