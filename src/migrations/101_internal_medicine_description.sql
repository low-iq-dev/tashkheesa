-- 101_internal_medicine_description.sql
--
-- Visual audit, 2026-08-29. On /specialties the Internal Medicine card rendered
-- its title and "6 services" badge, then a blank gap where every other card has
-- a paragraph, then "Learn more →". It was the only one of the six visible
-- specialties with description AND description_ar both NULL.
--
-- The template is not at fault — `s.description || ''` is the right thing for a
-- missing value; there was simply no value. So this is a data fix, and like
-- migration 100 the seed alone would only help a fresh install.
--
-- Written to match the five existing descriptions: "<Specialty> covers ...",
-- one sentence, naming representative conditions, ~150-175 characters.
--
-- Only fills NULL/blank, so an admin edit made before this deploys is not
-- clobbered, and re-running is a no-op.

BEGIN;

UPDATE specialties
   SET description = 'Internal Medicine covers the diagnosis and management of adult disease across the body''s systems, including diabetes, hypertension, thyroid disorders, anemia, and complex or undiagnosed symptoms.'
 WHERE id = 'spec-internal-medicine'
   AND COALESCE(BTRIM(description), '') = '';

UPDATE specialties
   SET description_ar = 'تختص الباطنة بتشخيص وعلاج أمراض البالغين في مختلف أجهزة الجسم، بما في ذلك السكري وارتفاع ضغط الدم واضطرابات الغدة الدرقية وفقر الدم والأعراض المعقدة أو غير المشخَّصة.'
 WHERE id = 'spec-internal-medicine'
   AND COALESCE(BTRIM(description_ar), '') = '';

-- Guard WARNS, never EXCEPTS: migrations run on boot and a copy fix must not be
-- able to boot-loop the app.
DO $$
DECLARE
  blanks INT;
BEGIN
  SELECT COUNT(*) INTO blanks
    FROM specialties
   WHERE COALESCE(is_visible, true) = true
     AND (COALESCE(BTRIM(description), '') = '' OR COALESCE(BTRIM(description_ar), '') = '');
  IF blanks > 0 THEN
    RAISE WARNING 'Migration 101: % visible specialty/-ies still have a blank description — their cards will render an empty gap on /specialties', blanks;
  END IF;
END $$;

COMMIT;
