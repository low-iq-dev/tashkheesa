-- 018_dedupe_specialties.sql
--
-- The `specialties` table shipped with two parallel ID conventions: a legacy
-- bare-name set (`cardiology`, `oncology`, `neurology`, `radiology`) and the
-- canonical `spec-<slug>` set (`spec-cardiology`, etc.). That produced four
-- duplicate-by-name rows which the profile specialty dropdown surfaced to
-- doctors as repeated options. There was also a stand-alone `spec-pathology`
-- row distinct from `lab_pathology` (Lab & Pathology); the pricing sheet
-- treats pathology as part of Lab & Pathology, so the two must collapse.
--
-- This migration:
--   1. Drops duplicate services that would collide with the keeper when
--      re-pointed (the services table has UNIQUE (specialty_id, name)
--      from migration 011).
--   2. Re-points every surviving specialty_id reference (in orders,
--      appointments, services) from the obsolete id to its keeper id.
--   3. Deletes the five duplicate specialty rows.
--   4. Adds UNIQUE (name) on specialties so the drift cannot recur.
--
-- Idempotent: all writes are WHERE-gated; the UNIQUE constraint is added
-- only if it does not already exist. Safe to run multiple times.
--
-- The backup table `services_backup_2026_04_22` is intentionally left alone
-- — it is a frozen snapshot from the 2026-04-22 services dedupe and must
-- not be rewritten.

BEGIN;

-- ---- 1. Drop colliding bare-variant services ---------------------------
--
-- services has a UNIQUE (specialty_id, name) constraint (migration 011).
-- When we repoint a bare-variant row to its spec-* counterpart, the
-- constraint fires if a service with the same (spec-*, name) pair already
-- exists. Resolve by deleting the bare-variant rows whose names already
-- exist under the keeper specialty — the spec-* version is authoritative
-- (it was assigned to the 2 doctors that have specialty_id set, and is the
-- one the pricing pipeline uses). Any bare-variant service without a
-- same-name spec-* sibling is preserved and re-pointed below.

DELETE FROM services s
 WHERE s.specialty_id IN ('cardiology','oncology','neurology','radiology')
   AND EXISTS (
         SELECT 1 FROM services k
          WHERE k.specialty_id = 'spec-' || s.specialty_id
            AND k.name = s.name
       );

DELETE FROM services s
 WHERE s.specialty_id = 'spec-pathology'
   AND EXISTS (
         SELECT 1 FROM services k
          WHERE k.specialty_id = 'lab_pathology'
            AND k.name = s.name
       );

-- ---- 2. Repoint surviving references -----------------------------------

-- bare-name → spec-<slug>
UPDATE orders       SET specialty_id = 'spec-cardiology' WHERE specialty_id = 'cardiology';
UPDATE orders       SET specialty_id = 'spec-oncology'   WHERE specialty_id = 'oncology';
UPDATE orders       SET specialty_id = 'spec-neurology'  WHERE specialty_id = 'neurology';
UPDATE orders       SET specialty_id = 'spec-radiology'  WHERE specialty_id = 'radiology';

UPDATE appointments SET specialty_id = 'spec-cardiology' WHERE specialty_id = 'cardiology';
UPDATE appointments SET specialty_id = 'spec-oncology'   WHERE specialty_id = 'oncology';
UPDATE appointments SET specialty_id = 'spec-neurology'  WHERE specialty_id = 'neurology';
UPDATE appointments SET specialty_id = 'spec-radiology'  WHERE specialty_id = 'radiology';

UPDATE services     SET specialty_id = 'spec-cardiology' WHERE specialty_id = 'cardiology';
UPDATE services     SET specialty_id = 'spec-oncology'   WHERE specialty_id = 'oncology';
UPDATE services     SET specialty_id = 'spec-neurology'  WHERE specialty_id = 'neurology';
UPDATE services     SET specialty_id = 'spec-radiology'  WHERE specialty_id = 'radiology';

-- spec-pathology → lab_pathology (Lab & Pathology is the pricing-file canon)
UPDATE orders       SET specialty_id = 'lab_pathology' WHERE specialty_id = 'spec-pathology';
UPDATE appointments SET specialty_id = 'lab_pathology' WHERE specialty_id = 'spec-pathology';
UPDATE services     SET specialty_id = 'lab_pathology' WHERE specialty_id = 'spec-pathology';

-- ---- 3. Drop the five obsolete rows ------------------------------------

DELETE FROM specialties WHERE id IN (
  'cardiology',
  'oncology',
  'neurology',
  'radiology',
  'spec-pathology'
);

-- ---- 4. Prevent future name-based drift --------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'specialties'::regclass
      AND conname  = 'specialties_name_unique'
  ) THEN
    ALTER TABLE specialties
      ADD CONSTRAINT specialties_name_unique UNIQUE (name);
  END IF;
END
$$;

COMMIT;
