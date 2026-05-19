-- 064_users_welcome_email_last_sent_at.sql
--
-- Adds a tracking column so the superadmin doctors list can show
-- "Welcome sent Xh ago" next to each Resend-welcome button and so
-- admins don't accidentally double-send.
--
-- Set by _issueDoctorWelcomePayload (src/routes/superadmin.js) on
-- successful queueMultiChannelNotification for the doctor-welcome
-- email — covers both the initial /approve path and the
-- /resend-welcome path.
--
-- NULL means "never sent" (e.g. doctors created before this column
-- existed, or imported via SQL UPDATE that bypassed /approve). The
-- view treats NULL as "—" and keeps the resend button enabled.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op on re-run.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS welcome_email_last_sent_at TIMESTAMPTZ NULL;

COMMIT;
