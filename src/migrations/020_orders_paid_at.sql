-- 020_orders_paid_at.sql
--
-- Adds the missing `orders.paid_at` TIMESTAMPTZ column that
-- src/routes/payments.js:101-107 has been writing to since inception.
-- Without this column every Paymob payment webhook throws at parse time
-- with `column "paid_at" does not exist`. This migration makes the SQL
-- valid.
--
-- Backfills any historical row where payment_status='paid' using
-- `updated_at` as the best-available approximation of when payment
-- actually landed. If there are zero paid orders in the database at
-- migration time, the backfill no-ops.
--
-- Fully idempotent: guarded with IF NOT EXISTS; re-runs are no-ops.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Backfill paid orders. `updated_at` is the closest pre-existing
-- timestamp; if the code later distinguishes created_at / updated_at /
-- paid_at more precisely, the backfill is an approximation only for
-- historical rows. Going forward the callback handler writes the real
-- paid_at at webhook-receipt time.
UPDATE orders
   SET paid_at = updated_at
 WHERE payment_status = 'paid'
   AND paid_at IS NULL;

COMMIT;
