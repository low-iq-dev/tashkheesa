-- 080_codify_orders_column_drift.sql
-- ============================================================================
-- AUDIT-P1-1 (audit 2026-08-16, findings C2/C3).
--
-- Four columns are written and/or read by live code but created by NO migration.
-- They exist in production only because ad-hoc scripts (notably the since-deleted
-- src/migrate_mobile_api.js) once ran there. Consequence: any database built
-- from src/migrations/ alone — a fresh clone, a new staging instance, a
-- disaster-recovery restore, a CI database — is missing them, and the project
-- has no reproducible way to stand itself up.
--
--   orders.sla_deadline
--     Written by routes/api/cases.js (the mobile POST /cases INSERT) and by
--     routes/patient.js (the urgent-tier "wait" branch UPDATE). On a fresh DB
--     the INSERT throws `column "sla_deadline" of relation "orders" does not
--     exist` via execute(), which does NOT swallow — so mobile case submission
--     500s for every user.
--     NOTE: 043_codify_mobile_api_schema.sql claims this column is "already
--     covered (001)". It is not — 001 creates sla_deadline on the CASES table,
--     not on ORDERS. That mis-credit is why the migration was never written.
--
--   orders.locked_price / locked_currency / price_snapshot_json
--     Read defensively (`order.locked_currency || 'EGP'`) by routes/payments.js,
--     routes/referrals.js and routes/video.js, and stripped from doctor-facing
--     payloads by routes/doctor.js. The only writer is the legacy
--     POST /patient/orders creator, which now returns 410 Gone before reaching
--     its INSERT — so this is latent rather than breaking today. Codified anyway
--     so a fresh database matches production and the columns stop being a
--     tripwire for anyone who re-enables that path or adds a new reader.
--
-- All four are additive and nullable. On production (where they already exist)
-- every statement is a no-op.
-- ============================================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS sla_deadline        TIMESTAMP,
  ADD COLUMN IF NOT EXISTS locked_price        NUMERIC,
  ADD COLUMN IF NOT EXISTS locked_currency     TEXT,
  ADD COLUMN IF NOT EXISTS price_snapshot_json TEXT;

-- orders_active is `SELECT *`, which Postgres FREEZES at view-creation time.
-- Migrations 069 and 077 exist solely because a previous ALTER TABLE orders
-- shipped without this re-sync and silently broke every orders_active reader.
-- Re-run it here for the same reason, preserving the 072 hardening
-- (security_invoker = true + REVOKE SELECT from anon/authenticated).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.orders_active WITH (security_invoker = true) AS '
         || 'SELECT * FROM orders WHERE deleted_at IS NULL';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE SELECT ON public.orders_active FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE SELECT ON public.orders_active FROM authenticated';
    END IF;
  END IF;
END $$;

-- Post-condition parity guard (069/077 pattern): orders_active must project
-- EVERY orders column or ABORT, so a half-synced view fails loudly on boot
-- instead of shipping.
DO $$
DECLARE
  missing text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    SELECT string_agg(oc.column_name, ', ' ORDER BY oc.ordinal_position)
      INTO missing
    FROM information_schema.columns oc
    WHERE oc.table_schema = 'public'
      AND oc.table_name  = 'orders'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns vc
        WHERE vc.table_schema = 'public'
          AND vc.table_name   = 'orders_active'
          AND vc.column_name  = oc.column_name
      );

    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'orders_active is missing orders columns after re-sync: %', missing;
    END IF;
  END IF;
END $$;
