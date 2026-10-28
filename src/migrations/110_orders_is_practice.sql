-- 110_orders_is_practice.sql
--
-- Practice cases for doctor onboarding: real rows in the doctor's real queue,
-- so they learn the real interface rather than a mock of it - but invisible to
-- money, to metrics and to the automated machinery.
--
-- NOT NULL DEFAULT FALSE means every existing row and every future real case is
-- untouched. Only a row explicitly marked TRUE is a practice case.
alter table public.orders
  add column if not exists is_practice boolean not null default false;

comment on column public.orders.is_practice is
  'TRUE = a seeded training case for doctor onboarding. Never produces doctor_earnings, never counts in dashboard stats, never suppresses the account-complete panel. Real cases are always FALSE.';

-- orders_active is what the doctor queue, the SLA sweeps, the load balancer and
-- earnings_writer all read, so the flag has to be visible through it or none of
-- the exclusions can be written.
--
-- ── orders_active re-sync (rewritten 2026-10-27) ────────────────────────────
-- This file first shipped (f6dd359, 22 Sep) with an explicit column list: the
-- order of production's orders table, with is_practice appended. Two defects:
--   1. A database built from these migrations has a DIFFERENT orders column
--      order (columns arrive in a different sequence), so CREATE OR REPLACE
--      VIEW refused with 42P16 "cannot change name of view column
--      broadcast_sent_at to reference_id" — fatal, so no fresh database (CI,
--      a new staging, a rebuild) could migrate past 109.
--   2. A bare CREATE OR REPLACE VIEW resets the view's options, so it dropped
--      the 072 hardening (security_invoker = true) wherever it ran.
-- Production applied the original and the ledger matches on filename only, so
-- production never runs this text. On a fresh database it is now the 084 / 121
-- / 129 block verbatim: `SELECT *` (the view's own column order, with
-- is_practice appended), the hardening kept, a refusal a deploy-log WARNING
-- rather than a crash-loop, and the parity guard after it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
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
      RAISE WARNING 'Migration 110: could NOT re-sync public.orders_active (% %). NOT FATAL, boot continues, but orders_active may be missing is_practice. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (check pg_depend first and rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;',
        SQLSTATE, SQLERRM;
    END;
  END IF;
END $$;

-- Post-condition parity guard, copied from 084 / 121 / 129 (WARNING unless
-- tashkheesa.migration_strict is on).
DO $$
DECLARE
  missing text;
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
      IF strict_mode THEN
        RAISE EXCEPTION 'Migration 110: orders_active is missing orders columns after re-sync: % (tashkheesa.migration_strict is on)', missing;
      ELSE
        RAISE WARNING 'Migration 110: orders_active is MISSING orders columns after re-sync: %. Readers of orders_active cannot see these columns. NOT FATAL, boot continues. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;', missing;
      END IF;
    END IF;
  END IF;
END $$;

-- The exclusions are all "doctor_id = $1 and not is_practice", so the partial
-- index keeps those counts cheap without touching the real-case path.
create index if not exists orders_practice_idx
  on public.orders (doctor_id) where is_practice;
