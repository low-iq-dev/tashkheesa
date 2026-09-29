-- ============================================================================
-- 123 — admin_notification_prefs: per-event loud / quiet / off for Command
--
-- 29 Sep 2026. The Command app is the founder's primary tool and every push it
-- received arrived the same way: sound, high priority, lock-screen interrupt.
-- A classifier parking a file buzzed exactly like a patient waiting on a
-- transfer to be verified. And the events that say the business is WORKING —
-- a signup, a paid case, a delivered report — did not push at all.
--
-- One row per (superadmin, event kind). A MISSING row means "use the default
-- for this kind" (services/ops_push_prefs.js KIND_CATALOGUE), so a new event
-- kind ships with a sensible default and nobody has to backfill rows. The mode
-- vocabulary ('loud' | 'quiet' | 'off') lives in code and is allowlisted on the
-- API write path — no CHECK constraint, following 121's precedent.
--
-- Some kinds are locked against 'off' in code (a transfer waiting to be
-- verified has exactly one verifier); a stored 'off' for those is ignored.
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_notification_prefs (
  user_id    text        NOT NULL,
  kind       text        NOT NULL,
  mode       text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind)
);

ALTER TABLE admin_notification_prefs ENABLE ROW LEVEL SECURITY;
