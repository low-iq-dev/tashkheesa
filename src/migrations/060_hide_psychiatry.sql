-- 060_hide_psychiatry.sql
--
-- Hide Psychiatry from the patient wizard. Per Ziad: Psychiatry doesn't
-- launch at Shifa, so the specialty and its sole priced service (added
-- in migration 057) must both flip to is_visible=false.
--
-- Two flags get flipped:
--   * specialties.is_visible            → false   for spec-psychiatry
--   * services.is_visible               → false   for svc-psychiatry-consultation
--
-- Why hide the service too: services are independent of
-- specialty.is_visible (no implicit cascade, per migration 057's note
-- on the Lab & Pathology reveal). If a future change force-shows the
-- specialty, the service should still be unreachable until explicitly
-- relaunched.
--
-- Wizard / classifier behaviour after this migration is automatic — the
-- routes that build the specialty grid and the classifier's enum both
-- filter on `COALESCE(is_visible, true) = true`
-- (src/routes/patient.js:1586, :1593, :2159, :2172, :2367, :2380), and
-- the classifier-feed code defensively drops any specialty with zero
-- visible services (src/routes/patient.js:1614).
--
-- End state: 20 visible specialties (was 21 post-057), all with at
-- least one visible priced service; 0 visible psychiatry services.

BEGIN;

-- ─── Hide Psychiatry specialty. ─────────────────────────────────────
UPDATE specialties
   SET is_visible = false
 WHERE id = 'spec-psychiatry';

-- ─── Hide all psychiatry services (today: just the consultation). ───
UPDATE services
   SET is_visible = false
 WHERE specialty_id = 'spec-psychiatry';

-- ─── Post-condition guards (atomic — failure rolls back the txn). ───
DO $$
DECLARE
  visible_specialties INT;
  visible_psych_services INT;
BEGIN
  SELECT COUNT(*) INTO visible_specialties
    FROM specialties WHERE is_visible = true;
  IF visible_specialties != 20 THEN
    RAISE EXCEPTION 'Migration 060 post-condition failed: expected 20 visible specialties (21 post-057 minus Psychiatry), got %', visible_specialties;
  END IF;

  SELECT COUNT(*) INTO visible_psych_services
    FROM services
   WHERE specialty_id = 'spec-psychiatry' AND is_visible = true;
  IF visible_psych_services != 0 THEN
    RAISE EXCEPTION 'Migration 060 post-condition failed: expected 0 visible psychiatry services, got %', visible_psych_services;
  END IF;
END $$;

COMMIT;
