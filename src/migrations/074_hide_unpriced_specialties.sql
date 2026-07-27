-- 074_hide_unpriced_specialties.sql
-- ============================================================================
-- One-shot: hide the three specialties that have no pricing configured
-- (spec-ent, spec-general-surgery, spec-pediatrics).
--
-- WHY: this hide was previously re-applied on EVERY boot in src/db.js
-- runDataFixups(). Force-mutating production data on every deploy is the same
-- bug class as the Internal Medicine incident: if an operator adds pricing and
-- re-enables one of these specialties (is_visible=true), the next boot silently
-- clobbers that back to false. Moving it to a tracked one-shot migration hides
-- them exactly ONCE; visibility is under operator control forever after.
--
-- Idempotent: the WHERE guard is a no-op on re-run, the migration runner only
-- executes this file once (recorded in schema_migrations), and the whole thing
-- is guarded on the `specialties` table existing so a fresh/local DB that has
-- not created it yet still boots (mirrors migration 072's role-existence guard).
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'specialties'
  ) THEN
    UPDATE specialties
       SET is_visible = false
     WHERE id IN ('spec-ent', 'spec-general-surgery', 'spec-pediatrics')
       AND is_visible != false;
  END IF;
END $$;
