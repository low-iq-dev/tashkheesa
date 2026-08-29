-- What actually happened to each email.
--
-- WHY. Until now this platform recorded only that Resend ACCEPTED a message.
-- notifications.response held {"ok":true,"messageId":"..."} and that was the
-- end of the story. Nothing ingested delivery events, so a bounced address, a
-- spam complaint and a message read in full were indistinguishable.
--
-- On 2026-08-29 that cost real supply: four doctors — two of them half of the
-- uncovered OB/GYN pool — were on Resend's suppression list. Twelve invites
-- were sent to them across three batches. Every one was logged as delivered.
-- None arrived. They read as "ignoring us" for eighteen days while the truth
-- was that they had never been contacted.
--
-- The same blindness applies to patients after launch: a payment confirmation
-- that bounces looks identical to one that landed.
--
-- Two tables, deliberately:
--   email_delivery_events  the append-only log — every event, kept for audit
--   email_suppressions     the derived answer to "can we email this address"
--
-- The second is not a view because the answer must survive an event table
-- prune, and because it carries a manual override column: an operator who has
-- corrected a typo needs to say so, and no incoming event will ever say it
-- for them.

CREATE TABLE IF NOT EXISTS email_delivery_events (
  id           TEXT PRIMARY KEY,
  message_id   TEXT,
  email        TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload      JSONB
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_email      ON email_delivery_events(lower(email));
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id ON email_delivery_events(message_id);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_received   ON email_delivery_events(received_at DESC);

-- Svix retries on any non-2xx, so the same event can arrive several times.
-- The webhook writes the Svix message id as the primary key, which makes a
-- replay a no-op instead of a duplicate row.

CREATE TABLE IF NOT EXISTS email_suppressions (
  email          TEXT PRIMARY KEY,
  reason         TEXT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_count    INTEGER NOT NULL DEFAULT 1,
  -- Set by an operator who has fixed the address or confirmed it is fine.
  -- Never set by an incoming event: a bounce can create a suppression, only a
  -- human can retire one, and the audit trail of who did it matters.
  cleared_at     TIMESTAMPTZ,
  cleared_by     TEXT,
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_suppressions_active
  ON email_suppressions(email) WHERE cleared_at IS NULL;

-- Backfill: the four addresses Resend reported as suppressed on 2026-08-29,
-- recorded so the outreach console stops pretending these doctors have been
-- contacted. Seeded as 'reported_by_operator' rather than 'bounced' because
-- the underlying reason (hard bounce vs spam complaint) was not visible from
-- the dashboard listing and guessing it would be a lie in a table people will
-- use to decide whether to email someone.
INSERT INTO email_suppressions (email, reason, note)
VALUES
  ('shepood.fouad@gmail.com',        'reported_by_operator', 'Resend suppression list, 2026-08-29. 3 invites logged as delivered, 0 arrived.'),
  ('mohammedelmokalem36@gmail.com',  'reported_by_operator', 'Resend suppression list, 2026-08-29. 3 invites logged as delivered, 0 arrived.'),
  ('hassankh695@gmail.com',          'reported_by_operator', 'Resend suppression list, 2026-08-29. 3 invites logged as delivered, 0 arrived.'),
  ('mohamed.eldars234@yahoo.com',    'reported_by_operator', 'Resend suppression list, 2026-08-29. 3 invites logged as delivered, 0 arrived.')
ON CONFLICT (email) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM email_suppressions WHERE cleared_at IS NULL) < 4 THEN
    -- WARNING, never EXCEPTION. Migrations run on boot and a raised exception
    -- here would exit the process and boot-loop the platform forever over a
    -- reporting table.
    RAISE WARNING 'email_suppressions: expected at least the 4 seeded rows, found fewer';
  END IF;
END $$;
