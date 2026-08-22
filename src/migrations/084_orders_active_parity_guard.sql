-- 084_orders_active_parity_guard.sql
-- ============================================================================
-- AUDIT-2026-08-22 — restore the orders_active parity guard that 081 dropped.
--
-- THE BUG THIS RE-CLOSES
-- ----------------------
-- public.orders_active is `SELECT * FROM orders WHERE deleted_at IS NULL`, and
-- PostgreSQL FREEZES the `*` to the column list present at view-creation time.
-- Every `ALTER TABLE orders ADD COLUMN` since has therefore left the view behind,
-- silently, and every reader of orders_active saw a table that was missing the
-- new column. Three migrations exist only because of that:
--   069_orders_active_view_projection_fix.sql
--   077_orders_active_display_cols.sql
--   080_codify_orders_column_drift.sql
-- Each of the three ended with the SAME post-condition guard: re-create the view,
-- then compare information_schema.columns for `orders` against `orders_active`
-- and RAISE EXCEPTION if anything is missing — so a half-synced view aborts the
-- boot loudly instead of shipping.
--
-- WHY IT IS GONE
-- --------------
-- 081_timestamptz_sla_columns.sql had to DROP every view depending on the
-- columns it retyped and rebuild them from pg_get_viewdef(). That is correct and
-- it did restore the 072 hardening (security_invoker + REVOKE from anon /
-- authenticated) — but it rebuilt orders_active from the captured definition and
-- did NOT re-add the parity guard. 081 is the last migration to touch the view,
-- so the guard is currently absent from the schema's history: the next
-- `ALTER TABLE orders ADD COLUMN` reintroduces the exact bug 069, 077 and 080
-- were written to fix, and nothing will fail.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. CREATE OR REPLACE the view so it is current as of today (a no-op when it
--      already matches), preserving the 072 hardening.
--   2. Re-assert the 080 post-condition guard verbatim.
--
-- Idempotent: both steps are guarded on `orders` existing and neither writes data.
-- No explicit BEGIN/COMMIT — the runner (src/db.js) sends this file as one
-- multi-statement simple query and wraps it, together with its schema_migrations
-- row, in a single transaction.
--
-- MAINTAINER NOTE: any future migration that adds a column to `orders`, or that
-- drops and recreates orders_active, must carry this block forward. That is the
-- whole point of it.
-- ============================================================================

-- Re-sync the frozen `SELECT *` projection, preserving the 072 hardening
-- (security_invoker = true + no read for the Supabase anon / authenticated
-- roles). Copied from 080_codify_orders_column_drift.sql:46-62.
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

-- Post-condition parity guard (069/077/080 pattern): orders_active must project
-- EVERY orders column or ABORT, so a half-synced view fails loudly on boot
-- instead of shipping. Copied from 080_codify_orders_column_drift.sql:67-91.
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
      RAISE EXCEPTION 'Migration 084: orders_active is missing orders columns after re-sync: %', missing;
    END IF;
  END IF;
END $$;
