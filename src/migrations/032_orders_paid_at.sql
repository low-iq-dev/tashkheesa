-- 032_orders_paid_at.sql
-- Adds paid_at column to orders table.
--
-- BACKGROUND: payments.js webhook handler has been writing to this column
-- since 2026-04-24 (see TODO.md), causing every Paymob callback to throw
-- 'column "paid_at" does not exist' and return HTTP 500. This silently
-- broke all production payment processing. Low traffic masked the bug.
--
-- This migration adds the column the code already expects.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Backfill: for any historical orders marked paid, use updated_at as
-- the best available approximation of when payment landed.
-- As of 2026-04-30 there are 3 such rows on production.
UPDATE orders
   SET paid_at = updated_at
 WHERE payment_status = 'paid'
   AND paid_at IS NULL;

-- Index for queries filtering by payment date (e.g. monthly revenue reports).
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at)
  WHERE paid_at IS NOT NULL;
