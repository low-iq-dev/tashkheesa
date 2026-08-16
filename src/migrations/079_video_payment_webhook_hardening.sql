-- 079_video_payment_webhook_hardening.sql
--
-- AUDIT-P0-6 (audit 2026-08-16, finding C2).
--
-- POST /portal/video/payment/callback verified the Paymob HMAC and then read
-- `payment_id` and `status` — NEITHER of which is in the HMAC subject (see
-- src/paymob-hmac.js HMAC_FIELDS). It also had:
--   * no amount verification at all, and
--   * no per-transaction idempotency (unlike /payments/callback, which is
--     protected by the unique partial index on
--     payment_events.paymob_transaction_id from 042).
--
-- One captured (hmac, 19 signed fields) pair — obtainable from any Paymob
-- redirect for any of the attacker's own transactions, successful or not —
-- could therefore be replayed indefinitely against freshly created
-- appointment ids to obtain unlimited free video consultations.
--
-- These columns give the route the same per-transaction idempotency guarantee
-- the main payment webhook already has. Both are nullable so historical rows
-- are unaffected, and the unique index is partial so NULLs don't collide.

ALTER TABLE appointment_payments
  ADD COLUMN IF NOT EXISTS paymob_transaction_id text,
  ADD COLUMN IF NOT EXISTS paymob_intention_id   text,
  ADD COLUMN IF NOT EXISTS hmac_verified_at      timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_appointment_payments_paymob_txn
  ON appointment_payments (paymob_transaction_id)
  WHERE paymob_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointment_payments_status
  ON appointment_payments (status);
