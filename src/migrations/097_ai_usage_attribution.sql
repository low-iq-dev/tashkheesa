-- Migration 097: make agent_token_log answer "where are my API credits going".
--
-- WHAT WAS ALREADY THERE. agent_token_log has existed since the ops dashboard
-- was built: id, agent_name, tokens_used, cost_usd, task_label, logged_at.
-- There is a reader (routes/ops.js) and a writer (an ops endpoint), and the
-- table is EMPTY in production. Not one of the six real Anthropic call sites
-- ever wrote a row. The credits were being spent; nothing recorded on what.
--
-- ── Why new columns rather than reusing agent_name ──────────────────────────
--
-- agent_name is free text written by hand from an ops endpoint. It is the
-- module's name when anyone bothered, and it is the wrong axis anyway: the
-- question is not "which file called Anthropic", it is "which FEATURE is
-- eating the budget". Those differ — the specialty classifier is called from
-- the website intake AND from the app's order wizard, and those are two
-- different spending decisions.
--
-- So: `purpose` is the business axis (order_wizard, marketing, ...), and it is
-- written from a fixed vocabulary in services/ai_usage.js rather than typed.
-- agent_name is left alone and kept in step with purpose by the new writer, so
-- the existing ops reader keeps working unchanged.
--
-- `model`, `input_tokens`, `output_tokens` exist because cost_usd alone cannot
-- be re-derived when prices change. Tokens are the exact fact Anthropic
-- reports; the dollar figure is our own estimate from a local price table. Keep
-- the fact, and the estimate can be recomputed later. Keep only the estimate,
-- and a price change silently rewrites history.
--
-- ── Nullable on purpose ────────────────────────────────────────────────────
--
-- Every column here is nullable with no default. The table is empty today, so
-- there is nothing to backfill, but a deploy is not atomic: for the minutes
-- between this migration and the new code, the OLD writer is still live and
-- inserts rows without these columns. NOT NULL would turn that window into
-- failed inserts on a path that must never throw. The reader coalesces.

ALTER TABLE agent_token_log ADD COLUMN IF NOT EXISTS purpose       TEXT;
ALTER TABLE agent_token_log ADD COLUMN IF NOT EXISTS model         TEXT;
ALTER TABLE agent_token_log ADD COLUMN IF NOT EXISTS input_tokens  INTEGER;
ALTER TABLE agent_token_log ADD COLUMN IF NOT EXISTS output_tokens INTEGER;

-- Every read of this table is "the last N days, grouped by purpose". The window
-- is the selective half — one index on logged_at is enough, and a composite
-- would only pay off at a row count this table will not reach for years.
CREATE INDEX IF NOT EXISTS idx_agent_token_log_logged_at
  ON agent_token_log (logged_at DESC);
