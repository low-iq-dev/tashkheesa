-- ============================================================================
-- 127 — ops_checks / ops_check_history: the check registry
--
-- 6 Oct 2026 (watchtower). One row per named check, whoever wrote it:
--   source 'portal'  the in-process system_checks worker (every 5 minutes)
--   source 'api'     POST /api/v1/ops/checks (bearer OPS_CHECKS_KEY)
--   source 'claude'  a scheduled Claude run writing the row directly by SQL
--
-- All three are pushed the same way, because the push decision is NOT made by
-- the writer. The system_checks worker compares `status` to `pushed_status`
-- and pushes on a difference, then sets pushed_status. A writer therefore
-- never touches pushed_status, pushed_at, stale_pushed or brief_pushed_at —
-- those four columns belong to the worker.
--
--   expected_every_seconds   how often the writer promises to report. A check
--                            is STALE when now - checked_at exceeds twice this.
--   stale_pushed             the worker has already said this check went quiet.
--   brief_pushed_at          for claude.brief.* rows: the checked_at of the
--                            write that was last pushed, so every new write of
--                            a brief pushes exactly once.
--
-- History is written by a trigger so a row inserted by plain SQL is recorded
-- exactly like a posted one. It records a line when a check first appears and
-- whenever its status or summary changes — not on every identical 5-minute
-- heartbeat, which would be ~3,000 rows a day saying nothing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ops_checks (
  check_key              text        PRIMARY KEY,
  area                   text        NOT NULL,
  status                 text        NOT NULL,
  summary                text,
  detail                 jsonb,
  checked_at             timestamptz NOT NULL DEFAULT NOW(),
  expected_every_seconds integer     NOT NULL DEFAULT 86400,
  source                 text        NOT NULL DEFAULT 'api',
  updated_at             timestamptz NOT NULL DEFAULT NOW(),
  pushed_status          text,
  pushed_at              timestamptz,
  stale_pushed           boolean     NOT NULL DEFAULT false,
  brief_pushed_at        timestamptz
);

CREATE TABLE IF NOT EXISTS ops_check_history (
  check_key  text        NOT NULL,
  status     text        NOT NULL,
  summary    text,
  checked_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ops_check_history_key_idx
  ON ops_check_history (check_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS ops_check_history_checked_at_idx
  ON ops_check_history (checked_at);

ALTER TABLE ops_checks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_check_history ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION ops_checks_record_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.summary IS DISTINCT FROM OLD.summary THEN
    INSERT INTO ops_check_history (check_key, status, summary, checked_at)
    VALUES (NEW.check_key, NEW.status, NEW.summary, COALESCE(NEW.checked_at, NOW()));
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ops_checks_history_trg ON ops_checks;
CREATE TRIGGER ops_checks_history_trg
  AFTER INSERT OR UPDATE ON ops_checks
  FOR EACH ROW EXECUTE FUNCTION ops_checks_record_history();
