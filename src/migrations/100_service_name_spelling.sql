-- 100_service_name_spelling.sql
--
-- Visual/copy audit, 2026-08-29. One live service carried a British spelling
-- while every other public string on the site is US English:
--
--     "Gynaecological Ultrasound Review"  ->  "Gynecological Ultrasound Review"
--
-- The name is a DATA value (services.name), not a template string, so the
-- seed fix in src/db.js only helps a fresh install. Existing rows need this.
--
-- Safety notes:
--   * Matched on the exact old spelling, so re-running is a no-op and an
--     admin rename in between is not clobbered.
--   * No code matches this string literally (grepped src/ and tests/) —
--     it is display copy only. The service id ('obgyn_gynae_us' in the seed,
--     a uuid in production) is untouched, so orders, addons and earnings
--     that reference it are unaffected.
--   * The guard RAISES WARNING, never EXCEPTION: migrations run on boot, and
--     a cosmetic copy fix must never be able to boot-loop the app.

BEGIN;

UPDATE services
   SET name = 'Gynecological Ultrasound Review'
 WHERE name = 'Gynaecological Ultrasound Review';

DO $$
DECLARE
  stragglers INT;
BEGIN
  SELECT COUNT(*) INTO stragglers
    FROM services
   WHERE name ~* '(gynae|paediat|orthopaed|anaesth|haemat|tumour|oesoph|foetal)';
  IF stragglers > 0 THEN
    RAISE WARNING 'Migration 100: % service name(s) still carry British spellings — review services.name', stragglers;
  END IF;
END $$;

COMMIT;
