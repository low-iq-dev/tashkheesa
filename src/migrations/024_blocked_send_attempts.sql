-- 024: blocked_send_attempts — audit log for the recipient guard.
-- Every time emailService refuses to send because validateRecipient() blocks
-- the address (fake/test domain, missing MX, demo patient pattern, etc.) we
-- record one row here. Used to trace which agent/skill is generating bad
-- addresses so we can fix the source rather than just suppressing bounces.

CREATE TABLE IF NOT EXISTS blocked_send_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT,
  domain       TEXT,
  reason       TEXT NOT NULL,
  subject      TEXT,
  stack_caller TEXT,
  agent_name   TEXT,
  skill_name   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocked_send_attempts_created_at
  ON blocked_send_attempts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blocked_send_attempts_agent_name
  ON blocked_send_attempts (agent_name);
