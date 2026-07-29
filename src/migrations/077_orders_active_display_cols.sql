-- 077_orders_active_display_cols.sql
-- ============================================================================
-- Re-sync the orders_active VIEW after migration 076 added display_price /
-- display_currency to the orders base table (always-charge-EGP local display).
--
-- orders_active is `SELECT * FROM orders WHERE deleted_at IS NULL`, but Postgres
-- FREEZES `*` to the columns present AT CREATION TIME (last redefined by 069).
-- ALTER TABLE ADD COLUMN in 076 therefore did NOT propagate — the view is missing
-- display_price / display_currency. EVERY reader that goes through the view breaks
-- or silently blanks the intl figures:
--   - routes/patient.js pay route  (o.display_price FROM orders_active)  → 500
--   - new-case wizard Step 5        (loadOwnedDraft SELECT ... orders_active)
--   - notification worker           (SELECT * FROM orders_active → receipt email)
--   - legacy /order review          (order_flow.getOrder SELECT * FROM orders_active)
--
-- This RE-RUNS the view definition so `*` re-expands to the CURRENT orders
-- columns (the 069 fix pattern), and re-applies the 072 hardening
-- (security_invoker = true + REVOKE SELECT from anon/authenticated) so RLS still
-- evaluates as the caller. PURELY ADDITIVE: no data touched; a no-op re-run on a
-- DB whose view is already current. Guarded on the orders table existing so a
-- fresh / local DB still boots. Runs AFTER 076 (filename order).
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    -- Re-expand `*` to include display_price / display_currency. WITH
    -- (security_invoker = true) preserves the 072 hardening explicitly (a bare
    -- CREATE OR REPLACE could reset the reloption on some PG builds).
    EXECUTE 'CREATE OR REPLACE VIEW public.orders_active WITH (security_invoker = true) AS '
         || 'SELECT * FROM orders WHERE deleted_at IS NULL';

    -- 072 defense-in-depth: anon/authenticated must not read the view at all.
    -- Guarded per-role so a local DB (no Supabase roles) still boots.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE SELECT ON public.orders_active FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE SELECT ON public.orders_active FROM authenticated';
    END IF;
  END IF;
END $$;

-- Post-condition parity guard (069 pattern): orders_active must now project
-- EVERY orders column — including display_price / display_currency — or ABORT the
-- migration so a half-synced view fails loudly on boot instead of shipping.
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
    WHERE oc.table_schema = 'public' AND oc.table_name = 'orders'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns vc
        WHERE vc.table_schema = 'public' AND vc.table_name = 'orders_active'
          AND vc.column_name = oc.column_name
      );
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'orders_active view missing orders column(s) after 077: %', missing;
    END IF;
  END IF;
END $$;
