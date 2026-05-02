-- 037_orders_base_price.sql
--
-- Codifies orders.base_price in the canonical migrations tree.
--
-- This column was previously added by src/migrate_mobile_api.js (a
-- parallel boot-time path that calls safeAddColumn() but does NOT
-- register in schema_migrations), so prod has the column without a
-- migration row recording its origin.  This migration is a no-op on
-- environments where the column already exists (IF NOT EXISTS guard);
-- on fresh installs it creates it.
--
-- Type: DOUBLE PRECISION.  This matches the project-wide convention
-- for monetary columns — orders.price, orders.doctor_fee,
-- services.base_price, services.doctor_fee are all DOUBLE PRECISION.
-- A future cleanup PR may migrate all money columns to NUMERIC(10,2)
-- for exact decimal arithmetic — out of scope for this PR.
--
-- Per docs/PAYOUT_AND_URGENCY_POLICY.md §2, orders.base_price is the
-- catalog snapshot of the service base price at order creation time
-- (mirroring the orders.doctor_fee snapshot pattern).  Together with
-- orders.urgency_uplift_amount (migration 030), the patient's
-- checkout total is:
--   orders.base_price + orders.urgency_uplift_amount = orders.price
--
-- NULL is allowed.  Legacy rows from before this column was
-- populated will have NULL; code reads it as Number(x) || 0 by
-- convention.
--
-- Idempotent — IF NOT EXISTS guard.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders'
       AND column_name = 'base_price'
  ) THEN
    ALTER TABLE orders ADD COLUMN base_price DOUBLE PRECISION;
  END IF;
END
$$;

COMMIT;
