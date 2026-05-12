-- 054_doctor_earnings_clawback.sql
--
-- Side issue #43 — Doctor earnings clawback policy follow-up to
-- Theme 7b refund workflow. Two audit columns on doctor_earnings so the
-- new recomputeOnRefund(orderId, {reason}) hook can:
--   (a) record which clawback policy fired (sla_breach_full_clawback,
--       patient_or_operator_post_acceptance_90pct_clawback, etc.) so
--       the doctor-facing earnings UI can explain "your payout on this
--       case was reduced because of a refund."
--   (b) enforce idempotency — if clawback_applied_at IS NOT NULL the
--       recompute path skips (a refund mark-paid double-click can't
--       double-claw).
--
-- Both columns nullable: existing rows (pre-#43) keep NULL for both,
-- which the lookup interprets as "no clawback yet applied to this row."
-- No backfill needed.
--
-- routes/superadmin.js mark-paid handler at line 3479 (the
-- "deferred to a follow-up theme" comment block) is replaced by a call
-- to recomputeOnRefund in the same commit as this migration.

BEGIN;

ALTER TABLE doctor_earnings
  ADD COLUMN IF NOT EXISTS clawback_reason     TEXT,
  ADD COLUMN IF NOT EXISTS clawback_applied_at TIMESTAMP;

COMMIT;
