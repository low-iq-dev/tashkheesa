-- ============================================================================
-- 113 — contact_submissions: a real destination for a real enquiry
--
-- WHAT WAS WRONG. POST /contact wrote every submission to error_logs with
-- category='contact_form', level='info'. That table is an error feed: there is
-- no status, no owner, no way to say "answered", and nobody reads it looking
-- for patients. 66 submissions accumulated there between 23 Aug and 20 Sep.
--
-- The cost is not hypothetical. A genuine enquiry from a patient in Poland,
-- submitted 30 July through the /coming-soon form, sat unanswered for eight
-- weeks for exactly this reason — it landed somewhere with no queue behind it.
-- Launch is 24 Sep with paid traffic pointed at the site, so the volume only
-- goes up from here.
--
-- WHAT THIS GIVES. One row per submission with a status you can filter on, a
-- spam verdict recorded at write time rather than guessed later, and an
-- answered_at/answered_by so "did anyone reply to this person" is a query
-- rather than an archaeology exercise.
--
-- error_logs is left alone. This is additive; nothing reads from it yet that
-- would break.
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_submissions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  subject       TEXT,
  message       TEXT NOT NULL,

  -- 'new' → nobody has looked. 'answered' → a human replied, and said so.
  -- 'spam' → caught by the honeypot or marked by hand. 'ignored' → seen and
  -- deliberately dropped, which is different from never seen at all.
  status        TEXT NOT NULL DEFAULT 'new',

  -- Recorded at write time by whatever caught it ('honeypot', 'own_domain',
  -- 'duplicate_burst'), so the reason survives and can be audited later.
  spam_reason   TEXT,

  source        TEXT NOT NULL DEFAULT 'contact_form',
  lang          TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  request_id    TEXT,

  answered_at   TIMESTAMPTZ,
  answered_by   TEXT,
  notes         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The query that matters is "what has nobody answered", oldest first.
CREATE INDEX IF NOT EXISTS contact_submissions_open_idx
  ON contact_submissions (created_at)
  WHERE status = 'new';

CREATE INDEX IF NOT EXISTS contact_submissions_email_idx
  ON contact_submissions (lower(email));

-- Same posture as every other table holding a member of the public's details.
ALTER TABLE contact_submissions ENABLE ROW LEVEL SECURITY;
