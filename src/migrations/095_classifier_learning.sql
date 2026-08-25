-- Migration 095: the classifier learning loop.
--
-- WHAT WAS ALREADY THERE. specialty_classification_overrides has been recording
-- what the AI picked against what a human actually picked — specialty and
-- service, with the AI's confidence — since migration 056/058. It is written
-- from three places: the patient wizard (routes/patient.js), admin triage
-- (routes/api/admin.js) and superadmin (routes/superadmin.js).
--
-- Nothing has ever read it back. Thousands of labelled corrections, feeding
-- nothing.
--
-- ── Two things this adds ────────────────────────────────────────────────────
--
-- 1. actor_role on the overrides table.
--
--    The three writers are indistinguishable in the data. That matters more
--    than it sounds, because a PATIENT override is a noisy label: the patients
--    most likely to override the suggestion are precisely the ones least sure
--    what specialty they need. Treating "a patient disagreed" as ground truth
--    would teach the model the confusion rather than the correction.
--
--    An operator or doctor reassignment is a different thing entirely — that is
--    a clinician looking at the case. So the aggregation weights them
--    differently, and it cannot do that without knowing who wrote the row.
--
--    Existing rows are backfilled to 'patient', which is the conservative
--    direction: the aggregation discounts patient rows, so mislabelling an
--    operator row as a patient one under-counts a real signal rather than
--    inventing one.
--
-- 2. classifier_corrections — the reviewed output.
--
--    Aggregated (AI pick -> human pick) pairs that recur often enough and
--    consistently enough to be worth acting on. Nothing here steers the model
--    until a human sets status='accepted'; candidates are just a queue.
--
--    Deliberately NOT fine-tuning. Accepted rows are rendered into the
--    classifier's user message as a short "known corrections" block: cheap,
--    inspectable, and revertible in one click. A fine-tune would be none of
--    those, and would bury the reason a case routes the way it does inside
--    weights nobody can read.

BEGIN;

-- ── 1. Who made the correction ──────────────────────────────────────────────
ALTER TABLE specialty_classification_overrides
  ADD COLUMN IF NOT EXISTS actor_role TEXT;

-- Conservative backfill: everything historical is treated as the low-weight
-- patient signal. See the note above on why this direction is the safe one.
UPDATE specialty_classification_overrides
   SET actor_role = 'patient'
 WHERE actor_role IS NULL;

-- ── 2. The reviewed corrections ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS classifier_corrections (
  id                  TEXT PRIMARY KEY,

  -- The pair. from_* is what the AI said, to_* is what humans keep changing it
  -- to. Service is nullable because a correction can be specialty-level only.
  from_specialty_id   TEXT NOT NULL,
  to_specialty_id     TEXT NOT NULL,
  from_service_id     TEXT,
  to_service_id       TEXT,

  -- Evidence, kept so a reviewer can judge rather than just trust.
  occurrences         INTEGER      NOT NULL DEFAULT 0,
  weighted_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Of every case the AI routed to from_specialty_id that a human then
  -- changed, the share that went to THIS to_specialty_id. A pair that recurs
  -- 20 times but only represents 15% of that specialty's corrections is noise;
  -- one that represents 85% is a rule.
  consistency         DOUBLE PRECISION NOT NULL DEFAULT 0,
  sample_case_ids     JSONB,

  -- candidate → accepted (steers the model) | rejected (never offered again)
  status              TEXT         NOT NULL DEFAULT 'candidate',
  reviewed_by         TEXT,
  reviewed_at         TIMESTAMP,
  review_note         TEXT,

  first_seen_at       TIMESTAMP,
  last_seen_at        TIMESTAMP,
  created_at          TIMESTAMP    DEFAULT NOW(),
  updated_at          TIMESTAMP    DEFAULT NOW()
);

-- One row per pair. The aggregation upserts on this, so re-running the job is
-- idempotent and a reviewer's decision survives the next run — a rejected pair
-- must never quietly come back as a fresh candidate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classifier_corrections_pair
  ON classifier_corrections (
    from_specialty_id,
    to_specialty_id,
    COALESCE(from_service_id, ''),
    COALESCE(to_service_id, '')
  );

-- The read path: accepted rows, best evidence first, on every classification.
CREATE INDEX IF NOT EXISTS idx_classifier_corrections_accepted
  ON classifier_corrections (status, weighted_score DESC)
  WHERE status = 'accepted';

-- The aggregation scans overrides by date; the review screen scans by case.
CREATE INDEX IF NOT EXISTS idx_specialty_classification_overrides_at
  ON specialty_classification_overrides (override_at DESC);

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
--
-- Default-deny, matching migration 070. The app connects as `postgres`
-- (rolbypassrls=true) and is unaffected; the roles RLS constrains — anon and
-- authenticated — get zero rows.
--
-- 070's array is deliberately NOT extended for new tables (see the
-- AUDIT-070-EXEMPTION-1 note in that file: doing so would turn it into an
-- allowlist for the exact drift its own guard exists to catch). A new public
-- table enables RLS in its OWN migration instead, which is this.
--
-- classifier_corrections holds no patient data, but it does hold the rules that
-- decide where cases get routed. Leaving it readable through the Data API would
-- be handing out the routing logic and, worse, leaving a table that steers
-- clinical triage sitting outside the lockdown everything else is inside.
ALTER TABLE classifier_corrections ENABLE ROW LEVEL SECURITY;

COMMIT;
