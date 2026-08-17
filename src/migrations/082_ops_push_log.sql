-- 082_ops_push_log.sql
-- AUDIT 2026-08-17 — durable log + throttle for operator business-event pushes.
--
-- The Command app has full Expo push infrastructure: middleware/push.js's
-- notifySuperadmins works, POST /api/v1/admin/push-token registers and revokes
-- device tokens, and the app handles the payload. It was wired to exactly ONE
-- producer: services/worker_watchdog.js telling the founder a background worker
-- had stopped heartbeating.
--
-- Nothing pushed for anything that happens to the BUSINESS. An urgent case that
-- nobody accepted inside its 15-minute window, a refund request, a payment whose
-- amount did not match what was owed, a doctor application, a doctor hitting the
-- automatic pause threshold — all of these were discoverable only by opening the
-- app and looking. Which means a 4-hour urgent case that went unaccepted at 2am
-- was found at 9am.
--
-- This table is the throttle and the audit trail for those pushes.
--
-- WHY A TABLE AND NOT AN IN-MEMORY MAP. The same two failure modes that forced
-- critical_alert_log (migration 049) apply here verbatim:
--   1. The web service runs multiple instances. An in-memory throttle is
--      per-instance, so N instances send N copies of the same alert.
--   2. Any restart wipes an in-memory throttle, so a crash loop re-alarms on
--      every boot.
-- A row in Postgres survives both, and the claim below is atomic, so two
-- instances racing on the same event cannot both win.

CREATE TABLE IF NOT EXISTS ops_push_log (
  id          BIGSERIAL PRIMARY KEY,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Throttle + dedupe key. Two shapes are used deliberately:
  --   'kind:<entity id>'  — dedupe a specific thing, e.g.
  --                         'urgent_unaccepted:ord_123'. Fires once per case.
  --   'kind:<yyyy-mm-dd>' — dedupe per day, e.g. 'sla_breach_first:2026-08-17'.
  --                         The "first breach of the day" alert.
  event_key   TEXT NOT NULL,
  -- The event class, without the entity suffix, so the ops surfaces can group.
  kind        TEXT NOT NULL,
  title       TEXT,
  body        TEXT,
  order_id    TEXT,
  -- Recipients reached. 0 is meaningful: it means the event fired but no
  -- superadmin had a registered device, which is itself worth seeing.
  sent_count  INTEGER
);

-- The claim query filters on event_key within a recent window and orders by
-- sent_at, so this index is the one that matters.
CREATE INDEX IF NOT EXISTS idx_ops_push_log_event_key
  ON ops_push_log (event_key, sent_at DESC);

-- For the "what has this thing been telling me lately" read.
CREATE INDEX IF NOT EXISTS idx_ops_push_log_sent_at
  ON ops_push_log (sent_at DESC);
