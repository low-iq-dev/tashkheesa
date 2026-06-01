-- 068_pre_launch_leads_v2.sql
--
-- Extend pre_launch_leads for the launch-comms refit (June 2026).
-- The /coming-soon page is the CTA target for paid Instagram traffic and
-- needs (a) richer attribution, (b) consent gating before any outbound
-- email/SMS, (c) per-channel dispatch state, and (d) a launch-blast
-- "have we already pinged this lead" marker.
--
-- All changes are PURELY ADDITIVE:
--   * ADD COLUMN IF NOT EXISTS — idempotent, no existing data touched.
--   * New columns either NULLable or have a SAFE default (consent=false
--     for legacy rows, so they are excluded from launch dispatch until
--     an admin explicitly opts them in).
--   * Unique index on LOWER(email) is created ONLY when there are zero
--     case-insensitive duplicates. If duplicates exist (legacy Instagram
--     traffic might have submitted the same email twice), the index is
--     skipped and the app-level upsert (SELECT-then-UPDATE/INSERT) is
--     the dedupe surface. The migration RAISES NOTICE in that case so
--     ops sees the gap on Render boot logs and can dedupe later.
--
-- No UPDATE/DELETE of existing rows. Re-run is a no-op.

BEGIN;

-- ─── New columns (idempotent) ────────────────────────────────────────
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS phone_e164 TEXT;
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS consent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS confirm_email_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS confirm_sms_status TEXT NOT NULL DEFAULT 'na';
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS launch_notified_at TIMESTAMPTZ;
ALTER TABLE pre_launch_leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- ─── Status sanity constraints (idempotent) ──────────────────────────
-- ADD CONSTRAINT ... IF NOT EXISTS is not supported on Postgres, so we
-- gate via pg_constraint lookup. Names follow the table_column_check
-- convention used by 049, 054, 057.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pre_launch_leads_confirm_email_status_check'
  ) THEN
    ALTER TABLE pre_launch_leads
      ADD CONSTRAINT pre_launch_leads_confirm_email_status_check
      CHECK (confirm_email_status IN ('pending','sent','failed','na'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pre_launch_leads_confirm_sms_status_check'
  ) THEN
    ALTER TABLE pre_launch_leads
      ADD CONSTRAINT pre_launch_leads_confirm_sms_status_check
      CHECK (confirm_sms_status IN ('na','pending','sent','failed'));
  END IF;
END $$;

-- ─── Helpful indexes for the admin view + launch blast query ─────────
CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_consent_launched
  ON pre_launch_leads(consent, launch_notified_at);

CREATE INDEX IF NOT EXISTS idx_pre_launch_leads_confirm_email_status
  ON pre_launch_leads(confirm_email_status);

-- ─── Conditional unique index on LOWER(email) for upsert ─────────────
-- We try to create it; if legacy rows already contain duplicates (case-
-- insensitive), we skip creation and rely on the app-level upsert. The
-- app guards against duplicates via SELECT-then-UPDATE/INSERT inside a
-- transaction (see static-pages.js), so this index is belt-and-braces.
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*)
    INTO dup_count
    FROM (
      SELECT LOWER(email) AS k
        FROM pre_launch_leads
       WHERE email IS NOT NULL AND email <> ''
       GROUP BY LOWER(email)
      HAVING COUNT(*) > 1
    ) d;

  IF dup_count = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS pre_launch_leads_email_lower_unique
      ON pre_launch_leads (LOWER(email));
  ELSE
    RAISE NOTICE
      '[mig 068] Skipping pre_launch_leads_email_lower_unique: % case-insensitive duplicate emails exist. App-level upsert still safe; dedupe is a follow-up.',
      dup_count;
  END IF;
END $$;

COMMIT;
