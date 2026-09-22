-- 110_user_sessions.sql
-- ============================================================================
-- Batch C (fix plan 2026-09-15, C1) — sessions that survive a second device.
--
-- users.refresh_token and users.push_token are SINGLE slots. Every sign-in and
-- every refresh overwrites them (routes/api/auth.js, routes/api/admin.js), so
-- a second sign-in anywhere — another device, Command, an account merge —
-- silently invalidates the first device's refresh token, and its next refresh
-- returns REFRESH_REVOKED. This is live in production on the patient app
-- today. push_token has the same shape: a second device steals push.
--
-- One row per signed-in device. The refresh token is the row's identity: a
-- sign-in INSERTs a row, a refresh rotates the token INSIDE its row, a
-- sign-out revokes that row only. users.refresh_token / users.push_token stop
-- being authoritative at this deploy (the code keeps users.refresh_token as a
-- read-only fallback + rollback mirror for one transition window — see
-- services/user_sessions.js).
--
-- timestamptz throughout — new tables state their zone (migration 081's
-- lesson, same wording as 109).
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_sessions (
  id            text PRIMARY KEY,               -- 'sess-<uuid>' (JWT `sid` claim)
  user_id       text NOT NULL,
  refresh_token text NOT NULL,                  -- current refresh JWT for this device (rotated in place)
  push_token    text,                           -- this device's Expo push token, if registered
  client        text,                           -- 'patient_app' | 'command' | 'doctor_app' | 'legacy'
  device_id     text,                           -- client-supplied stable device identifier (optional)
  device_name   text,                           -- human label shown in future "your devices" UI (optional)
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at  timestamptz NOT NULL DEFAULT NOW(),
  revoked_at    timestamptz                     -- set = this device is signed out; row kept for audit
);

-- The refresh lookup is BY TOKEN (rotation check): must be unique or a token
-- could authenticate as two different sessions.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_sessions_refresh_token
  ON user_sessions (refresh_token);

-- Revoke-all-for-user (deactivate / reject / password change) and the push
-- fan-out ("send to every live device of this user") both scan by user.
CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions (user_id);

-- Seed: one 'legacy' session per user holding the current single-slot values,
-- so NOBODY is signed out by this deploy — the token a device already holds
-- keeps refreshing, now inside its own row. device_id 'legacy' is what the
-- sid-less-token fallbacks in the code target (an old access token carries no
-- `sid` claim; the only session it can belong to is this seeded one).
-- Idempotent: migrations run once (schema_migrations), and the unique
-- refresh_token index turns a re-run into a no-op anyway.
INSERT INTO user_sessions (id, user_id, refresh_token, push_token, client, device_id)
SELECT 'sess-legacy-' || u.id, u.id, u.refresh_token, u.push_token, 'legacy', 'legacy'
  FROM users u
 WHERE u.refresh_token IS NOT NULL
ON CONFLICT DO NOTHING;

-- Same RLS posture as every table created since 070 (worked example: 073) —
-- default-deny for anon/authenticated; the app connects as `postgres`
-- (rolbypassrls) and is unaffected. This table holds live credentials; it is
-- exactly the kind of table the lockdown exists for.
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
