-- 070_rls_enable_default_deny.sql
-- ============================================================================
-- PROPOSED — REVIEW ARTIFACT. Lives in docs/sql/ ONLY.
-- DO NOT move into src/migrations/ until BOTH are true:
--   (1) this DDL is approved, AND
--   (2) the prod dashboard toggles (disable Data API + disable anon/publishable
--       keys) are already LIVE and verified green (see RLS_LOCKDOWN_RUNBOOK §5).
-- Committing this ahead of the dashboard changes would let a Render deploy run
-- while the anon REST path is still open — the exact window we are avoiding.
--
-- EFFECT: ENABLE ROW LEVEL SECURITY (default-deny: NO policies, NO FORCE) on the
-- 58 surviving public base tables. The app connects as role `postgres`
-- (rolbypassrls=true) and is therefore UNAFFECTED; the only roles RLS constrains —
-- anon / authenticated (rolbypassrls=false) — get zero rows. The 3 orphan/backup
-- tables are intentionally excluded here (dropped by 071).
-- Idempotent: ENABLE on an already-enabled table is a no-op.
-- ============================================================================

DO $$
DECLARE
  survivors text[] := ARRAY[
    'admin_settings','agent_config','agent_heartbeats','agent_token_log','appointment_payments',
    'appointments','campaign_recipients','case_annotations','case_context','case_events',
    'case_extractions','case_files','cases','chat_reports','conversations',
    'doctor_assignments','doctor_availability','doctor_earnings','doctor_specialties','email_campaigns',
    'error_logs','file_ai_checks','ig_scheduled_posts','medical_records','messages',
    'notifications','order_additional_files','order_events','order_files','order_timeline',
    'orders','otp_codes','password_reset_tokens','pre_launch_leads','prescriptions',
    'referral_codes','referral_redemptions','report_exports','reviews','schema_migrations',
    'service_regional_prices','services','specialties','users','video_calls',
    'app_waitlist','app_analytics_events','addon_services','order_addons','addon_earnings',
    'prescribed_medications_log','refunds','blocked_send_attempts','doctor_services','payment_events',
    'critical_alert_log','specialty_classifications','specialty_classification_overrides'
  ];  -- 58 tables
  orphans text[] := ARRAY[
    'appointment_slots','notify_whatsapp_migration_062_backup','services_sla_hours_migration_063_backup'
  ];  -- 3 tables, dropped by 071
  -- AUDIT-2026-08-22 — tables created by migrations that run AFTER this one.
  --
  -- ── AUDIT-2026-08-22 (AUDIT-070-EXEMPTION-1): NARROWED. READ BEFORE EDITING ──
  --
  -- The original note ended with "ADD EVERY NEW PUBLIC TABLE HERE". That
  -- instruction is REVOKED. Two things were wrong with it:
  --
  --   1. On the normal paths this array does nothing at all. On an EXISTING
  --      database 070 is already recorded in schema_migrations and never runs
  --      again, so nothing here can affect it. On a FRESH database 070 runs at
  --      position 070 — before 073 / 075 / 082 create these three tables — so
  --      Guard 2 could never have seen them either.
  --   2. Following it would permanently exempt every future table from Guard 2,
  --      the ONLY drift check that catches an unclassified public table on a
  --      fresh build. The array would quietly become an allowlist for exactly
  --      the thing the guard exists to detect.
  --
  -- WHY IT IS KEPT RATHER THAN REVERTED: there is one real path where these
  -- three tables DO exist while 070 has not been recorded — a database restored
  -- from a dump of a later schema and then migrated from scratch, and any
  -- environment where the ledger and the schema were reconciled by hand. There,
  -- an unlisted name aborts the whole migration. Three named, verified
  -- exceptions cost nothing and close that hole.
  --
  -- THE RULE FOR A NEW TABLE: give it `ENABLE ROW LEVEL SECURITY` in the
  -- migration that CREATES it (073 and 085 are the worked examples) and do NOT
  -- add it here. If Guard 2 ever trips on it, that is the guard working — audit
  -- the table and classify it, do not silence it.
  --
  -- Each of these locks itself in its own migration:
  --   doctor_applications    → 073_doctor_applications.sql:55
  --   payment_event_reviews  → 085_rls_payment_event_reviews_ops_push_log.sql
  --   ops_push_log           → 085_rls_payment_event_reviews_ops_push_log.sql
  -- CLOSED SET — do not extend.
  later_tables text[] := ARRAY[
    'doctor_applications','payment_event_reviews','ops_push_log'
  ];  -- 3 tables, created by 073 / 075 / 082, RLS-enabled by 073 and 085
  t text;
  missing  text[];
  surprise text[];
BEGIN
  -- Guard 1: every survivor we intend to lock must actually exist.
  SELECT array_agg(s) INTO missing
  FROM unnest(survivors) s
  WHERE to_regclass('public.'||s) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS abort: expected survivor table(s) missing: %', missing;
  END IF;

  -- Guard 2: drift check (the 067 lesson) — refuse if any public base table is
  -- outside (survivors ∪ orphans ∪ later_tables); a new/renamed table must be
  -- classified first.
  SELECT array_agg(c.relname) INTO surprise
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname <> ALL(survivors)
    AND c.relname <> ALL(orphans)
    AND c.relname <> ALL(later_tables);
  IF surprise IS NOT NULL THEN
    RAISE EXCEPTION 'RLS abort: unrecognized public table(s) present — re-audit before locking: %', surprise;
  END IF;

  -- Apply: default-deny RLS (no policy, no FORCE) on each survivor.
  FOREACH t IN ARRAY survivors LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;

  RAISE NOTICE 'RLS enabled (default-deny) on % survivor tables.', array_length(survivors, 1);
END $$;

-- Post-check (run separately):
--   SELECT count(*) FILTER (WHERE relrowsecurity)      AS rls_on,
--          count(*) FILTER (WHERE relforcerowsecurity) AS forced,
--          (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies
--   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relkind='r';
--   -- After 070 only: rls_on=58 (+3 orphans still off), forced=0, policies=0
--   -- After 070+071: rls_on=58, forced=0, policies=0  (orphans dropped)
