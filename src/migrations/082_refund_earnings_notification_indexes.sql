-- 082_refund_earnings_notification_indexes.sql
--
-- AUDIT-P0 (audit 2026-08-16, second pass). Three uniqueness constraints that
-- the application layer assumes and the schema does not enforce. Each one is
-- paired with a code change landing in the same series; the code is written to
-- be correct both before and after this migration, so ordering is not fatal —
-- but each fix is only complete once this runs.
--
-- Idempotent throughout. No data is modified. Every statement is guarded, and
-- the two DROPs target indexes this migration then replaces.

BEGIN;

-- ---------------------------------------------------------------------------
-- (a) refunds: a paid refund freed the uniqueness slot, so a patient could be
--     refunded twice for the same payment.
--
-- 048 created uniq_refunds_pending_per_order over ('pending','auto_approved').
-- Once an operator marked a refund 'paid' the row left that predicate, the
-- index no longer blocked anything, and — because mark-paid never touched
-- orders.payment_status — refund_eligibility still returned {eligible:true}.
-- A second full-value refund inserted cleanly and landed in the operator's
-- "awaiting payment" queue indistinguishable from a first request.
--
-- The application-side guard (patient.js POST, widened to the same four
-- statuses) is the primary defence; this is the backstop that makes a race
-- between two concurrent POSTs impossible.
--
-- 'denied' and 'cancelled' are deliberately excluded: a denied request must be
-- re-submittable.
DROP INDEX IF EXISTS uniq_refunds_pending_per_order;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_refunds_open_per_order
    ON refunds(order_id)
    WHERE status IN ('pending', 'auto_approved', 'approved', 'paid');

-- ---------------------------------------------------------------------------
-- (b) doctor_earnings: POST /api/video/end/:appointmentId inserted a row with
--     a fresh randomUUID() on every call, with no from-state predicate and no
--     payment check, so N calls produced N pending payout rows against one
--     appointment that may never have been paid for.
--
-- The index MUST be partial. markPartialPayOnReassignment (earnings_writer.js)
-- legitimately writes a second row for the same appointment_id — the main
-- 'earn-main-%' row and the 'earn-reassign-%' row that splits it when a case
-- moves between doctors. Those two id spaces key on the ORDER id; video rows
-- key on the APPOINTMENT id, so they never collide with each other. A total
-- unique index here would start raising 23505 on every SLA reassignment.
--
-- The application insert uses an UNTARGETED `ON CONFLICT DO NOTHING`, which is
-- correct against either a partial or a total index — a targeted clause cannot
-- infer a partial index and would raise at runtime.
--
-- Pre-existing duplicates: this migration does not delete them, because
-- deciding which of two payout rows is real is an accounting judgement, not a
-- schema one. If CREATE UNIQUE fails, run the diagnostic in the DO block below
-- and reconcile before retrying.
DO $$
DECLARE
    dupe_count integer;
BEGIN
    SELECT COUNT(*) INTO dupe_count
    FROM (
        SELECT appointment_id
        FROM doctor_earnings
        WHERE appointment_id IS NOT NULL
          AND id NOT LIKE 'earn-main-%'
          AND id NOT LIKE 'earn-reassign-%'
        GROUP BY appointment_id
        HAVING COUNT(*) > 1
    ) d;

    IF dupe_count > 0 THEN
        RAISE EXCEPTION
            'Migration 082 aborted: % appointment_id value(s) already have duplicate video doctor_earnings rows. These are the payout rows the unguarded /api/video/end endpoint created. Reconcile them before retrying: SELECT appointment_id, count(*), sum(earned_amount) FROM doctor_earnings WHERE appointment_id IS NOT NULL AND id NOT LIKE ''earn-main-%%'' AND id NOT LIKE ''earn-reassign-%%'' GROUP BY 1 HAVING count(*) > 1;',
            dupe_count;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_doctor_earnings_appointment_video
    ON doctor_earnings(appointment_id)
    WHERE appointment_id IS NOT NULL
      AND id NOT LIKE 'earn-main-%'
      AND id NOT LIKE 'earn-reassign-%';

-- ---------------------------------------------------------------------------
-- (c) notifications: the dedupe index was single-column while every reader and
--     comment in notify.js assumed three.
--
-- 003 created idx_notifications_dedupe_key UNIQUE (dedupe_key). But
-- notify.queueNotification pre-checks (dedupe_key, channel, to_user_id), and
-- the comments at notify.js:508 and routes/patient.js:2879 both assert a
-- three-column index. Live call sites happen to suffix the channel or the
-- recipient id into the key, which is the only reason this has not bitten yet:
-- any new caller reusing one key across two channels passes the pre-check,
-- violates the index, and has its second channel silently dropped into
-- db_insert_failed.
--
-- Widening it also unblocks the notify.js change that lets a 'failed' row be
-- re-queued for the same event — with the single-column index that INSERT
-- raises 23505 and the retry is swallowed.
--
-- Safe to widen: a unique constraint on a superset of columns is strictly
-- weaker, so no existing row can conflict.
DROP INDEX IF EXISTS idx_notifications_dedupe_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications(dedupe_key, channel, to_user_id)
    WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Post-conditions. Fail loudly rather than leaving a half-applied state — the
-- whole file runs in one implicit transaction via pool.query(), so a RAISE
-- here rolls everything back and the migration is retried on the next boot.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_refunds_open_per_order') THEN
        RAISE EXCEPTION 'Migration 082: uniq_refunds_open_per_order was not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_doctor_earnings_appointment_video') THEN
        RAISE EXCEPTION 'Migration 082: uniq_doctor_earnings_appointment_video was not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_notifications_dedupe') THEN
        RAISE EXCEPTION 'Migration 082: idx_notifications_dedupe was not created';
    END IF;
END $$;

COMMIT;
