-- Откат 0003_g3.
DROP TABLE IF EXISTS transcript_corrections;

ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_status_check;
ALTER TABLE transcripts ADD CONSTRAINT transcripts_status_check
  CHECK (status IN ('pending','done','failed'));

ALTER TABLE chats DROP COLUMN IF EXISTS is_assistant_thread;

ALTER TABLE pending_replies DROP CONSTRAINT IF EXISTS pending_replies_status_check;
ALTER TABLE pending_replies DROP CONSTRAINT IF EXISTS pending_replies_resolution_check;
ALTER TABLE pending_replies DROP COLUMN IF EXISTS closed_by_message_id;
ALTER TABLE pending_replies DROP COLUMN IF EXISTS resolution;
ALTER TABLE pending_replies DROP COLUMN IF EXISTS status;
ALTER TABLE pending_replies DROP COLUMN IF EXISTS question;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending_owner_confirmation','confirmed','rejected','done','cancelled'));
ALTER TABLE tasks DROP COLUMN IF EXISTS prev_version_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS version;
ALTER TABLE tasks DROP COLUMN IF EXISTS close_reason;
ALTER TABLE tasks DROP COLUMN IF EXISTS priority;
ALTER TABLE tasks DROP COLUMN IF EXISTS due;
ALTER TABLE tasks DROP COLUMN IF EXISTS person_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS assignee;

ALTER TABLE orders DROP COLUMN IF EXISTS payload;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft','confirmed','cancelled'));

ALTER TABLE financial_events DROP COLUMN IF EXISTS evidence;
ALTER TABLE financial_events DROP COLUMN IF EXISTS origin;
ALTER TABLE financial_events ALTER COLUMN confirmation_state SET DEFAULT 'candidate';
ALTER TABLE financial_events DROP CONSTRAINT IF EXISTS financial_events_confirmation_state_check;
ALTER TABLE financial_events ADD CONSTRAINT financial_events_confirmation_state_check
  CHECK (confirmation_state IN ('confirmed','candidate'));
