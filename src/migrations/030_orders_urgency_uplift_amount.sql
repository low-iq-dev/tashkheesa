-- 030: orders.urgency_uplift_amount column.
--
-- Per docs/PAYOUT_AND_URGENCY_POLICY.md §2 + §4: store the uplift
-- portion (totalPrice - basePrice) separately so it can be cleanly
-- refunded on SLA breach without recomputing prices from scratch.
--
-- The order's base_price is reused as the "what the patient effectively
-- paid post-refund" anchor; urgency_uplift_amount holds the breach-
-- refundable delta.  Together: orders.base_price + orders.urgency_uplift_amount
-- = patient's actual charge at checkout.
--
-- Idempotent — IF NOT EXISTS guard.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders'
       AND column_name = 'urgency_uplift_amount'
  ) THEN
    ALTER TABLE orders
      ADD COLUMN urgency_uplift_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END
$$;

COMMIT;
