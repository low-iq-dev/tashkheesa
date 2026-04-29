-- 027: per-service urgency multiplier columns.
--
-- Per docs/PAYOUT_AND_URGENCY_POLICY.md §2 + §8: every service inherits the
-- platform-default 1.0/1.3/1.6 multipliers and the 30/70 doctor/platform
-- split on the urgency uplift. These columns are a future-flexibility
-- hook that lets product override per-service if a particular
-- specialty needs a different multiplier; for now every row uses the
-- defaults baked into the column definitions below.
--
-- Idempotent — IF NOT EXISTS guards on every ALTER.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'services'
       AND column_name = 'vip_multiplier'
  ) THEN
    ALTER TABLE services
      ADD COLUMN vip_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.30;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'services'
       AND column_name = 'urgent_multiplier'
  ) THEN
    ALTER TABLE services
      ADD COLUMN urgent_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.60;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'services'
       AND column_name = 'urgency_uplift_doctor_pct'
  ) THEN
    ALTER TABLE services
      ADD COLUMN urgency_uplift_doctor_pct INTEGER NOT NULL DEFAULT 30;
  END IF;
END
$$;

COMMIT;
