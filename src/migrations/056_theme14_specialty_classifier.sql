-- 056_theme14_specialty_classifier.sql
--
-- Theme 14 Sub-issue C — backend assignment + classifier audit.
--
-- Adds:
--   - orders.assignment_status         — routing-state machine (default 'auto').
--   - orders.no_sla_refund_eligibility — flag set on patient override of an AI
--                                        recommendation (Q4 locked). The
--                                        breach-refund machinery in
--                                        src/services/refund_eligibility.js
--                                        reads this and short-circuits
--                                        SLA-breach refund for these orders.
--   - specialty_classifications        — audit table written by Step 2 POST
--                                        on every classifier call (latest row
--                                        for a case is the active
--                                        recommendation; older rows preserve
--                                        the audit trail when patients bounce
--                                        back to Step 1/2 and re-classify).
--   - specialty_classification_overrides — audit table written by Step 3 POST
--                                          when the patient overrides the AI
--                                          recommendation. Side-by-side
--                                          AI-pick vs patient-pick row is the
--                                          gold-standard prompt-iteration
--                                          signal.
--
-- Both new tables are nullable-by-default; existing rows on orders pick up
-- assignment_status='auto' and no_sla_refund_eligibility=false on first read.
--
-- The schema includes columns the Phase 1 classifier doesn't yet populate
-- (alternates_json, model, prompt_hash, latency_ms). They are NULLable and
-- exist so that the post-launch prompt-iteration enhancement does not need
-- another migration when richer audit data is wanted. Phase 3 inserts the
-- minimum-required {specialty_id, confidence, reasoning, created_at}.
--
-- Indexes:
--   - idx_specialty_classifications_case keys the "latest row for case" query.
--   - idx_specialty_classification_overrides_case keys override lookups.
--   - idx_orders_assignment_status is a partial index on the manual-queue
--     bucket; superadmin manual-queue (Phase 5) reads on this predicate.

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS assignment_status TEXT DEFAULT 'auto';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS no_sla_refund_eligibility BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS specialty_classifications (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL,
  specialty_id    TEXT,
  confidence      DOUBLE PRECISION,
  reasoning       TEXT,
  alternates_json JSONB,
  model           TEXT,
  prompt_hash     TEXT,
  latency_ms      INTEGER,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_specialty_classifications_case
  ON specialty_classifications(case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS specialty_classification_overrides (
  id                    TEXT PRIMARY KEY,
  case_id               TEXT NOT NULL,
  ai_specialty_id       TEXT,
  ai_confidence         DOUBLE PRECISION,
  patient_specialty_id  TEXT NOT NULL,
  override_at           TIMESTAMP DEFAULT NOW(),
  override_reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_specialty_classification_overrides_case
  ON specialty_classification_overrides(case_id);

CREATE INDEX IF NOT EXISTS idx_orders_assignment_status
  ON orders(assignment_status)
  WHERE assignment_status = 'manual_pending';

COMMIT;
