-- 061_seed_classifier_thresholds.sql
--
-- Theme 14 Phase 4 — make the three classifier confidence thresholds
-- live-tunable from the superadmin UI without a deploy. Seeds three
-- rows into the existing `admin_settings` table (key/value/updated_by/
-- updated_at, key is PK — schema unchanged since migration that added
-- it). Helper module `src/services/admin_settings.js` (Phase 4 piece 2)
-- reads these keys with a 60s TTL cache + silent fallback to the same
-- defaults seeded here.
--
-- Key naming aligns with the canonical reference already present in
-- `src/services/specialty_classifier.js:25` ("confidence <
-- classifier_threshold_minimum → operator triage"). Three keys:
--
--   * classifier_threshold_locked   = '0.95'  — at/above this, the
--                                              wizard hides the override
--                                              link entirely and the
--                                              POST handler rejects any
--                                              mismatching submission as
--                                              `override_not_permitted`.
--   * classifier_threshold_auto     = '0.85'  — at/above this (and
--                                              below locked), the
--                                              recommendation card is
--                                              shown with an override
--                                              link behind an SLA-
--                                              disclaimer modal.
--   * classifier_threshold_minimum  = '0.55'  — below this, the wizard
--                                              falls back to the supply-
--                                              blind grid ("manual"
--                                              tier).
--
-- Value type: TEXT (per the existing column type). Helper module parses
-- to Number with finite + [0,1] guard. The single existing row in this
-- table (`auto_assign_enabled = 'false'`, seeded ad-hoc 2026-03-23) is
-- untouched.
--
-- Idempotency: ON CONFLICT (key) DO NOTHING — re-running this migration
-- never trams a superadmin's tuned value with the seed default. Once a
-- row exists, only the superadmin UI changes it.
--
-- Post-condition guard: all three keys present after the INSERT (3 rows
-- + the pre-existing auto_assign_enabled = 4 rows total). Failure rolls
-- back the txn so the schema_migrations row never lands.

BEGIN;

INSERT INTO admin_settings (key, value, updated_by, updated_at) VALUES
  ('classifier_threshold_locked',  '0.95', NULL, NOW()),
  ('classifier_threshold_auto',    '0.85', NULL, NOW()),
  ('classifier_threshold_minimum', '0.55', NULL, NOW())
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  threshold_count INT;
BEGIN
  SELECT COUNT(*) INTO threshold_count
    FROM admin_settings
   WHERE key IN (
     'classifier_threshold_locked',
     'classifier_threshold_auto',
     'classifier_threshold_minimum'
   );
  IF threshold_count != 3 THEN
    RAISE EXCEPTION 'Migration 061 post-condition failed: expected 3 threshold rows, got %', threshold_count;
  END IF;
END $$;

COMMIT;
