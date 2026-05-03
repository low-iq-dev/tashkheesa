-- 039_users_first_login_at.sql
--
-- Adds users.first_login_at TIMESTAMP column. Tracks the first time
-- a user (currently only doctors, by usage) hits a landing dashboard.
-- NULL means never logged into a dashboard.
--
-- Used by the doctor dashboard handler to gate the welcome-modal
-- onboarding overlay (P1-DOC-5). Decoupled from users.onboarding_complete
-- because the latter is tied to the doctor signup flow completion,
-- not first dashboard visit, and several existing rows already have it
-- flipped true even though they've never visited the dashboard.
--
-- Idempotent: column add is guarded with IF NOT EXISTS check.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'first_login_at'
  ) THEN
    ALTER TABLE users ADD COLUMN first_login_at TIMESTAMP;
  END IF;
END $$;
