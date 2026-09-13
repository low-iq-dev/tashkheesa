-- 107_refunds_open_slot_excludes_paid.sql
--
-- Part B item 8 (2026-09-13) — a PAID partial refund locked out the remainder.
--
-- Migration 083 widened the one-refund-per-order partial unique index to
-- ('pending','auto_approved','approved','paid') so a patient could not be
-- refunded twice for the same charge. That closed the double-refund hole by
-- making a PAID row hold the slot forever — so once an operator paid out a
-- PARTIAL refund (an SLA-breach uplift, a goodwill amount) no second refund
-- row could ever be created on that order, on any path, and the remainder the
-- patient was still owed became unrefundable by construction.
--
-- The right invariant is "at most one OPEN refund per order" plus "the sum of
-- refunds never exceeds what was charged". This migration restores the first
-- to open statuses only; the second is now enforced in the application by
-- services/refund_eligibility.remainingRefundableEgp (ceiling minus refunds
-- already PAID), which every create path applies. 'denied' and 'cancelled'
-- stay excluded — a denied request must be re-submittable.
--
-- Idempotent. Drives its own transaction (like 083). No data is modified.

BEGIN;

-- Pre-flight, same shape as 083: an order with more than one OPEN row cannot
-- receive the narrowed index. 083 guaranteed at most one row across the wider
-- set, so this cannot fire on a database that ran 083 — it is here so a
-- hand-edited or restored database fails with the reconciliation query
-- instead of a bare 23505 at boot.
DO $$
DECLARE
    dupe_count integer;
BEGIN
    SELECT COUNT(*) INTO dupe_count
    FROM (
        SELECT order_id
        FROM refunds
        WHERE status IN ('pending', 'auto_approved', 'approved')
        GROUP BY order_id
        HAVING COUNT(*) > 1
    ) d;

    IF dupe_count > 0 THEN
        RAISE EXCEPTION
            'Migration 107 aborted: % order(s) have more than one OPEN refund row. Reconcile (deny or cancel the duplicates) before retrying: SELECT order_id, count(*), array_agg(id), array_agg(status) FROM refunds WHERE status IN (''pending'', ''auto_approved'', ''approved'') GROUP BY 1 HAVING count(*) > 1;',
            dupe_count;
    END IF;
END $$;

DROP INDEX IF EXISTS uniq_refunds_open_per_order;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_refunds_open_per_order
    ON refunds(order_id)
    WHERE status IN ('pending', 'auto_approved', 'approved');

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_refunds_open_per_order') THEN
        RAISE EXCEPTION 'Migration 107: uniq_refunds_open_per_order was not recreated';
    END IF;
END $$;

COMMIT;
