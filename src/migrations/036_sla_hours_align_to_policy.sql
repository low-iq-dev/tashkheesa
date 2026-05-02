-- 036_sla_hours_align_to_policy.sql
--
-- Aligns services.sla_hours to docs/PAYOUT_AND_URGENCY_POLICY.md §2 + §9:
--
--   Standard tier:        72h → 48h   (policy §9 line 205)
--   VIP / fast_track:     24h → 18h   (policy §9 line 206)
--   Urgent:               4h          (no change — already correct)
--
-- The pre-launch audit flagged this as P1-DATA-1: prod was uniformly 72h
-- as of 2026-04-30 — every service shipped with the wrong base SLA. The
-- April-29 plan included "update existing SLA hours: Standard 72h → 48h"
-- but the migration never landed.
--
-- Patient impact: patients are currently promised a 72h turnaround they
-- could be promised at 48h; doctors are held to 72h instead of being
-- held to the 48h policy. Patient/doctor-favorable but mis-represents
-- the policy.
--
-- This migration ONLY touches services.sla_hours. It does NOT touch:
--   - case_lifecycle.SLA_HOURS constants (those are payment-tier-keyed,
--     not per-service base SLAs — different concern)
--   - patient.js wizard fallback logic (P1-PATIENT-1's territory)
--   - existing orders.sla_hours rows (those are snapshots-at-purchase
--     and must not retroactively change for legacy orders)
--
-- Idempotent: re-running this migration after the values land is a
-- no-op. The WHERE clauses select rows whose values haven't been
-- aligned yet.

BEGIN;

-- Standard tier: 72h → 48h
UPDATE services
   SET sla_hours = 48
 WHERE sla_hours = 72;

-- VIP / fast_track tier: 24h → 18h
UPDATE services
   SET sla_hours = 18
 WHERE sla_hours = 24;

COMMIT;
