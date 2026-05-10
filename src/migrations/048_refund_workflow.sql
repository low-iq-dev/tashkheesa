-- 048: extend refunds table with patient-initiated workflow columns.
--
-- Theme 7b Phase 1 (2026-05-10).
--
-- Background:
--   Migration 028 created `refunds` as an append-only ledger written
--   exclusively by services/sla_breach.issueBreachRefund (system-
--   generated SLA-breach payouts). It has no `status` column, no
--   instapay_handle, no requested-vs-approved amount split. The
--   patient-initiated refund flow (Theme 7b) needs a workflow with
--   states pending → auto_approved → approved → paid (and a terminal
--   denied state). Per Ziad's OQ-1 answer we extend the existing
--   table in-place rather than create a parallel `refund_requests`
--   table — single source of truth, simpler queries, preserves the
--   existing `WHERE order_id=$1 AND reason='sla_breach'` idempotency
--   guard at services/sla_breach.js:56-62 (which only reads columns
--   that already exist).
--
-- Backfill semantics:
--   Existing rows were all written by issueBreachRefund: one per SLA
--   breach, refunded_by='system', paymob_refund_id=NULL, the urgency
--   uplift was zeroed on the order at the same time. Treat them as
--   `status='paid'` because the system has, by its own definition,
--   completed the refund the moment the row was written. Backfill:
--     paid_at = refunded_at (UTC-cast to TIMESTAMPTZ — see (b))
--     approved_amount = amount_egp
--     requested_amount = amount_egp (system has no separate request)
--     reviewed_at = refunded_at, reviewed_by = COALESCE(refunded_by, 'system')
--
-- Status enum:
--   Per Ziad's Phase 1 brief: 'pending' | 'auto_approved' | 'approved'
--   | 'paid' | 'denied'. Enforced at the application layer (in the
--   eligibility helper + route validators), NOT via a CHECK constraint
--   for v1. (CHECK can be added later in a follow-up migration once
--   the value set is fully stable.)
--
-- Type choices (deviations from Ziad's brief, surfaced in §8 OQ
-- review and applied here for codebase consistency):
--   1. requested_by, reviewed_by are TEXT (not UUID). users.id is
--      TEXT throughout the codebase (verified against production
--      schema 2026-05-10); declaring these as UUID would break the
--      existing pattern + require a cast at every read site.
--   2. amount columns are NUMERIC(10,2) (not INTEGER cents). Matches
--      the existing refunds.amount_egp + orders.urgency_uplift_amount
--      + services.base_price columns. Per OQ-9 confirmation.
--   3. New TIMESTAMPTZ columns (reviewed_at, paid_at) — matches the
--      modern convention used by migration 022 (deleted_at TIMESTAMPTZ)
--      and 047 (sla_paused_at TIMESTAMPTZ). The existing refunded_at
--      column stays as TIMESTAMP-without-TZ; the backfill below
--      explicitly casts via AT TIME ZONE 'UTC' to avoid timezone
--      drift on non-UTC Postgres servers (defensive — prod runs UTC).
--
-- Idempotency:
--   - Every column add uses ADD COLUMN IF NOT EXISTS.
--   - The backfill UPDATE uses WHERE status IS NULL so re-runs after
--     the first apply are no-ops (status was set NOT NULL after the
--     first run; subsequent ADD COLUMN IF NOT EXISTS sees the column
--     exists and skips; the UPDATE matches zero rows).
--   - The NOT NULL + DEFAULT change is also idempotent (re-applying
--     the same constraint is a no-op).
--
-- Rollback (manual, if patient rows exist):
--   The patient-initiated rows have status values not present in the
--   pre-Theme-7b schema. To roll back the migration *after* patient
--   rows exist, you must first DELETE FROM refunds WHERE
--   reason='patient_request', then ALTER TABLE refunds DROP COLUMN ...
--   for each added column. Before any patient flow lands (Phase 2),
--   rollback is zero-risk — the columns are nullable additions and
--   only system rows exist.

BEGIN;

-- (a) Add workflow columns. Initially nullable so the backfill below
-- can set status=null=>'paid' on existing rows before the NOT NULL
-- constraint fires.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS status              TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS requested_amount    NUMERIC(10,2);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS approved_amount     NUMERIC(10,2);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS instapay_handle     TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS instapay_reference  TEXT;
-- paymob_refund_id already exists from migration 028; this is a no-op
-- but kept here for symmetry with the brief and future-reader clarity.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paymob_refund_id    TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS denial_reason       TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS patient_reason      TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS requested_by        TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS reviewed_by         TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS reviewed_at         TIMESTAMPTZ;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paid_at             TIMESTAMPTZ;

-- (b) Backfill existing rows. AT TIME ZONE 'UTC' is defensive against
-- a non-UTC Postgres server (production runs UTC; local dev may not).
-- WHERE status IS NULL makes this re-runnable.
UPDATE refunds
   SET status            = 'paid',
       paid_at           = refunded_at AT TIME ZONE 'UTC',
       reviewed_at       = refunded_at AT TIME ZONE 'UTC',
       reviewed_by       = COALESCE(refunded_by, 'system'),
       approved_amount   = amount_egp,
       requested_amount  = amount_egp
 WHERE status IS NULL;

-- (c) Lock the status column NOT NULL after backfill so future inserts
-- must specify a value (the patient route + sla_breach writer both
-- explicitly set status). DEFAULT 'pending' covers any caller that
-- forgets — the safe-by-default state for an unattributed row is
-- "needs review", not "already paid".
ALTER TABLE refunds ALTER COLUMN status SET NOT NULL;
ALTER TABLE refunds ALTER COLUMN status SET DEFAULT 'pending';

-- (d) Indexes for the superadmin queue (filter by status), per-patient
-- lookups (refund history), and the partial-unique that prevents two
-- pending requests on the same case.
CREATE INDEX IF NOT EXISTS idx_refunds_status            ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_requested_by      ON refunds(requested_by);
CREATE INDEX IF NOT EXISTS idx_refunds_status_created    ON refunds(status, refunded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_refunds_pending_per_order
    ON refunds(order_id) WHERE status IN ('pending', 'auto_approved');

COMMIT;
