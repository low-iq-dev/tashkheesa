-- 026: bring add-on commission percentages into line with the canonical
-- payout policy (docs/PAYOUT_AND_URGENCY_POLICY.md §1, §9.1).
--
-- Migration 019 seeded both video_consult and prescription at
-- doctor_commission_pct = 80, and 002/019 set the services-side
-- video_doctor_commission_pct default to 80. Policy now says:
--   - Video consult add-on: 85% to doctor / 15% to platform
--   - Prescription add-on:  50% to doctor / 50% to platform
--
-- Per the brief, order_addons.doctor_commission_pct_at_purchase is the
-- locked-at-purchase rate on existing rows and represents historical
-- contracts — DO NOT backfill those. We only update the master
-- addon_services rows (the source of truth for new orders going forward)
-- and the services.video_doctor_commission_pct column default + existing
-- rows that still carry the old 80.
--
-- Idempotent — re-running this against a database that already has the
-- new values is a no-op (UPDATE WHERE clauses gate on the old values).

BEGIN;

-- 1. services.video_doctor_commission_pct: 80 → 85 (default + existing rows
--    that haven't been customised away from the default)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'services'
       AND column_name = 'video_doctor_commission_pct'
  ) THEN
    EXECUTE 'ALTER TABLE services ALTER COLUMN video_doctor_commission_pct SET DEFAULT 85';
    UPDATE services SET video_doctor_commission_pct = 85
      WHERE video_doctor_commission_pct = 80;
  END IF;
END
$$;

-- 2. addon_services seed rows — update master commission rates.
--    Note: actual table name is addon_services (not addons); this is the
--    table created in migration 019.

UPDATE addon_services
   SET doctor_commission_pct = 85,
       updated_at            = NOW()
 WHERE id = 'video_consult'
   AND doctor_commission_pct = 80;

UPDATE addon_services
   SET doctor_commission_pct = 50,
       updated_at            = NOW()
 WHERE id = 'prescription'
   AND doctor_commission_pct = 80;

COMMIT;
