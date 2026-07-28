-- 075_payment_event_reviews.sql
-- ============================================================================
-- Overlay table for the Command amount-mismatch triage queue (Batch 1).
--
-- payment_events is an APPEND-ONLY log — immutable facts written by the Paymob
-- webhook. A review is a MUTABLE operator annotation, so it lives in its OWN
-- table rather than mutating the event row. One review per event
-- (payment_event_id UNIQUE); the review endpoint UPSERTs on that key so a
-- re-review updates note + reviewed_at in place.
--
-- Deliberately NO status machine: the triage is read-only + a "reviewed" flag.
-- Resolution actions (refund / mark-paid) happen via deep-link to the case,
-- where those flows already live. See docs/COMMAND_APP_PHASE0_AUDIT.md.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, and the migration runner records this
-- file once in schema_migrations. Guarded on payment_events existing so a
-- fresh/local DB that has not created it yet still boots (mirrors migration
-- 074's table-existence guard).
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payment_events'
  ) THEN
    CREATE TABLE IF NOT EXISTS payment_event_reviews (
      id                TEXT PRIMARY KEY,
      payment_event_id  TEXT NOT NULL UNIQUE
                          REFERENCES payment_events(id) ON DELETE CASCADE,
      reviewed_by       TEXT,
      reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note              TEXT
    );
  END IF;
END $$;
