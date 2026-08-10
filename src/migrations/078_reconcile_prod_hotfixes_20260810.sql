-- 078_reconcile_prod_hotfixes_20260810.sql
-- ============================================================================
-- Reconcile the repo against 6 migrations applied DIRECTLY to prod via Supabase
-- MCP on 2026-08-10 (all present in supabase_migrations.schema_migrations, none
-- previously in the repo). This file codifies ONLY the SCHEMA changes so a
-- fresh / local `migrate()` produces a DB matching prod. Prod is the source of
-- truth; every statement here is idempotent and is a 0-change no-op on prod.
--
-- The 4 DATA migrations below are recorded BY REFERENCE ONLY — NOT replayed.
-- Rationale (design §4.8 / §11): they embed 16 doctors' emails / phones /
-- licence numbers (PDPL — must not enter permanent git history), and re-running
-- data INSERTs on every fresh boot is an unnecessary footgun. Prod already has
-- them; a fresh local DB gets its data from the SYNTHETIC dev seed
-- (scripts/dev/seed_my_services_fixtures.js), never from here.
--
--   applied to prod via MCP 2026-08-10, NOT replayed — prod is source of truth:
--     20260810093051  map_active_doctors_to_own_specialty_services
--                     — INSERT … NOT EXISTS: map each active doctor to every
--                       visible service in their own specialty.
--     20260810093745  promote_16_applicants_to_active_doctors  (PII)
--                     — promote 16 vetted applicants to active doctor users.
--                       (prod copy is a bare INSERT … VALUES with NO ON CONFLICT;
--                       intentionally NOT replayed — no PII in git.)
--     20260810093756  map_new_doctors_to_services_and_close_applications
--                     — map the 16 new doctors to services; close their apps.
--     20260810093816  close_jamaleddin_duplicate_applications
--                     — mark one applicant's duplicate applications closed.
--
-- The SCHEMA changes reconciled below (safe to replay everywhere):
--   20260810094405  enable_rls_on_pricing_backup_tables  (RLS)
--   20260810094458  add_coming_soon_flag_to_services      (column+comment+index+resync)
-- ============================================================================

-- ── 20260810094458 add_coming_soon_flag_to_services (verbatim from prod) ─────
-- Services stay visible in the catalogue but render as "Coming Soon" and
-- non-bookable until at least one active doctor is mapped to them.
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS coming_soon boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.services.coming_soon IS
  'True when no active doctor is mapped to this service. UI must show a Coming Soon badge and disable booking. Re-sync after any doctor_services change.';

UPDATE public.services sv
SET coming_soon = NOT EXISTS (
  SELECT 1 FROM public.doctor_services ds
  JOIN public.users u ON u.id = ds.doctor_id
  WHERE ds.service_id = sv.id AND u.role = 'doctor' AND u.is_active = true
);

CREATE INDEX IF NOT EXISTS idx_services_coming_soon ON public.services (coming_soon) WHERE is_visible;

-- ── 20260810094405 enable_rls_on_pricing_backup_tables ──────────────────────
-- Default-deny RLS on the two 2026-07-29 pricing backup tables so they match
-- the 070/071/072 lockdown posture. Each guarded on the table existing — a
-- fresh/local DB never created these backups, so skip cleanly (070 pattern).
DO $$
BEGIN
  IF to_regclass('public._bak_services_20260729') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public._bak_services_20260729 ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public._bak_srp_20260729') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public._bak_srp_20260729 ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
