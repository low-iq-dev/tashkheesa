-- ============================================================================
-- 125 — attention_state: what a human has done about a v_needs_attention row
--
-- 6 Oct 2026 (watchtower). v_needs_attention is deliberately a view with no
-- state: a thing is waiting because of its own row. That stays true. This
-- table holds only what the view cannot know — that somebody has seen an item
-- (ack), asked not to hear about it for a while (snooze), or dealt with it
-- outside the system (resolve) — plus the sweep's own escalation clock.
--
-- Keyed on the view's (kind, ref). No foreign key: refs point into six
-- different tables.
--
--   acked_at / acked_by        "I have seen this". Stops repeat pushes; the
--                              item stays on the list.
--   snoozed_until              off the list until this instant.
--   resolved_at / resolved_by  off the list for 24 hours. If the underlying
--                              condition is still true after that, the item
--                              comes back — a resolve is a claim, not a fact.
--   note                       free text from the resolve.
--   first_seen_at              when the sweep first saw this episode. It is
--                              the age of kinds that have no timestamp of
--                              their own (specialty_uncovered).
--   last_seen_at               stamped by every sweep while the item is in the
--                              view; a gap means the condition cleared, so the
--                              next appearance is a new episode.
--   last_pushed_at, push_count the escalation clock (services/needs_attention).
-- ============================================================================

CREATE TABLE IF NOT EXISTS attention_state (
  kind           text        NOT NULL,
  ref            text        NOT NULL,
  acked_at       timestamptz,
  acked_by       text,
  snoozed_until  timestamptz,
  resolved_at    timestamptz,
  resolved_by    text,
  note           text,
  first_seen_at  timestamptz,
  last_seen_at   timestamptz,
  last_pushed_at timestamptz,
  push_count     integer     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, ref)
);

ALTER TABLE attention_state ENABLE ROW LEVEL SECURITY;
