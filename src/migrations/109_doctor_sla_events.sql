-- 109_doctor_sla_events.sql
--
-- Batch B (fix plan 2026-09-15, B2) — re-home the SLA auto-pause counter.
--
-- The 10% reassignment token row ('earn-reassign-%' in doctor_earnings) was
-- doing two jobs: a payout amount (wrong — the decisions table says a
-- reassigned case earns the outgoing doctor ZERO) and the SLA-breach counter
-- services/doctor_pause.js drives auto-pause from (right, and load-bearing:
-- lose it and auto-pause silently stops working forever). Batch B deletes the
-- token writer, so the counter needs a home that is not the money ledger.
--
-- One row per reassignment-away event, written by
-- earnings_writer.markReassignedOnReassignment in the SAME transaction that
-- flips the doctor's main earnings row to 'reassigned' — i.e. exactly the
-- moment the old code wrote the token row, under the same guards, so the two
-- signals count the same events. `reason` carries the caller's reassignment
-- reason verbatim because doctor_pause.js's admin_manual exclusion
-- (operator-initiated reassignment is nobody's fault and must not pause a
-- good doctor) filters on it.
--
-- timestamptz, not the naive-UTC of doctor_earnings — new tables state their
-- zone (the naive columns are the reason Batch B exists; see migration 081).
CREATE TABLE IF NOT EXISTS doctor_sla_events (
  id         text PRIMARY KEY,
  doctor_id  text NOT NULL,
  order_id   text NOT NULL,
  reason     text NOT NULL DEFAULT 'sla_breach',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- The pause counter's exact shape: per-doctor count over a rolling window.
CREATE INDEX IF NOT EXISTS idx_doctor_sla_events_doctor_created
  ON doctor_sla_events (doctor_id, created_at);

-- Backfill from the token rows that exist at cutover, so a doctor's 3-in-30
-- count is identical the moment doctor_pause.js switches sources. The token
-- row's id is reused as the event id, which also makes this INSERT idempotent
-- across re-boots (migrations run on every Render deploy). created_at is
-- naive-UTC on doctor_earnings (migration 004): state the zone before storing
-- into a timestamptz column. Production holds at most one such row (the
-- marketing-demo residue Batch B3 corrects) — if B3's delete lands first this
-- seeds nothing, and either way the demo row's 2026-08-25 stamp is already
-- outside every realistic pause window.
INSERT INTO doctor_sla_events (id, doctor_id, order_id, reason, created_at)
SELECT de.id,
       de.doctor_id,
       de.appointment_id,           -- main/token rows overload this with the order id
       COALESCE(de.reassignment_reason, 'sla_breach'),
       de.created_at AT TIME ZONE 'UTC'
  FROM doctor_earnings de
 WHERE de.id LIKE 'earn-reassign-%'
   AND de.status = 'reassigned'
ON CONFLICT (id) DO NOTHING;
