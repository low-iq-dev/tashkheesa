-- 059_pricing_drift_eg_stragglers.sql
--
-- Side issue #78 — pricing drift between services.base_price (canonical v4)
-- and service_regional_prices.tashkheesa_price (country_code='EG').
--
-- Background:
--   Migrations 051/052/053 (the v4 launch reset) bumped 5 stragglers to
--   1,250 EGP via the canonical services.base_price column. The matching
--   service_regional_prices rows for Egypt were missed in that pass and
--   still hold pre-v4 values. Theme 14 Phase 3 polish walkthrough
--   surfaced the drift when a "12-Lead ECG Interpretation" recommendation
--   rendered EGP 575 (regional) instead of EGP 1,250 (canonical) — the
--   GET handler uses COALESCE(cp.tashkheesa_price, sv.base_price) so
--   the regional row wins when present.
--
-- The 4 stragglers (full enumeration from
-- docs/audits/PRICING_DRIFT_2026-05-16.md):
--
--   service_id          canonical   regional EG   delta
--   ─────────────────────────────────────────────────────
--   card_ecg_12lead     1,250       575           -675 (-54%)
--   card_rhythm_strip   1,250       575           -675 (-54%)
--   rad_cxr_review      1,250       633           -617 (-49%)
--   lab_cytology        1,250       1,035         -215 (-17%)
--
-- The remaining 139 visible services are either consistent with
-- canonical (34 rows) or have no regional row at all (105 rows) — the
-- regional table is narrowly stale on these 4, not broken at scale.
--
-- Post-condition guard: assert exactly 4 rows updated (defensive — fails
-- the migration atomically if the targeted set drifts). NB the assertion
-- is on tashkheesa_price = 1250 AFTER the UPDATE, scoped to the 4 ids,
-- so a re-run after the migration ships still passes (idempotent: the
-- UPDATE sets the same value on already-updated rows; the assertion
-- reads the post-state).
--
-- Forensic note for #46-style audits: the pre-migration state of these
-- 4 rows is preserved in docs/audits/PRICING_DRIFT_2026-05-16.md.

BEGIN;

UPDATE service_regional_prices
   SET tashkheesa_price = 1250
 WHERE country_code = 'EG'
   AND status       = 'active'
   AND service_id IN (
     'card_ecg_12lead',
     'card_rhythm_strip',
     'rad_cxr_review',
     'lab_cytology'
   );

DO $$
DECLARE aligned_count INT;
BEGIN
  SELECT COUNT(*) INTO aligned_count
    FROM service_regional_prices
   WHERE country_code = 'EG'
     AND status = 'active'
     AND service_id IN (
       'card_ecg_12lead', 'card_rhythm_strip',
       'rad_cxr_review',  'lab_cytology'
     )
     AND tashkheesa_price = 1250;
  IF aligned_count != 4 THEN
    RAISE EXCEPTION 'Migration 059 post-condition failed: expected 4 stragglers aligned at 1250 EGP, got %', aligned_count;
  END IF;
END $$;

COMMIT;
