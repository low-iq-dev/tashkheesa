-- ============================================================================
-- 132 — draft_resume_tokens: the links in the draft-resume nudges
--
-- 2 Nov 2026 (patient recovery, Part A). A patient who starts a case and stops
-- gets at most two fixed-copy reminders (services/draft_nudges.js), each with a
-- link that reopens THAT draft: /portal/patient/resume/<token>, or the short
-- /r/<token> in an SMS (routes/draft_resume.js).
--
-- The token is signed and single-draft: <10-char id><12-char HMAC of the id
-- under a key derived from JWT_SECRET>. Only its SHA-256 is stored, so a read
-- of this table (or of notifications, which carries the id, never the token)
-- cannot produce a working link. It never signs anyone in: without the
-- patient's own session it goes to login with `next` set to the draft.
--
--   order_id / patient_id   the one draft, and whose — checked again on open
--   level                   '1h' | '24h' (a nudge) or 'lead' (Part C's
--                           "the specialty you asked about is open")
--   expires_at              created_at + 72 hours; an expired token opens nothing
--   first/last_opened_at    when the link was used; last_opened_at is activity:
--                           the nudge clock and the abandoned_case attention arm
--                           read GREATEST(orders.updated_at, last_opened_at), so
--                           a resumed draft is quiet until it goes idle again.
--                           Nothing here writes orders.updated_at — that column
--                           is also the draft's 30-day expiry clock.
--   converted_at            set by the sweep when the draft was submitted
--                           within 72 hours of this nudge (the funnel's
--                           draft_resume_converted).
--
-- RLS on, no policies: the app connects as the table owner; nothing is exposed
-- through the Supabase API. Safe to run twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS draft_resume_tokens (
  id               TEXT        PRIMARY KEY,
  token_hash       TEXT        NOT NULL,
  order_id         TEXT        NOT NULL,
  patient_id       TEXT        NOT NULL,
  level            TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  first_opened_at  TIMESTAMPTZ,
  last_opened_at   TIMESTAMPTZ,
  open_count       INTEGER     NOT NULL DEFAULT 0,
  converted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS draft_resume_tokens_hash_idx ON draft_resume_tokens (token_hash);
CREATE INDEX IF NOT EXISTS draft_resume_tokens_order_idx ON draft_resume_tokens (order_id, created_at DESC);

ALTER TABLE draft_resume_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE draft_resume_tokens IS
  'Draft-resume links (patient recovery Part A, 2 Nov 2026). Token = id + HMAC; '
  'only its SHA-256 is stored. One draft, 72 hours, never a sign-in.';
