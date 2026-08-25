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
--   2. Re-assert the 080 post-condition guard — as a WARNING, not an abort; see
--      AUDIT-084-BLAST-RADIUS-1 below.
--
-- Idempotent: both steps are guarded on `orders` existing and neither writes data.
-- No explicit BEGIN/COMMIT — the runner (src/db.js) sends this file as one
-- multi-statement simple query and wraps it, together with its schema_migrations
-- row, in a single transaction.
--
-- MAINTAINER NOTE: any future migration that adds a column to `orders`, or that
-- drops and recreates orders_active, must carry this block forward. That is the
-- whole point of it.
--
-- ── AUDIT-2026-08-22 (AUDIT-084-BLAST-RADIUS-1): WHY NOTHING HERE ABORTS ────
-- As first written, this file could take the whole service down permanently and
-- there was no way out of it short of a manual INSERT into schema_migrations:
--
--   * `CREATE OR REPLACE VIEW` is NOT a rebuild. PostgreSQL refuses it (42P16,
--     "cannot change name of view column" / "cannot drop columns from view") if
--     the new `SELECT *` column list drops or REORDERS any existing column. Any
--     `ALTER TABLE orders DROP COLUMN` in the schema's future — or a restored
--     database whose column order differs — turns this into a hard failure.
--   * `RAISE EXCEPTION` on the parity check aborts the transaction outright.
--
-- Either one makes src/db.js's migrate() throw, which makes server.js exit(1),
-- which crash-loops the service forever. There is no down-migration. The guard's
-- VALUE is telling a human that orders_active has drifted; its value is NOT
-- worth a total outage, and a deploy log line delivers it just as well.
--
-- So both steps now RAISE WARNING and let the boot continue, and each message
-- names the exact SQL to run. A reviewer checked for `ALTER TABLE orders DROP
-- COLUMN` after 080 and found none, so the happy path is expected to be clean —
-- this is about what happens when that expectation is wrong.
--
-- TO MAKE THE PARITY GUARD FATAL AGAIN (e.g. in CI, or once you are confident):
--   ALTER DATABASE <db> SET tashkheesa.migration_strict = 'on';   -- or
--   ALTER ROLE <app role> SET tashkheesa.migration_strict = 'on';
-- Anything other than on/true/1 leaves it as a warning.
--
-- TO SKIP THIS FILE ENTIRELY (last resort, if it ever does block a boot):
--   INSERT INTO schema_migrations (filename)
--   VALUES ('084_orders_active_parity_guard.sql')
--   ON CONFLICT (filename) DO NOTHING;
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
    -- AUDIT-2026-08-22 (AUDIT-084-BLAST-RADIUS-1) — the CREATE OR REPLACE is
    -- wrapped in its own exception block. A PL/pgSQL BEGIN…EXCEPTION opens an
    -- implicit savepoint, so a failure here rolls back ONLY this statement; the
    -- outer transaction (and therefore the boot) survives.
    BEGIN
      EXECUTE 'CREATE OR REPLACE VIEW public.orders_active WITH (security_invoker = true) AS '
           || 'SELECT * FROM orders WHERE deleted_at IS NULL';

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE SELECT ON public.orders_active FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE SELECT ON public.orders_active FROM authenticated';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Single string literal on purpose: RAISE's format argument must be one
      -- literal token, and this file's failure mode is a crash-loop, so it must
      -- not rely on adjacent-literal concatenation parsing.
      RAISE WARNING 'Migration 084: could NOT re-sync public.orders_active (% %). NOT FATAL, boot continues, but orders_active may be missing columns that exist on orders. CREATE OR REPLACE VIEW refuses to drop or reorder existing view columns, which is the usual cause. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (check pg_depend first and rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;',
        SQLSTATE, SQLERRM;
    END;
  END IF;
END $$;

-- Post-condition parity guard (069/077/080 pattern): orders_active must project
-- EVERY orders column. Copied from 080_codify_orders_column_drift.sql:67-91,
-- except that 080's RAISE EXCEPTION is a RAISE WARNING here unless
-- tashkheesa.migration_strict is on — see AUDIT-084-BLAST-RADIUS-1 in the header.
DO $$
DECLARE
  missing text;
  -- AUDIT-2026-08-22 (AUDIT-084-BLAST-RADIUS-1) — opt-in strictness. Unset (the
  -- normal case) yields NULL, so the guard warns. See the file header for how to
  -- turn it on.
  strict_mode boolean :=
    lower(COALESCE(current_setting('tashkheesa.migration_strict', true), 'off'))
      IN ('on','true','1','yes');
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
      -- AUDIT-2026-08-22 (AUDIT-084-BLAST-RADIUS-1) — WARNING by default, not
      -- EXCEPTION. An aborted transaction here means migrate() throws,
      -- server.js exits 1 and the service crash-loops with no down-migration
      -- and no skip mechanism. Drift in a view is a data-correctness bug worth
      -- shouting about; it is not worth a total outage. The operator gets the
      -- exact remediation, and the deploy still completes.
      IF strict_mode THEN
        RAISE EXCEPTION 'Migration 084: orders_active is missing orders columns after re-sync: % (tashkheesa.migration_strict is on)', missing;
      ELSE
        RAISE WARNING 'Migration 084: orders_active is MISSING orders columns after re-sync: %. Readers of orders_active cannot see these columns. NOT FATAL, boot continues. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT; Then re-run this check with: DELETE FROM schema_migrations WHERE filename = ''084_orders_active_parity_guard.sql''; and redeploy (084 is idempotent).', missing;
      END IF;
    END IF;
  END IF;
END $$;
