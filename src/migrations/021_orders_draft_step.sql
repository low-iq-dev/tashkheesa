-- Migration 021: Add orders.draft_step for the v2 5-step wizard.
--
-- Tracks the highest step the patient has completed in the new-case wizard.
-- Semantics:
--   0 = none (or non-wizard order)
--   1 = Condition done
--   2 = Documents done
--   3 = Specialty + service done
--   4 = Review confirmed (transitional, paid not yet through)
--   5 = Payment complete (terminal — paired with status >= 'SUBMITTED')
--
-- Replaces the field-presence inference used in Phase 3A. Inference remains
-- in routes/patient.js as a defense-in-depth fallback for rows the backfill
-- below somehow missed (would log a warning if it ever fires post-backfill).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS draft_step SMALLINT DEFAULT 0;

-- One-time backfill: derive draft_step from existing field presence for any
-- row that's still at the default 0. Idempotent — re-running this migration
-- (or the equivalent fixup) won't move any row backwards.
UPDATE orders o
SET draft_step = CASE
    WHEN LOWER(COALESCE(o.payment_status, '')) = 'paid' THEN 5
    WHEN COALESCE(NULLIF(TRIM(o.clinical_question), ''), NULL) IS NOT NULL
         AND o.specialty_id IS NOT NULL
         AND o.service_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM order_files of WHERE of.order_id = o.id)
      THEN 3
    WHEN COALESCE(NULLIF(TRIM(o.clinical_question), ''), NULL) IS NOT NULL
         AND EXISTS (SELECT 1 FROM order_files of WHERE of.order_id = o.id)
      THEN 2
    WHEN COALESCE(NULLIF(TRIM(o.clinical_question), ''), NULL) IS NOT NULL
      THEN 1
    ELSE 0
  END
WHERE COALESCE(o.draft_step, 0) = 0;

-- Index DRAFT-status rows by step for the wizard's resume queries.
CREATE INDEX IF NOT EXISTS idx_orders_patient_draft_step
  ON orders (patient_id, draft_step)
  WHERE UPPER(COALESCE(status, '')) = 'DRAFT';
