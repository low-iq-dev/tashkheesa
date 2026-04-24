-- 019b_remove_sla_addon.sql
--
-- Removes the `sla_24hr` addon from the registry. The 24-hour SLA feature
-- is now routed through urgency tiers on the main service (a price + SLA
-- modifier baked into orders / services pricing), not through a standalone
-- add-on. One mechanism, not two.
--
-- Safe to run on production because ADDON_SYSTEM_V2 is still false — the
-- new addon system is dormant, no `order_addons.addon_service_id='sla_24hr'`
-- rows have been written from live traffic. The unit-test / fixture rows
-- that DO reference sla_24hr are cleaned up by their own teardown logic;
-- if any straggler survives, the DELETE below would be blocked by a
-- hypothetical FK violation on order_addons.addon_service_id, which is
-- what we want — make the operator notice and clean those rows before
-- proceeding.
--
-- The legacy `orders.sla_hours` column and the `case_sla_worker.js` that
-- reads from it are NOT touched. Those remain the mechanism through which
-- urgency tier SLA gets enforced; consolidating that into the add-on
-- abstraction is a Phase 6 job, tracked in TODO.md.
--
-- Fully idempotent.

BEGIN;

-- Sanity: refuse to drop the registry row if any order_addons references it.
DO $$
DECLARE
  offending INTEGER;
BEGIN
  SELECT COUNT(*) INTO offending
    FROM order_addons
   WHERE addon_service_id = 'sla_24hr';
  IF offending > 0 THEN
    RAISE EXCEPTION
      'refusing to drop sla_24hr: % order_addons rows still reference it — clean those up first',
      offending;
  END IF;
END
$$;

DELETE FROM addon_services WHERE id = 'sla_24hr';

COMMIT;
