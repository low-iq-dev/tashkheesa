-- 071_drop_orphan_backup_tables.sql
-- ============================================================================
-- PROPOSED — REVIEW ARTIFACT. Lives in docs/sql/ ONLY.
-- DO NOT move into src/migrations/ until approved AND a fresh pg_dump backup of
-- prod has been taken (RLS_LOCKDOWN_RUNBOOK §A.3). Destructive.
--
-- Drops 3 tables with NO non-migration / non-test / non-doc references in src/:
--   • appointment_slots                      — orphaned; the appointments feature
--       was built on doctor_availability + proposed-time columns and never used it.
--   • notify_whatsapp_migration_062_backup   — one-time backup from migration 062.
--   • services_sla_hours_migration_063_backup — one-time backup from migration 063.
--
-- Uses RESTRICT (not CASCADE): if anything unexpectedly depends on these, the drop
-- ABORTS rather than silently removing dependents.
-- Order vs 070: filename order runs 070 (RLS) first; 070 explicitly EXCLUDES these
-- 3, so they stay RLS-off until dropped here. Order-independent either way.
-- ============================================================================

DO $$
DECLARE
  drops text[] := ARRAY[
    'appointment_slots',
    'notify_whatsapp_migration_062_backup',
    'services_sla_hours_migration_063_backup'
  ];
  inbound int;
BEGIN
  -- Guard: refuse if any FK from another table still references a drop target.
  SELECT count(*) INTO inbound
  FROM pg_constraint con
  JOIN pg_class ref      ON ref.oid = con.confrelid
  JOIN pg_namespace n    ON n.oid   = ref.relnamespace
  WHERE con.contype = 'f'
    AND n.nspname = 'public'
    AND ref.relname = ANY(drops);
  IF inbound > 0 THEN
    RAISE EXCEPTION 'Drop abort: % inbound FK(s) still reference a drop-candidate — resolve first.', inbound;
  END IF;
END $$;

DROP TABLE IF EXISTS public.appointment_slots                       RESTRICT;
DROP TABLE IF EXISTS public.notify_whatsapp_migration_062_backup    RESTRICT;
DROP TABLE IF EXISTS public.services_sla_hours_migration_063_backup RESTRICT;

-- Post-check (run separately):
--   SELECT count(*) AS public_tables FROM pg_class c
--   JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relkind='r';   -- expect 58
