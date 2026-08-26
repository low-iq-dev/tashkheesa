-- Tombstones for erased accounts.
--
-- WHY. The web session cookie is a 7-day JWT and src/middleware.js builds
-- req.user from verify(token) with NO database lookup — a deliberate choice
-- (Phase 3 FIX #12) to avoid a query per request. That is fine while accounts
-- only ever appear. It stops being fine now that they can be erased: a patient
-- who deletes their account on a laptop leaves a phone signed in for up to a
-- week, and that stale session can still POST — creating an order whose
-- patient_id points at a user row that no longer exists. There are zero
-- foreign keys onto users.id, so nothing in the database would object.
--
-- A tombstone is the cheapest fix that works across Render instances. The set
-- is tiny and read as a whole into a short-TTL cache, so it costs one small
-- query per instance per minute rather than one per request.
--
-- It is also the audit record that we honoured an erasure request, which PDPL
-- Article 2(e) makes worth keeping on its own. It stores an id and a timestamp
-- and nothing else: no name, no email, no phone. A bare identifier for a
-- person whose data is gone is not personal data — there is nothing left to
-- join it to.
CREATE TABLE IF NOT EXISTS deleted_users (
  user_id    TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role       TEXT,
  source     TEXT
);

CREATE INDEX IF NOT EXISTS idx_deleted_users_deleted_at ON deleted_users(deleted_at);
