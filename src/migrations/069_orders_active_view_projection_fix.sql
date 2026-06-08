-- 069_orders_active_view_projection_fix.sql
--
-- Fix: orders_active was created as `SELECT * FROM orders ...` (migration 045).
-- Postgres expands `*` to the table columns AT CREATION TIME and freezes that
-- list, so later `ALTER TABLE orders ADD COLUMN` (056, etc.) did NOT propagate.
-- As of 2026-06-08 the view is missing 4 columns that exist on `orders`:
--   sla_paused_at, sla_remaining_seconds, assignment_status, no_sla_refund_eligibility
-- Code doing `SELECT <col> FROM orders_active` for those columns crashes
-- (queryOne rethrows) or silently empties (safeAll -> []). This breaks the
-- patient order-detail + refund pages, the superadmin manual-queue, the
-- broadcast skip-guard, and dashboard counters.
--
-- This RE-RUNS the 045 statement. `CREATE OR REPLACE VIEW` re-expands `*` to the
-- CURRENT orders columns; the new list preserves the existing 67 columns in the
-- same order and appends the 4 new ones (the only shape CREATE OR REPLACE VIEW
-- allows) -- verified against live information_schema (view cols are an in-order
-- prefix of orders cols). PURELY ADDITIVE: no data touched; re-run is a no-op.
--
-- A post-condition guard asserts FULL parity (every orders column is projected)
-- and ABORTS the transaction if not, so any regression fails loudly on boot
-- instead of silently shipping a half-fixed view.

BEGIN;

CREATE OR REPLACE VIEW orders_active AS
  SELECT * FROM orders WHERE deleted_at IS NULL;

-- Post-condition guard: orders_active must project EVERY orders column.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(oc.column_name, ', ' ORDER BY oc.ordinal_position)
    INTO missing
  FROM information_schema.columns oc
  WHERE oc.table_schema = 'public'
    AND oc.table_name = 'orders'
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns vc
      WHERE vc.table_schema = 'public'
        AND vc.table_name = 'orders_active'
        AND vc.column_name = oc.column_name
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'orders_active projection guard failed -- missing orders column(s): %', missing;
  END IF;
END $$;

COMMIT;
