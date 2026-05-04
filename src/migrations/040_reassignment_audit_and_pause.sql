-- 040_reassignment_audit_and_pause.sql
--
-- P1-FIN-2: SLA-breach reassignment earnings + audit trail + auto-pause.
--
-- Three column groups:
--
--   1. orders audit fields — captures who-replaced-who and why on
--      each reassignment. Lets admins reconcile end-of-month and
--      gives the doctor-side earnings view a way to display "this
--      case was reassigned to / from".
--
--   2. users pause fields — `is_paused` is the new "active but
--      excluded from open-pool broadcasts" state. Distinct from
--      `is_active` (which gates login entirely). Auto-set when a
--      doctor breaches SLA_AUTO_PAUSE_BREACHES times within
--      SLA_AUTO_PAUSE_WINDOW_DAYS days. Defaults: 3 in 30 days
--      (env-overridable).
--
--   3. doctor_earnings linkage + reason — the partial-pay row
--      (status='reassigned', earned_amount = 10% baseShare) links
--      to its replacement row (status='pending' under the new
--      doctor) for end-of-month reconciliation. The reason column
--      duplicates orders.reassignment_reason for read-time efficiency
--      so admin earnings dashboards don't have to JOIN to orders.
--
-- Index added on doctor_earnings(doctor_id, status, created_at DESC)
-- powers the auto-pause check: count reassigned rows per doctor in
-- the last N days. Without it, the check is a sequential scan.
--
-- Env vars consumed by application code (NOT by this migration):
--   SLA_AUTO_PAUSE_BREACHES=3        — threshold count
--   SLA_AUTO_PAUSE_WINDOW_DAYS=30    — lookback window (set 0 to disable)
--
-- Idempotent: every column add is guarded; index uses IF NOT EXISTS.
-- Safe to re-run.

DO $$
BEGIN
  -- orders.reassigned_to_doctor_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'reassigned_to_doctor_id'
  ) THEN
    ALTER TABLE orders ADD COLUMN reassigned_to_doctor_id TEXT;
  END IF;

  -- orders.reassigned_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'reassigned_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN reassigned_at TIMESTAMP;
  END IF;

  -- orders.reassignment_reason
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'reassignment_reason'
  ) THEN
    ALTER TABLE orders ADD COLUMN reassignment_reason TEXT;
  END IF;

  -- users.is_paused
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_paused'
  ) THEN
    ALTER TABLE users ADD COLUMN is_paused BOOLEAN DEFAULT false;
  END IF;

  -- users.paused_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'paused_at'
  ) THEN
    ALTER TABLE users ADD COLUMN paused_at TIMESTAMP;
  END IF;

  -- users.pause_reason
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'pause_reason'
  ) THEN
    ALTER TABLE users ADD COLUMN pause_reason TEXT;
  END IF;

  -- doctor_earnings.reassigned_to_earning_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'doctor_earnings' AND column_name = 'reassigned_to_earning_id'
  ) THEN
    ALTER TABLE doctor_earnings ADD COLUMN reassigned_to_earning_id TEXT;
  END IF;

  -- doctor_earnings.reassignment_reason
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'doctor_earnings' AND column_name = 'reassignment_reason'
  ) THEN
    ALTER TABLE doctor_earnings ADD COLUMN reassignment_reason TEXT;
  END IF;
END $$;

-- Index for auto-pause lookups: SELECT COUNT(*) FROM doctor_earnings
--   WHERE doctor_id = $1 AND status = 'reassigned' AND created_at >= NOW() - INTERVAL '$N days'
CREATE INDEX IF NOT EXISTS idx_doctor_earnings_doctor_status_created
  ON doctor_earnings (doctor_id, status, created_at DESC);
