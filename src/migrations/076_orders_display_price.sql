-- 076_orders_display_price.sql
-- ============================================================================
-- International markets: always-charge-EGP + local-price display.
--
-- The charge is ALWAYS EGP (orders.price = EGP amount, orders.currency = 'EGP').
-- For an international order we ADDITIONALLY store the LOCAL figures FOR DISPLAY
-- ONLY:
--   display_price     — local amount shown to the patient (e.g. 1199)
--   display_currency  — local ISO currency (e.g. 'AED')
-- Domestic (EG) orders leave BOTH NULL; rendering falls back to price/'EGP', so
-- EG behaviour is byte-identical. Additive, nullable, NO backfill.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS on both columns, so a re-run / already-
-- migrated DB is a no-op. Guarded on the orders table existing so a fresh/local
-- DB still boots (mirrors migration 075's existence guard).
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS display_price    DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS display_currency TEXT;
  END IF;
END $$;
