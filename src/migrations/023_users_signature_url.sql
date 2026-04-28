-- src/migrations/023_users_signature_url.sql
-- Adds users.signature_url for the doctor signature upload flow.
-- Mirrors users.profile_photo_url: TEXT, NULLable, stores an R2 key (e.g.
-- 'doctor-signatures/<userId>.png'). The signed-URL serve route generates
-- a short-lived URL on demand. Doctors with a saved signature have it
-- rendered into the "Before you submit" panel of the prescribe form
-- instead of the "no signature on file" warning.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signature_url TEXT;
