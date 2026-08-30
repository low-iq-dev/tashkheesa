-- 104_home_market_single_price.sql
--
-- The catalogue and the checkout quoted DIFFERENT prices for the same service.
--
-- /services, the specialty pages, the blog bodies, the FAQ and the homepage's
-- schema.org priceRange all read services.base_price. The checkout priced
-- through service_regional_prices. 38 EG rows existed there, and every single
-- one of them differed from base_price — 20 on services a patient could book
-- that day:
--
--   CT/MR Angiography Review        page 3,500   checkout 17,480   (+13,980)
--   Spine MRI Review                page 2,400   checkout  9,315   (+6,915)
--   CT Scan Review                  page 2,400   checkout  9,085   (+6,685)
--   Cardiac MRI Review              page 2,400   checkout  8,395   (+5,995)
--   ...
--   Echocardiogram Review           page 2,400   checkout  1,380   (-1,020)
--   12-Lead ECG Interpretation      page 1,600   checkout  1,250   (-350)
--
-- Twelve overcharged, eight undercharged. A patient shown 3,500 would have
-- reached the card form at 17,480.
--
-- service_regional_prices exists to express OTHER markets in THEIR currency —
-- 177 services each in AED, SAR, GBP, USD, KWD, QAR, BHD, OMR. An EG row in
-- EGP is a SECOND EGP price for a service that already has one. That is the
-- bug, not a feature: base_price is the home-market price by definition,
-- because it is the number every public surface publishes.
--
-- DEACTIVATED, NOT DELETED. Every reader filters on
-- COALESCE(status,'active') = 'active', so flipping status takes them out of
-- pricing while keeping the numbers for review — if any of them is the price
-- Ziad actually wants, the fix is to raise services.base_price (which the site
-- will then advertise), not to restore a second column only the checkout can
-- see. The old value is preserved in notes so nothing is lost.
--
-- Rows referencing service ids that no longer exist in `services` (the old
-- lab_* catalogue) are left alone: they are inert, since no bookable service
-- resolves to them, and clearing them is separate housekeeping.
--
-- The code-side guard lives in services/case_intake_pricing.js (HOME_MARKET),
-- so even a future EG row cannot reintroduce the split.

BEGIN;

UPDATE service_regional_prices rp
   SET status = 'superseded_by_base_price',
       notes  = COALESCE(NULLIF(BTRIM(rp.notes), '') || ' | ', '') ||
                'Deactivated by migration 104 on 2026-08-30: conflicted with services.base_price ('
                || rp.tashkheesa_price::text || ' vs ' || sv.base_price::text
                || ' EGP). base_price is what the site advertises.'
  FROM services sv
 WHERE sv.id = rp.service_id
   AND rp.country_code = 'EG'
   AND COALESCE(rp.status, 'active') = 'active';

-- Guard WARNS, never EXCEPTS — migrations run on boot and a pricing cleanup
-- must not be able to boot-loop the app.
DO $$
DECLARE
  still_active INT;
BEGIN
  SELECT COUNT(*) INTO still_active
    FROM service_regional_prices rp
    JOIN services sv ON sv.id = rp.service_id
   WHERE rp.country_code = 'EG'
     AND COALESCE(rp.status, 'active') = 'active';
  IF still_active > 0 THEN
    RAISE WARNING 'Migration 104: % active EG regional price(s) remain — the catalogue and the checkout can still disagree', still_active;
  END IF;
END $$;

COMMIT;
