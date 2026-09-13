-- 108_refunds_paid_to_and_paid_by.sql
--
-- Part C4 (2026-09-13) — marking a refund paid recorded the InstaPay
-- transaction reference and nothing else. The number the money was actually
-- sent to, and the operator who sent it, lived only in the order-event log
-- (or nowhere: the number a patient typed could be corrected on the phone and
-- the correction never written down). The patient's refund timeline needs the
-- last four digits of the number PAID TO, and a payout needs a name on it.
--
--   paid_to_number — the InstaPay number the operator sent the money to
--                    (E.164, as typed into the mark-paid form).
--   paid_by        — users.id of the operator who marked it paid.
--
-- Additive and nullable: existing rows (and the Command app's mark-paid, which
-- does not send a number yet) keep working; readers fall back to
-- instapay_handle. Idempotent.

ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paid_to_number TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paid_by        TEXT;
