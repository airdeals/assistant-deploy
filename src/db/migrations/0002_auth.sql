-- 0002_auth: аутентификация владельца.
-- Пароль хранится как scrypt-хеш (RFC 7914: N=16384, r=8, p=1) с per-user солью.
-- Сессия — только SHA-256 от opaque-токена; сам токен в БД не попадает.

CREATE TABLE owner_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES owners(id),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,        -- scrypt: <salt_hex>:<hash_hex>
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL REFERENCES owner_users(id),
  scope          text NOT NULL DEFAULT 'owner',
  token_hash     text NOT NULL UNIQUE,  -- sha256 hex от Bearer-токена
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  rotated_at     timestamptz,
  revoked_at     timestamptz,
  replaced_by    uuid REFERENCES sessions(id)
);
CREATE INDEX sessions_owner_idx ON sessions (owner_user_id);
