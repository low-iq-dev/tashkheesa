-- ============================================================================
-- 133 — coverage_leads: "we don't open this specialty yet — tell me when you do"
--
-- 2 Nov 2026 (patient recovery, Part C). A patient whose case needs a specialty
-- we do not show (spec-neurology: hidden, 11 priced services, no doctor) used
-- to see nothing that fit and leave. They can now leave a lead instead
-- (services/coverage_leads.js), from the web wizard's specialty step or the
-- draft API. The draft is kept, not cancelled, so the lead can come back to it;
-- a draft with a lead gets no draft-resume nudge (services/draft_nudges.js).
--
--   patient_id / order_id   who, and the draft they were on (nullable: a lead
--                           can exist without a draft)
--   phone                   the account's phone when the lead was left — the
--                           patient taps once; nothing is typed
--   wanted_specialty_id     a specialties.id (hidden ones included), or NULL
--                           for "my specialty is not listed"
--   wanted_text             what the patient typed, when they typed something
--   lang                    'ar' | 'en' — the language to tell them in
--   source                  'web' | 'api' | 'classifier'
--   notified_at             set when "Notify waiting leads" told them
--   converted_order_id      the case they then sent
--
-- One lead per draft (the partial unique index). RLS on, no policies, as for
-- every table the app owns. Safe to run twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS coverage_leads (
  id                   TEXT        PRIMARY KEY,
  patient_id           TEXT        NOT NULL,
  order_id             TEXT,
  phone                TEXT,
  wanted_specialty_id  TEXT,
  wanted_text          TEXT,
  lang                 TEXT        NOT NULL DEFAULT 'en',
  source               TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at          TIMESTAMPTZ,
  converted_order_id   TEXT,
  CONSTRAINT coverage_leads_source_chk CHECK (source IN ('web', 'api', 'classifier')),
  CONSTRAINT coverage_leads_lang_chk CHECK (lang IN ('ar', 'en'))
);

CREATE UNIQUE INDEX IF NOT EXISTS coverage_leads_order_uniq ON coverage_leads (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coverage_leads_waiting_idx ON coverage_leads (wanted_specialty_id) WHERE notified_at IS NULL;

ALTER TABLE coverage_leads ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE coverage_leads IS
  'Patients waiting for a specialty we do not open yet (patient recovery Part C, 2 Nov 2026). '
  'One per draft. Told once, by a superadmin action, when the specialty opens.';
