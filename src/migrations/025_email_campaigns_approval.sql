-- 025: human-approval gate for email_campaigns.
--
-- Closes B2 from the April 29 audit. Mirrors the existing
-- ig_scheduled_posts gate (see src/routes/superadmin.js:2780 — sets
-- status='approved', approved_by, approved_at on the IG approval transition).
--
-- For email_campaigns we use a COLUMN gate rather than a STATUS gate so we
-- don't have to migrate the existing state machine (draft → scheduled →
-- sending → sent → cancelled). The cron now requires both:
--   status = 'scheduled'  AND  approved_by IS NOT NULL
-- before auto-firing a campaign. Existing scheduled campaigns are left with
-- approved_by = NULL, which means they will NOT auto-fire — an admin must
-- explicitly approve them via POST /portal/admin/campaigns/:id/approve.
--
-- Column types match the existing email_campaigns columns:
--   approved_by  TEXT  (users.id is text in this schema)
--   approved_at  TIMESTAMP WITHOUT TIME ZONE  (matches created_at, sent_at,
--                                              scheduled_at on this table)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'email_campaigns'
      AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE email_campaigns
      ADD COLUMN approved_by TEXT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'email_campaigns'
      AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE email_campaigns
      ADD COLUMN approved_at TIMESTAMP NULL;
  END IF;
END $$;

-- Index supports the cron query: WHERE status='scheduled' AND approved_by IS NOT NULL
-- AND scheduled_at <= NOW(). Partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_email_campaigns_scheduled_approved
  ON email_campaigns (scheduled_at)
  WHERE status = 'scheduled' AND approved_by IS NOT NULL;
