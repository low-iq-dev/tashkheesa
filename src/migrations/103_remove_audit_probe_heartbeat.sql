-- 103_remove_audit_probe_heartbeat.sql
--
-- Cleanup of a row I put there. On 2026-08-29 an audit demonstrated that
-- /ops/agent/ping accepts an unauthenticated write by sending one, which left
-- a real row in a real table:
--
--   id         hb-1787998216540-kbiyki
--   agent_name __audit_probe_readonly
--   status     idle
--   pinged_at  2026-08-29 10:10:16
--
-- It is inert — nothing reads agent_name for control flow — but it appears in
-- the superadmin agent list as a phantom agent, and a row nobody can account
-- for is the kind of thing that costs an hour during an incident.
--
-- Deleted here rather than by hand in the SQL console so there is a reviewed,
-- replayable record of what was written and what removed it. Matched on the
-- exact id, so it cannot touch a real heartbeat even if an operator later
-- names an agent something similar.
--
-- NOT fixed here: /ops/agent/ping still accepts unauthenticated writes. That is
-- the actual finding and it is still open — this only clears the evidence I
-- left behind, and deliberately does not disguise it.

BEGIN;

DELETE FROM agent_heartbeats
 WHERE id = 'hb-1787998216540-kbiyki'
   AND agent_name = '__audit_probe_readonly';

DO $$
DECLARE
  probes INT;
BEGIN
  SELECT COUNT(*) INTO probes
    FROM agent_heartbeats
   WHERE agent_name LIKE '\_\_audit%' OR agent_name LIKE '\_\_probe%';
  IF probes > 0 THEN
    RAISE WARNING 'Migration 103: % audit-probe heartbeat row(s) remain', probes;
  END IF;
END $$;

COMMIT;
