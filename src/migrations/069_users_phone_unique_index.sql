-- 069: Partial UNIQUE index on users.phone — guard for phone-OTP signup-by-phone.
--
-- Verified against prod (read-only, 2026-06-09): 21 users have a phone, all
-- distinct as stored (0 exact-string duplicates) -> this index builds cleanly.
--
-- It enforces uniqueness of the STORED phone string. New rows are written
-- normalized (E.164) by the find-or-use-existing paths (web /login/otp/verify
-- and mobile /api/v1/auth/otp/verify), so this enforces normalized-phone
-- uniqueness for all new data and makes signup-by-phone race/constraint-safe.
--
-- It intentionally does NOT touch the 7 pre-existing non-E.164 legacy rows.
-- Normalizing those would collide on 2 pairs (incl. a superadmin + patient
-- sharing one EG number) and is deferred to a separate, manually-reviewed task.
-- Partial (WHERE phone IS NOT NULL) so the many NULL-phone rows are unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique_idx
  ON users (phone)
  WHERE phone IS NOT NULL;
