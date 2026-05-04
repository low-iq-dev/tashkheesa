-- 041_addon_specialty_and_services_fk.sql
--
-- P3-DATA-1: services.specialty_id orphan cleanup + referential integrity.
--
-- Background:
--   The catalog has 269 services. As of investigation, two of them
--   (`addon_prescription`, `addon_priority_24hr`) carry specialty_id='addon',
--   but no specialties row with id='addon' exists. They were added after
--   migration 018's specialty dedup without a backing specialty record.
--   Both rows are is_visible=false, so they don't surface to patients,
--   but they break LEFT JOINs and pollute integrity audits.
--
-- Two-step fix:
--   1. INSERT a hidden 'addon' specialty so the existing rows reconcile.
--      `is_visible=false` keeps it out of public listings (specialties
--      index, /specialties/[id] pages). The row exists purely to anchor
--      cross-specialty add-on services (prescription, priority review,
--      future video-consult upgrade).
--
--   2. ADD FOREIGN KEY services.specialty_id → specialties.id so future
--      orphans are rejected at write time. Postgres CHECK constraints
--      cannot reference other tables; FK is the right primitive.
--      ON UPDATE CASCADE so a specialty rename propagates; ON DELETE
--      RESTRICT so we can't accidentally drop a specialty that still has
--      services attached.
--
--   Pre-flight: a DO $$ block re-checks for orphans inside this migration's
--   transaction. If any non-'addon' orphan slipped in between investigation
--   and migration run, the FK ALTER would fail mid-transaction with a
--   confusing "violates foreign key constraint" error. Failing early with
--   a named exception is clearer for ops triage.
--
-- Idempotent: INSERT uses ON CONFLICT, FK ADD uses pg_constraint guard.
-- Safe to re-run.

-- ── Step 1: insert hidden 'addon' specialty ──────────────────────────────
INSERT INTO specialties (id, name, name_ar, is_visible, description, description_ar)
VALUES (
  'addon',
  'Add-on Services',
  'خدمات إضافية',
  false,
  'Cross-specialty add-on services (prescriptions, priority review, etc.). Not surfaced as a public specialty.',
  'خدمات إضافية متعددة التخصصات (وصفات طبية، مراجعة عاجلة، إلخ). لا تظهر كتخصص عام.'
)
ON CONFLICT (id) DO NOTHING;

-- ── Step 2: pre-flight check for any remaining orphans ───────────────────
DO $$
DECLARE
  orphan_count int;
  orphan_sample text;
BEGIN
  SELECT COUNT(*), STRING_AGG(s.id || ' (specialty_id=' || COALESCE(s.specialty_id, 'NULL') || ')', ', ')
    INTO orphan_count, orphan_sample
  FROM services s
  WHERE NOT EXISTS (SELECT 1 FROM specialties sp WHERE sp.id = s.specialty_id);

  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'P3-DATA-1 migration aborted: % orphan service(s) still exist after addon specialty insert. Sample: %. Investigate before applying FK constraint.',
      orphan_count, orphan_sample;
  END IF;
END $$;

-- ── Step 3: add foreign key constraint (idempotent) ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_services_specialty'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT fk_services_specialty
      FOREIGN KEY (specialty_id) REFERENCES specialties(id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END $$;
