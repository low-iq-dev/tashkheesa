-- 111_appearance_and_doctor_phrases.sql
-- ============================================================================
-- Batch C (fix plan 2026-09-15, C4) — two small columns for the doctor app.
-- Both additive; nothing reads them until the /api/v1/doctor surface lands.
--
-- 1. users.appearance_preference — the doctor's theme (dark / daylight),
--    following them across devices. The app's more/appearance screen drives
--    it (values it sends: 'dark' | 'light' | 'system'; the audit's G9).
--    No CHECK constraint — orders.status set the precedent that value
--    vocabularies live in code, and the doctor-API write path allowlists.
--
-- 2. doctor_phrases — the per-doctor phrase library behind the report
--    composer's saved phrases (app screen case/[id]/report/snippets).
--    Column shapes mirror the app's DbPhrase type verbatim so the API can
--    serialize rows without a mapping layer: text_en / text_ar / category /
--    times_used.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS appearance_preference text;

CREATE TABLE IF NOT EXISTS doctor_phrases (
  id         text PRIMARY KEY,                  -- 'phrase-<uuid>'
  doctor_id  text NOT NULL,
  text_en    text NOT NULL,
  text_ar    text,
  category   text NOT NULL DEFAULT 'mine',      -- app vocabulary: mine | <specialty buckets> | closing
  times_used integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- The snippets screen lists one doctor's phrases; nothing else reads this.
CREATE INDEX IF NOT EXISTS idx_doctor_phrases_doctor
  ON doctor_phrases (doctor_id);

-- Same RLS posture as every table created since 070 (worked example: 073) —
-- default-deny for anon/authenticated; the owner-role app is unaffected.
ALTER TABLE doctor_phrases ENABLE ROW LEVEL SECURITY;
