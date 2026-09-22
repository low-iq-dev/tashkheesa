-- 112_rls_deleted_users_email_tables.sql
-- ============================================================================
-- Batch C (fix plan 2026-09-15, C5) — RLS on the three uncovered tables.
--
-- The Supabase advisory (recorded in docs/DOCTOR_APP_API_AUDIT.md §5.4)
-- reports ROW LEVEL SECURITY disabled on:
--
--   deleted_users          (096) — the erasure tombstones: hashed identifiers
--     of every deleted account. PII-adjacent by construction.
--   email_delivery_events  (098) — per-recipient delivery/bounce events:
--     email addresses and template names.
--   email_suppressions     (098) — suppressed recipient addresses.
--
-- A live pg_class check on 2026-09-22 (Supabase MCP, read-only) found exactly
-- ONE more public table with relrowsecurity = false, so it rides here and the
-- set truly closes:
--
--   doctor_sla_events      (109) — Batch B created it last week and missed
--     the per-table RLS opt-in that 073's worked example mandates for every
--     table born after 070. Doctor reliability data, same defect class.
--
-- EFFECT AND NON-EFFECT — same reasoning, same posture, same wording as 070,
-- 073 and 085: ENABLE ROW LEVEL SECURITY with NO policies and NO FORCE is
-- default-deny for every role that is not rolbypassrls. The application
-- connects as `postgres` (rolbypassrls = true) and is COMPLETELY UNAFFECTED.
-- Only anon / authenticated lose access, which is the entire intent. Nothing
-- in the repo or either Expo app uses those roles (RLS_LOCKDOWN_RUNBOOK §0).
--
-- Idempotent: ENABLE on an already-enabled table is a no-op. Each statement is
-- guarded on the table existing so a fresh/local DB that never ran 096/098
-- still boots.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.deleted_users') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.deleted_users ENABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.email_delivery_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.email_delivery_events ENABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.email_suppressions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.doctor_sla_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.doctor_sla_events ENABLE ROW LEVEL SECURITY';
  END IF;
END
$$;
