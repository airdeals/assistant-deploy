-- 0003_g3: доменный слой G3. 0001/0002 не переписываются — только ALTER/CREATE.

-- financial_events: confirmation_state unconfirmed/confirmed/rejected + provenance.
ALTER TABLE financial_events DROP CONSTRAINT IF EXISTS financial_events_confirmation_state_check;
ALTER TABLE financial_events ADD CONSTRAINT financial_events_confirmation_state_check
  CHECK (confirmation_state IN ('unconfirmed','confirmed','rejected'));
ALTER TABLE financial_events ALTER COLUMN confirmation_state SET DEFAULT 'unconfirmed';
ALTER TABLE financial_events ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'
  CHECK (origin IN ('manual','extracted'));
ALTER TABLE financial_events ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
-- correction_of уже есть в 0001 — корректировки журналируются новыми записями.

-- orders: полный жизненный цикл + payload черновика.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft','reviewed','confirmed','in_progress','done','cancelled'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- tasks: жизненный цикл G3 (open/done/cancelled + прежние состояния propose-цикла).
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending_owner_confirmation','confirmed','rejected','open','done','cancelled'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee text NOT NULL DEFAULT 'owner'
  CHECK (assignee IN ('owner','contact'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES persons(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due jsonb;              -- {kind:absolute|relative,...}
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low','normal','high'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prev_version_id uuid REFERENCES tasks(id);

-- pending_replies: модель ожиданий G3.
ALTER TABLE pending_replies ADD COLUMN IF NOT EXISTS question text NOT NULL DEFAULT '';
ALTER TABLE pending_replies ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending','proposed','answered','dismissed','needs_review'));
ALTER TABLE pending_replies ADD COLUMN IF NOT EXISTS resolution text NOT NULL DEFAULT 'none'
  CHECK (resolution IN ('none','rule','manual'));
ALTER TABLE pending_replies ADD COLUMN IF NOT EXISTS closed_by_message_id uuid REFERENCES messages(id);

-- chats: служебные чаты с самим ассистентом — не анализируются (AT-37).
ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_assistant_thread boolean NOT NULL DEFAULT false;

-- transcripts: needs_review + обработка/ошибки, журнал исправлений владельца.
ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_status_check;
ALTER TABLE transcripts ADD CONSTRAINT transcripts_status_check
  CHECK (status IN ('pending','processing','done','error','needs_review'));

CREATE TABLE IF NOT EXISTS transcript_corrections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id  uuid NOT NULL REFERENCES attachments(id),
  version        int NOT NULL,             -- версия, КОТОРУЮ исправили
  corrected_text text NOT NULL,
  corrected_at   timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','admin'))
);
