-- 042_paymob_intentions.sql
--
-- P1-PAY-1: Add Paymob Unified Intention API support to orders + a
-- dedicated payment_events audit table. Drop the unused legacy
-- `payments` table.
--
-- Why this shape:
--   - orders gets the WINNING transaction id (one per paid order).
--     UNIQUE-where-not-null guards against the same Paymob transaction
--     ever attaching to two orders (sanity, not the primary idempotency).
--   - payment_events is the authoritative log of every Paymob signal:
--     intention_created, intention_failed, webhook_received, hmac_failure,
--     payment_succeeded, payment_failed. UNIQUE on paymob_transaction_id
--     is the per-transaction idempotency guard for the webhook handler.
--   - The legacy `payments` table is empty in dev and has never been
--     written to in current code. Conceptually overlaps with the new
--     payment_events table but doesn't fit its schema. Drop guarded:
--     refuse and abort if any rows exist (paranoia against unknown prod
--     data; if it fires, that's a signal to investigate before re-running).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS paymob_intention_id    text,
  ADD COLUMN IF NOT EXISTS paymob_transaction_id  text,
  ADD COLUMN IF NOT EXISTS hmac_verified_at       timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_paymob_transaction_id
  ON orders(paymob_transaction_id) WHERE paymob_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_events (
  id                       text PRIMARY KEY,
  order_id                 text NULL,
  paymob_transaction_id    text NULL,
  paymob_intention_id      text NULL,
  event_type               text NOT NULL,
  payload_json             jsonb NOT NULL,
  hmac_verified            boolean NULL,
  received_at              timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_paymob_txn_id
  ON payment_events(paymob_transaction_id) WHERE paymob_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_events_received_at
  ON payment_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_events_event_type
  ON payment_events(event_type);

-- Guarded drop of the unused legacy `payments` table.
-- The guard catches the case where prod has rows we didn't know about —
-- the migration aborts loudly (RAISE EXCEPTION) rather than silently
-- destroying data. If you see this exception fire on prod, do not edit
-- and re-run; investigate the rows first.
DO $$
DECLARE
  legacy_row_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payments'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM payments' INTO legacy_row_count;
    IF legacy_row_count > 0 THEN
      RAISE EXCEPTION
        'Migration 042 refused: legacy payments table has % rows. Investigate before re-running.',
        legacy_row_count;
    END IF;
    DROP TABLE payments;
  END IF;
END $$;
