-- 031: canonicalize urgency_tier 'fast_track' → 'vip'.
--
-- Per docs/PAYOUT_AND_URGENCY_POLICY.md §2: VIP is the canonical name
-- for the 1.3× / 18h tier.  Pre-policy code wrote 'fast_track' to
-- orders.urgency_tier; existing rows are migrated here so earnings
-- filters, breach detection, and analytics queries can read a single
-- canonical value.
--
-- Production volume is trivial (3 demo rows at the time of writing).
-- The UPDATE is gated WHERE urgency_tier = 'fast_track' so re-running
-- is a no-op.

BEGIN;

UPDATE orders
   SET urgency_tier = 'vip',
       updated_at   = NOW()
 WHERE urgency_tier = 'fast_track';

COMMIT;
