-- ============================================================================
-- 122 — funnel_daily_counts: top-of-funnel page views we cannot get from rows
--
-- 27 Sep 2026. Paid traffic (Meta) is landing on /ar/start and producing
-- clicks but no signups, and the only question that matters — where do they
-- drop? — had no answer in the database. Signups, drafts, uploads, submits and
-- payments are already rows (users / orders.draft_step / payment_status); the
-- two steps BEFORE an account exists (landing view, register view) were not.
--
-- Aggregate counters only: one row per Cairo day per step. No user id, no IP,
-- no user agent — nothing personal is stored. The daily founder digest
-- (services/funnel_digest.js) also claims its once-a-day send here with a
-- '__digest_sent' row (INSERT ... ON CONFLICT DO NOTHING is the atomic claim).
-- ============================================================================

CREATE TABLE IF NOT EXISTS funnel_daily_counts (
  day        DATE        NOT NULL,
  step       TEXT        NOT NULL,
  n          INTEGER     NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, step)
);

ALTER TABLE funnel_daily_counts ENABLE ROW LEVEL SECURITY;
