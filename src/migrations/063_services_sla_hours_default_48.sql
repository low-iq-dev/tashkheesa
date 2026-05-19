-- 063_services_sla_hours_default_48.sql
--
-- Closes the residual SLA drift from #86 by flipping services.sla_hours
-- column DEFAULT from 72 → 48 and updating the 13 rows that still carry
-- the old 72h value. Migration 036 fixed the data once but left the
-- column DEFAULT at 72, so any service inserted without an explicit
-- sla_hours reverted to the old standard (e.g. lab panels seeded after
-- 036, and 5 visible specialty consultations).
--
-- Aligns with the launch-reality copy locked in #85: "48h standard ·
-- 4h urgent". User-facing marketing/policy copy still using "72 hours"
-- (blog posts, terms, delivery_policy, refund_policy, marketing metas)
-- is deferred to #88 per the comment block in patient_dashboard.ejs.
--
-- Affected rows (sla_hours = 72) at audit time:
--   7 lab panels: lab_panel_autoimmune, lab_panel_coag_electrolytes,
--     lab_panel_hormones, lab_panel_microbiology, lab_panel_routine_bloods,
--     lab_panel_tumor_markers, lab_panel_urine_stool
--   5 visible specialty consultations: svc-cardiothoracic-consultation,
--     svc-clinical-nutrition-consultation, svc-emergency-medicine-consultation,
--     svc-rheumatology-consultation, svc-vascular-surgery-consultation
--   1 hidden: svc-psychiatry-consultation (fixed for consistency)
--
-- This migration does NOT touch:
--   - orders.sla_hours snapshots (legacy orders preserve their purchased SLA)
--   - the 'standard_72h' sla_type enum string in cases.sla_type (separate
--     concern — enum value rename needs its own migration + consumer updates)
--   - case_lifecycle SLA_HOURS payment-tier constants
--
-- Idempotent: re-running is a no-op once values are aligned.
--
-- Rollback (manual, if ever needed):
--   ALTER TABLE services ALTER COLUMN sla_hours SET DEFAULT 72;
--   UPDATE services s
--      SET sla_hours = b.original_sla_hours
--     FROM services_sla_hours_migration_063_backup b
--    WHERE s.id = b.service_id;

BEGIN;

-- Backup affected rows for reversibility.
CREATE TABLE IF NOT EXISTS services_sla_hours_migration_063_backup (
  service_id          TEXT PRIMARY KEY,
  original_sla_hours  INTEGER NOT NULL,
  backed_up_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO services_sla_hours_migration_063_backup
  (service_id, original_sla_hours)
SELECT id, sla_hours
  FROM services
 WHERE sla_hours = 72
    ON CONFLICT (service_id) DO NOTHING;

-- Flip column default so new services inherit the correct standard SLA.
ALTER TABLE services ALTER COLUMN sla_hours SET DEFAULT 48;

-- Align the 13 drifted rows.
UPDATE services
   SET sla_hours = 48
 WHERE sla_hours = 72;

COMMIT;
