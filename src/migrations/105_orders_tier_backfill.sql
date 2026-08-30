-- 105_orders_tier_backfill.sql
--
-- orders.tier is a stale duplicate of orders.urgency_tier.
--
-- All 39 orders carry tier='standard' — the column DEFAULT from migration 010,
-- never written at order creation — while urgency_tier correctly carries
-- standard / urgent / vip. Two rows already disagree: a case the patient paid an
-- urgency surcharge for reads 'standard' in the older column.
--
-- WHAT THIS IS *NOT*. The register listed this as an SLA hazard. It is not, any
-- more: notify/broadcast.js determineTier() reads urgency_tier first (fixed in
-- an earlier audit) and the superadmin dashboard selects
-- COALESCE(o.urgency_tier,'standard'). Both live readers are already correct.
-- The remaining risk is the trap itself — a column that looks authoritative,
-- is named as though it were, and is wrong on the rows that matter most.
--
-- Backfilled rather than dropped, four days before launch: dropping a column
-- that broadcast.js still WRITES would need a code change in the same breath,
-- and the cheap safe move is to make the two agree so a future reader of either
-- gets the same answer. Dropping it belongs in the post-launch cleanup.
--
-- Only fills where they actually differ, so re-running is a no-op.

BEGIN;

UPDATE orders
   SET tier = urgency_tier
 WHERE urgency_tier IS NOT NULL
   AND COALESCE(BTRIM(tier), '') <> COALESCE(BTRIM(urgency_tier), '');

DO $$
DECLARE
  disagree INT;
BEGIN
  SELECT COUNT(*) INTO disagree
    FROM orders
   WHERE urgency_tier IS NOT NULL
     AND COALESCE(BTRIM(tier), '') <> COALESCE(BTRIM(urgency_tier), '');
  IF disagree > 0 THEN
    RAISE WARNING 'Migration 105: % order(s) still disagree between tier and urgency_tier', disagree;
  END IF;
END $$;

COMMIT;
