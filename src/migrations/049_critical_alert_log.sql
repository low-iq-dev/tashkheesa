-- 049_critical_alert_log.sql
-- Theme 8 Phase 7 (OQ-6) — DB-backed critical-alert log + throttle.
--
-- Pre-fix: sendCriticalAlert in src/critical-alert.js used an in-memory
-- `lastSentAt` variable to throttle WhatsApp alerts to 1 per 5 minutes.
-- Two failure modes:
--   1. Multi-dyno scale-out — each dyno has its own counter, so a
--      flapping crash would fire N alerts per 5min where N = dyno count.
--   2. Restart-induced reset — every process.exit(1) (from
--      unhandledRejection) wipes the throttle. A fast crash loop fires
--      one WhatsApp PER crash, burning through Meta rate limits.
--
-- DB-backed survives both. Plus the table itself doubles as the
-- delivery-health audit trail surfaced on Widget 5 — operators see when
-- the last critical alert was sent and whether Meta accepted it.

CREATE TABLE IF NOT EXISTS critical_alert_log (
  id          BIGSERIAL PRIMARY KEY,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_key   TEXT NOT NULL,        -- throttle key (e.g. 'unhandled_rejection', 'error_rate_5x')
  status_code INTEGER,              -- HTTP status from Meta WhatsApp API (200 ok, 4xx/5xx fail; NULL = pre-send guard)
  error       TEXT,                 -- response body excerpt or local error message (truncated)
  message     TEXT                  -- alert message text (audit trail)
);

CREATE INDEX IF NOT EXISTS idx_critical_alert_log_sent_at
  ON critical_alert_log (sent_at DESC);

-- Throttle lookup pattern is `SELECT 1 ... WHERE alert_key=$1 AND sent_at > NOW() - INTERVAL '5 min'`.
-- Composite index on (alert_key, sent_at DESC) makes that LIMIT 1 a single index seek.
CREATE INDEX IF NOT EXISTS idx_critical_alert_log_alert_key
  ON critical_alert_log (alert_key, sent_at DESC);
