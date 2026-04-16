-- 011: Add UNIQUE (specialty_id, name) on services
--
-- Companion to the seed_specialties.js fix that switches to deterministic IDs
-- and ON CONFLICT (specialty_id, name) DO NOTHING. Without this constraint:
--   - the seeder's ON CONFLICT inference has nothing to target (would error)
--   - duplicate rows could be re-introduced on every boot (the original bug)
--
-- PRECONDITION: scripts/dedupe_services.js --live must have been run against
-- this database first. If duplicate (specialty_id, name) pairs still exist
-- when this migration runs, ALTER TABLE ADD CONSTRAINT will fail and boot
-- will be blocked. The dedupe script's post-check reports remaining_dup_groups
-- — confirm 0 before deploying.
--
-- PostgreSQL does not support `ADD CONSTRAINT IF NOT EXISTS`, hence the DO
-- block — matches the idempotency pattern used in 002_column_additions.sql.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'services_specialty_name_unique'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_specialty_name_unique UNIQUE (specialty_id, name);
  END IF;
END $$;
