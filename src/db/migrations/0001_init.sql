-- 0001_init: начальная схема (PostgreSQL 16 + pgvector).
-- Все времена — timestamptz (UTC); даты событий — date в локальной зоне источника + source_tz у сообщений.

CREATE TABLE owners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES owners(id),
  platform               text NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  adapter                text NOT NULL,              -- wa1 | wa2 | tg1 | tg2
  own_external_id        text NOT NULL,
  connection_type        text NOT NULL,              -- import_only | live | coexistence
  capabilities           jsonb NOT NULL DEFAULT '{}'::jsonb,
  state                  text NOT NULL DEFAULT 'not_configured'
    CHECK (state IN ('not_configured','connecting','importing','live','degraded','disconnected','import_only')),
  imported_at            timestamptz,
  history_from           date,
  history_to             date,
  last_successful_sync_at timestamptz,
  last_checkpoint        jsonb,
  known_gaps             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, platform, own_external_id)
);

CREATE TABLE persons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES owners(id),
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Идентичности. external_id — телефон/user id; сравнение только по нему, не по имени.
CREATE TABLE identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES persons(id),
  external_id text NOT NULL,
  id_scope    text NOT NULL,        -- например 'wa:phone', 'tg:user'
  source      text NOT NULL,        -- откуда узнали (импорт/webhook/ручное)
  confirmed   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id_scope, external_id)
);

-- Журнал связей/разделений. Автослияние запрещено: confirmed=true только руками владельца.
CREATE TABLE person_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_id       uuid NOT NULL REFERENCES persons(id),
  b_id       uuid NOT NULL REFERENCES persons(id),
  action     text NOT NULL CHECK (action IN ('merge', 'split')),
  confirmed  boolean NOT NULL DEFAULT false,
  split_log  jsonb NOT NULL DEFAULT '[]'::jsonb,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chats (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id),
  external_chat_id text NOT NULL,
  type             text NOT NULL DEFAULT 'direct' CHECK (type IN ('direct','group','channel')),
  title            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_chat_id)
);

CREATE TABLE chat_participants (
  chat_id     uuid NOT NULL REFERENCES chats(id),
  person_id   uuid REFERENCES persons(id),
  external_id text NOT NULL,        -- для ещё не резолвнутых участников
  role        text,
  PRIMARY KEY (chat_id, external_id)
);

CREATE TABLE messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  chat_id        uuid NOT NULL REFERENCES chats(id),
  message_id     text NOT NULL,     -- внешний id
  author         text NOT NULL,     -- external_id автора
  direction      text NOT NULL CHECK (direction IN ('in','out')),
  sent_at        timestamptz NOT NULL,
  source_tz      text,              -- IANA-зона, в которой сообщение показано источником
  text           text NOT NULL DEFAULT '',
  edited_at      timestamptz,
  deleted_at     timestamptz,
  is_system      boolean NOT NULL DEFAULT false,
  invalidated    boolean NOT NULL DEFAULT false,  -- выводы агента устарели (правка/удаление)
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, chat_id, message_id)
);
CREATE INDEX messages_chat_sent_idx ON messages (chat_id, sent_at DESC);
CREATE INDEX messages_author_idx ON messages (author);

CREATE TABLE message_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES messages(id),
  seq           int NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('edit','delete','restore')),
  prev_text     text NOT NULL,
  new_text      text NOT NULL,
  at            timestamptz NOT NULL,
  UNIQUE (message_id, seq)
);

CREATE TABLE attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages(id),
  storage_ref text NOT NULL,
  hash        text,
  mime        text,
  size        bigint
);
CREATE INDEX attachments_message_idx ON attachments (message_id);

CREATE TABLE transcripts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id   uuid NOT NULL REFERENCES attachments(id),
  lang            text NOT NULL DEFAULT 'ru',
  version         int NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  corrected_text  text,
  UNIQUE (attachment_id, version)
);

-- Доказательная база: какое сообщение/ревизия обосновывает вывод агента.
CREATE TABLE evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages(id),
  revision    int,                  -- null = актуальная версия
  excerpt     text NOT NULL,
  entity_ref  text,                 -- например 'order:<id>', 'financial_event:<id>'
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','missing','redacted')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_entity_idx ON evidence (entity_ref);

CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES owners(id),
  key         text NOT NULL,        -- ключ идемпотентности
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'pending_owner_confirmation'
    CHECK (status IN ('pending_owner_confirmation','confirmed','rejected','done','cancelled')),
  due_on      date,
  source      text,                 -- например 'agent:propose_task'
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, key)
);

CREATE TABLE pending_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id    uuid NOT NULL REFERENCES chats(id),
  message_id uuid NOT NULL REFERENCES messages(id),
  from_person_id uuid REFERENCES persons(id),
  waiting_since timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id    uuid NOT NULL REFERENCES chats(id),
  counterparty_person_id uuid REFERENCES persons(id),
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id),
  title          text NOT NULL,
  qty            numeric NOT NULL CHECK (qty > 0),
  unit_price_minor bigint NOT NULL,
  currency       char(3) NOT NULL,
  position       int NOT NULL DEFAULT 0
);

CREATE TABLE order_revisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id),
  seq        int NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq)
);

CREATE TABLE financial_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid REFERENCES orders(id),
  from_person_id     uuid NOT NULL REFERENCES persons(id),
  to_person_id       uuid NOT NULL REFERENCES persons(id),
  type               text NOT NULL CHECK (type IN ('obligation','advance','payment_reported','refund','discount','cancel','promise')),
  amount_minor       bigint NOT NULL CHECK (amount_minor >= 0),
  currency           char(3) NOT NULL,
  occurred_on        date NOT NULL,
  confirmation_state text NOT NULL DEFAULT 'candidate' CHECK (confirmation_state IN ('confirmed','candidate')),
  correction_of      uuid REFERENCES financial_events(id),
  promise_due_on     date,
  evidence_message_id uuid REFERENCES messages(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX financial_events_parties_idx ON financial_events (from_person_id, to_person_id);

CREATE TABLE reminders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES owners(id),
  key        text NOT NULL,
  text       text NOT NULL,
  remind_at  timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sent','cancelled','failed')),
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, key)
);

CREATE TABLE delivery_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,
  channel          text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','rejected')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE sync_checkpoints (
  account_id uuid NOT NULL REFERENCES accounts(id),
  cursor     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id)
);

CREATE TABLE consents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES owners(id),
  scope      text NOT NULL,          -- например 'processing', 'agent_outgoing'
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE audit_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor      text NOT NULL,          -- 'owner' | 'agent' | 'system'
  action     text NOT NULL,
  entity_ref text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- pgvector: эмбеддинги откладываются, таблица — для будущего semantic-поиска.
-- Расширение обязано создаваться в той же БД (pgvector-образ не делает это за нас):
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE message_embeddings (
  message_id uuid NOT NULL REFERENCES messages(id),
  model      text NOT NULL,
  vector     vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, model)
);
