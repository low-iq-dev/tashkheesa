-- 066_hide_oncology.sql
--
-- Hide Oncology from the patient wizard. Per Ziad (launch audit 2026-06-01):
-- the specialty is currently is_visible=true but 7 of 9 services are hidden
-- and un-priced (base_price NULL, doctor_fee NULL). The remaining 2 visible
-- services give patients a near-empty catalog. Decision: hide the whole
-- specialty until pricing + catalog is complete; relaunch separately.
--
-- Two flags get flipped (mirrors the 060_hide_psychiatry shape):
--   * specialties.is_visible  → false   for spec-oncology
--   * services.is_visible     → false   for the 2 currently visible
--                                       oncology services
--
-- Why hide the services too: services are independent of
-- specialty.is_visible (no implicit cascade — same reasoning as 060).
-- If a future change force-shows the specialty, the still-un-priced
-- services should stay unreachable until explicitly relaunched.
--
-- The 7 already-hidden services (cytology_reports, heme_onc_blood,
-- histo_reports, petct_imaging, recist_response, rt_planning_scan,
-- tumor_markers) are left alone — they remain is_visible=false with
-- NULL pricing until catalog work brings them online.
--
-- Wizard / classifier behaviour after this migration is automatic — the
-- patient routes filter on COALESCE(is_visible, true) = true and the
-- classifier-feed defensively drops specialties with zero visible
-- services (src/routes/patient.js).
--
-- End state: 19 visible specialties (was 20 post-060), all with at
-- least one visible priced service; 0 visible oncology services.

BEGIN;

-- ─── Hide Oncology specialty. ────────────────────────────────────────
UPDATE specialties
   SET is_visible = false
 WHERE id = 'spec-oncology';

-- ─── Hide the 2 currently visible oncology services. ───────────────
UPDATE services
   SET is_visible = false
 WHERE specialty_id = 'spec-oncology'
   AND is_visible = true;

-- ─── Post-condition guards (atomic — failure rolls back the txn). ───
DO $$
DECLARE
  visible_specialties INT;
  visible_onc_services INT;
  onc_specialty_visible BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO visible_specialties
    FROM specialties WHERE is_visible = true;
  IF visible_specialties != 19 THEN
    RAISE EXCEPTION 'Migration 066 post-condition failed: expected 19 visible specialties (20 post-060 minus Oncology), got %', visible_specialties;
  END IF;

  SELECT is_visible INTO onc_specialty_visible
    FROM specialties WHERE id = 'spec-oncology';
  IF onc_specialty_visible IS NOT FALSE THEN
    RAISE EXCEPTION 'Migration 066 post-condition failed: spec-oncology is_visible should be false, got %', onc_specialty_visible;
  END IF;

  SELECT COUNT(*) INTO visible_onc_services
    FROM services
   WHERE specialty_id = 'spec-oncology' AND is_visible = true;
  IF visible_onc_services != 0 THEN
    RAISE EXCEPTION 'Migration 066 post-condition failed: expected 0 visible oncology services, got %', visible_onc_services;
  END IF;
END $$;

COMMIT;
