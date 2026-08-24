-- 088_prescription_addon_pricing.sql
-- ============================================================================
-- 2026-08-24 — set the prescription add-on's price in every currency the
-- platform sells in, and make it internally consistent.
--
-- ── WHY THE EXISTING NUMBERS DO NOT WORK ────────────────────────────────────
--
-- addon_services.prices_json held {EGP:400, AED:90, SAR:100, USD:30}. Three
-- problems:
--
--   1. FIVE OF NINE CURRENCIES MISSING. service_regional_prices carries EGP,
--      USD, GBP, AED, SAR, QAR, KWD, BHD and OMR. GBP, QAR, KWD, BHD and OMR
--      had no prescription price, so resolveAddonPrice fell back to the EGP
--      figure for those patients.
--
--   2. AED AND SAR DISAGREE (90 vs 100). Every one of the 57 fully-priced
--      services in service_regional_prices sets AED = QAR = SAR to the SAME
--      number — 449 / 749 / 1199 across the three price bands. The add-on was
--      the only thing on the platform that split them, for no reason.
--
--   3. EGP 400 IS MORE THAN SOME WHOLE SERVICES. The cheapest reviews are
--      EGP 380 (lab_hormone_e2, lab_hormone_fsh) and EGP 437 (lab_cbc).
--      Charging 400 for the prescription that accompanies a 380 review is not
--      defensible to a patient, and it is 32% of the cheapest imaging review
--      (EGP 1250, card_ecg_12lead).
--
-- ── THE PRICE: EGP 300 ──────────────────────────────────────────────────────
--
-- An add-on has to read as a small extra next to the thing it attaches to, or
-- it stops being an impulse purchase at checkout and becomes a second decision.
-- 300 sits below every service in the catalogue, which 400 does not.
--
-- It also fixes the effort/reward inversion against the other add-on. At 50%
-- commission the doctor earns 150 for writing a prescription — a couple of
-- minutes on a case they have already reviewed — against 170 for a full live
-- video consultation (200 EGP at 85%). At the old 400 the prescription paid
-- the doctor MORE in absolute terms than the video call, which would have made
-- video consults the thing doctors quietly avoid.
--
-- Commission stays at 50%: platform 150, doctor 150.
--
-- ── THE OTHER CURRENCIES ────────────────────────────────────────────────────
--
-- Not FX-converted. This platform prices internationally in fixed bands that
-- are deliberately decoupled from EGP — the same review is EGP 1250 / 3680 /
-- 8395 domestically but USD 120 / 200 / 350 abroad. The three observed bands:
--
--     USD    AED/QAR/SAR    GBP    KWD    BHD/OMR
--     120        449        150     35      45
--     200        749        250     59      75
--     350       1199        400     95     119
--
-- Holding USD 30 (the existing figure) and applying the same ratios the ladder
-- uses — AED/QAR/SAR ≈ 3.75x USD, GBP ≈ 1.25x, KWD ≈ 0.29x, BHD/OMR ≈ 0.375x —
-- with the ladder's own rounding style gives the values below.
--
-- AED moves 90 → 109 and SAR 100 → 109 so the three Gulf currencies agree with
-- each other and with every other row in the catalogue.
--
-- ── SCOPE ───────────────────────────────────────────────────────────────────
--
-- Writes addon_services only. That is now the single catalogue the checkout,
-- the pay page and onPurchase all read (see services/addons/pricing.js), so no
-- service_regional_prices row is needed and adding one would reintroduce the
-- two-catalogue drift this change set removed.
--
-- No historical rows to reprice: order_addons is empty, nothing has ever been
-- sold. Prices already purchased are snapshotted on the order_addons row at
-- purchase time, so a future change here can never reprice a past sale.
--
-- IDEMPOTENT — a straight assignment; re-running writes the same values.
-- ============================================================================

UPDATE addon_services
   SET base_price_egp = 300,
       prices_json = jsonb_build_object(
         'EGP', 300,
         'USD', 30,
         'GBP', 39,
         'AED', 109,
         'SAR', 109,
         'QAR', 109,
         'KWD', 9,
         'BHD', 12,
         'OMR', 12
       ),
       updated_at = NOW()
 WHERE id = 'prescription';

-- The video add-on has the same five-currency gap. Deliberately NOT touched
-- here: its price (EGP 200 at 85% commission) is itself questionable — that is
-- less than a sixth of the cheapest review for a live specialist call — and
-- repricing it is a business decision of its own, not a consistency fix.
-- Both add-ons are held behind feature flags for launch, so neither gap is
-- reachable yet. Raised in claude/ADDON_V2_MIGRATION_2026-08-24.md.

DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing
    FROM (SELECT unnest(ARRAY['EGP','USD','GBP','AED','SAR','QAR','KWD','BHD','OMR']) AS c) x
   WHERE NOT EXISTS (
     SELECT 1 FROM addon_services a
      WHERE a.id = 'prescription'
        AND a.prices_json ? x.c
        AND (a.prices_json ->> x.c)::numeric > 0
   );
  IF missing > 0 THEN
    RAISE EXCEPTION '088: prescription add-on still has % currency/currencies without a positive price', missing;
  END IF;
END $$;
