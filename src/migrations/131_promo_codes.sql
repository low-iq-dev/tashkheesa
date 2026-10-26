-- ============================================================================
-- 131 — promo codes (SHIFA25) + the discount columns on orders
--
-- 26 Oct 2026. The printed OPD poster and leaflets at Shifa Hospital advertise
-- "SHIFA25 — 25% off" and nothing in the platform knew what a promo code was.
-- services/promo_codes.js is the one module that validates, applies and
-- redeems a code; this file is its schema.
--
-- promo_codes
--   code          stored UPPERCASE (CHECK), unique case-insensitively via the
--                 UPPER(code) index — 'shifa25' and 'SHIFA25' are one code.
--   percent_off   1..90. Never 100: a free case has no payment to confirm and
--                 would never reach markCasePaid.
--   markets       NULL = every pricing market; otherwise the
--                 pricing_market.pricingMarketFor() values it is valid for.
--   max_uses      NULL = unlimited. Checked when a code is APPLIED; `uses` is
--                 incremented only when an order carrying the code is actually
--                 PAID (case_lifecycle.markCasePaid → promo_codes.redeemForPaidOrder),
--                 so abandoned drafts never burn a use.
--
-- orders (all nullable — NULL means "no promo", which is every existing row)
--   promo_code             the code applied to this order
--   price_before_discount  orders.price before the code (EGP, tier uplift included)
--   discount_egp           price_before_discount - price
--   promo_redeemed_at      set once, in the paid transaction, when `uses` was
--                          incremented for this order — the idempotency marker.
--
-- orders.price stays THE charge (Kashier session, webhook verification, the
-- InstaPay/bank amount, claims, receipts all read it). base_price,
-- urgency_uplift_amount and doctor_fee are NOT touched by a promo, so the
-- doctor's share (doctor_fee + uplift share) is computed from the list price.
-- With a promo the 037 invariant reads
--   base_price + urgency_uplift_amount - COALESCE(discount_egp, 0) = price
-- and every reader of the charge is price-first already.
--
-- Additive and idempotent (IF NOT EXISTS everywhere; the seed is ON CONFLICT DO
-- NOTHING so an operator's later edit to SHIFA25 is never overwritten). No
-- explicit BEGIN/COMMIT — the runner (src/db.js) wraps the file and its
-- schema_migrations row in one transaction.
-- ============================================================================

CREATE TABLE IF NOT EXISTS promo_codes (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code         TEXT NOT NULL CHECK (code = UPPER(code) AND code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  percent_off  INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  active       BOOLEAN NOT NULL DEFAULT true,
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  max_uses     INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses         INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  markets      TEXT[],
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE promo_codes IS
  'Percentage promo codes (e.g. SHIFA25 on the hospital OPD poster). Validated/applied/redeemed only by services/promo_codes.js. uses counts PAID orders. See migration 131.';

CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_upper_uniq
  ON promo_codes (UPPER(code));

ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_egp numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS price_before_discount numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_redeemed_at timestamptz;

COMMENT ON COLUMN orders.promo_code IS
  'Promo code applied to this order (promo_codes.code). NULL = none. See migration 131.';
COMMENT ON COLUMN orders.price_before_discount IS
  'orders.price before the promo code (EGP, tier uplift included). The doctor fee is based on this list price, never on the discounted price. See migration 131.';
COMMENT ON COLUMN orders.discount_egp IS
  'price_before_discount - price, in EGP. See migration 131.';
COMMENT ON COLUMN orders.promo_redeemed_at IS
  'When promo_codes.uses was incremented for this order (inside the paid transaction). Set once. See migration 131.';

-- Seed: SHIFA25 — 25% off, active, no expiry, no use limit, Egyptian price list
-- only (the poster is in a Cairo hospital; an international patient is priced
-- from their own list and the code does not apply there).
INSERT INTO promo_codes (code, percent_off, active, starts_at, expires_at, max_uses, markets, note)
SELECT 'SHIFA25', 25, true, NOW(), NULL, NULL, ARRAY['EG'],
       'Shifa Hospital OPD poster + leaflets (Oct 2026). EG pricing market only.'
 WHERE NOT EXISTS (SELECT 1 FROM promo_codes WHERE UPPER(code) = 'SHIFA25');

-- ── orders_active re-sync ───────────────────────────────────────────────────
-- public.orders_active is `SELECT * FROM orders WHERE deleted_at IS NULL` and
-- freezes its column list at creation, so the new columns are invisible through
-- the view until it is re-created. The 084 / 121 / 129 block verbatim: wrapped
-- in its own exception block so a refusal (42P16) is a deploy-log WARNING, not
-- a crash-loop. services/promo_codes.js reads the promo columns from `orders`
-- directly, so the feature works even if this re-sync is refused.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    BEGIN
      EXECUTE 'CREATE OR REPLACE VIEW public.orders_active WITH (security_invoker = true) AS '
           || 'SELECT * FROM orders WHERE deleted_at IS NULL';

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE SELECT ON public.orders_active FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE SELECT ON public.orders_active FROM authenticated';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Migration 131: could NOT re-sync public.orders_active (% %). NOT FATAL, boot continues, but orders_active may be missing the promo columns. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (check pg_depend first and rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;',
        SQLSTATE, SQLERRM;
    END;
  END IF;
END $$;

-- Post-condition parity guard, copied from 084 / 121 / 129 (WARNING unless
-- tashkheesa.migration_strict is on).
DO $$
DECLARE
  missing text;
  strict_mode boolean :=
    lower(COALESCE(current_setting('tashkheesa.migration_strict', true), 'off'))
      IN ('on','true','1','yes');
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    SELECT string_agg(oc.column_name, ', ' ORDER BY oc.ordinal_position)
      INTO missing
    FROM information_schema.columns oc
    WHERE oc.table_schema = 'public'
      AND oc.table_name  = 'orders'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns vc
        WHERE vc.table_schema = 'public'
          AND vc.table_name   = 'orders_active'
          AND vc.column_name  = oc.column_name
      );

    IF missing IS NOT NULL THEN
      IF strict_mode THEN
        RAISE EXCEPTION 'Migration 131: orders_active is missing orders columns after re-sync: % (tashkheesa.migration_strict is on)', missing;
      ELSE
        RAISE WARNING 'Migration 131: orders_active is MISSING orders columns after re-sync: %. Readers of orders_active cannot see these columns. NOT FATAL, boot continues. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;', missing;
      END IF;
    END IF;
  END IF;
END $$;
