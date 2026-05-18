-- 062_notify_whatsapp_default_true.sql
-- Phase 1 of WhatsApp-via-OpenClaw rollout.
--
-- 1. Flip users.notify_whatsapp DEFAULT from false → true so new patient
--    signups are subscribed by default. Implicit consent: a patient
--    handing us a phone number for OTP + transactional comms expects
--    WhatsApp updates in the Egyptian healthcare context. Reply-STOP
--    handling (OpenClaw inbound side) gives explicit opt-out.
--
-- 2. One-shot bulk opt-in for existing patients who still have the old
--    DEFAULT false value AND a phone on file. Reversible: pre-flip
--    values are recorded in notify_whatsapp_migration_062_backup so
--    a down migration can restore exactly the prior per-row state.
--    Patients who explicitly opted out (notify_whatsapp = false but
--    after this migration we can't distinguish from never-touched —
--    so the backup table captures all flipped rows verbatim).

BEGIN;

-- Backup current per-row values for every patient row we are about to
-- flip. ON CONFLICT keeps a re-run idempotent (the migration runner
-- should never re-run, but Render boot ordering can repeat in edge
-- cases — additive ON CONFLICT is safe).
CREATE TABLE IF NOT EXISTS notify_whatsapp_migration_062_backup (
  user_id TEXT PRIMARY KEY,
  original_value BOOLEAN NOT NULL,
  backed_up_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO notify_whatsapp_migration_062_backup (user_id, original_value)
SELECT id, COALESCE(notify_whatsapp, false)
FROM users
WHERE role = 'patient'
  AND phone IS NOT NULL
  AND COALESCE(notify_whatsapp, false) = false
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE users ALTER COLUMN notify_whatsapp SET DEFAULT true;

UPDATE users
SET notify_whatsapp = true
WHERE role = 'patient'
  AND phone IS NOT NULL
  AND COALESCE(notify_whatsapp, false) = false;

COMMIT;

-- ── ROLLBACK (manual, not auto-applied) ───────────────────────────────
-- BEGIN;
-- UPDATE users u
--   SET notify_whatsapp = b.original_value
--   FROM notify_whatsapp_migration_062_backup b
--   WHERE u.id = b.user_id;
-- ALTER TABLE users ALTER COLUMN notify_whatsapp SET DEFAULT false;
-- DROP TABLE notify_whatsapp_migration_062_backup;
-- COMMIT;
