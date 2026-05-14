-- 058_theme14_classifier_service_id.sql
--
-- Theme 14 Phase 3 polish — classifier now recommends BOTH a specialty AND
-- a service. Three additive nullable columns to capture the new dimension
-- on the audit tables created by migration 056.
--
-- Schema additions:
--   - specialty_classifications.service_id       — the service_id the
--                                                  classifier picked (NULL
--                                                  on ambiguous-case path,
--                                                  same semantics as
--                                                  specialty_id today).
--   - specialty_classification_overrides.ai_service_id      — the AI's
--                                                              service pick
--                                                              at the moment
--                                                              the override
--                                                              fired.
--   - specialty_classification_overrides.patient_service_id — the patient's
--                                                              final service
--                                                              choice (may
--                                                              equal AI's
--                                                              pick if the
--                                                              override
--                                                              changed only
--                                                              the specialty).
--
-- All three NULLable so existing rows from migration 056-era inserts (the
-- audit tables were empty at 058 ship time, so no historical data drift)
-- remain valid. IF NOT EXISTS guards on every ADD COLUMN — re-runs are no-ops.
--
-- Companion to migration 057 (specialty catalog cleanup) — 057 made the
-- specialty enum consistent at 21 visible specialties all with priced
-- services; 058 lets the classifier name a specific service within the
-- chosen specialty.

BEGIN;

ALTER TABLE specialty_classifications
  ADD COLUMN IF NOT EXISTS service_id TEXT;

ALTER TABLE specialty_classification_overrides
  ADD COLUMN IF NOT EXISTS ai_service_id      TEXT;

ALTER TABLE specialty_classification_overrides
  ADD COLUMN IF NOT EXISTS patient_service_id TEXT;

COMMIT;
