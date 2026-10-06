-- ============================================================================
-- 124 — critical_alert_log: record whether the alert reached a phone
--
-- 6 Oct 2026 (watchtower). status_code / error have always described the
-- WhatsApp attempt and nothing else. The Command push — the one channel that
-- kept working through the August outage — fired from sendCriticalAlert with
-- no record of whether Expo accepted it, so "was anyone told" could not be
-- answered from this table.
--
-- Push is now the primary transport. `delivered` is true only when Expo
-- accepted at least one push ticket for the alert; `push_error` carries the
-- reason when it did not. status_code / error keep their meaning (WhatsApp,
-- the optional second transport) so the /ops widget that reads them is
-- unchanged. NULL `delivered` = a row written before this migration.
-- ============================================================================

ALTER TABLE critical_alert_log ADD COLUMN IF NOT EXISTS delivered      boolean;
ALTER TABLE critical_alert_log ADD COLUMN IF NOT EXISTS push_attempted integer;
ALTER TABLE critical_alert_log ADD COLUMN IF NOT EXISTS push_accepted  integer;
ALTER TABLE critical_alert_log ADD COLUMN IF NOT EXISTS push_error     text;
