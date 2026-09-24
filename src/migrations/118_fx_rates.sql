-- ============================================================================
-- 118 — fx_rates: the EGP charge for international patients, kept current
--
-- src/fx.js held a hand-maintained RATES_TO_EGP table "as of 2026-07-29,
-- UPDATE MONTHLY". It sets the real EGP amount an international patient is
-- charged (their local list price × rate), and nothing reminded anyone to
-- update it. A daily pg-boss job (job_queue.js 'fx-rates-pull') now fetches
-- https://open.er-api.com/v6/latest/EGP (free, keyless) and upserts here;
-- fx.js reads this table and falls back to its hardcoded copy only when the
-- table is empty.
--
-- One row per currency pair. Convention, identical to fx.js RATES_TO_EGP:
--   base  = the foreign currency (USD, GBP, …)
--   quote = 'EGP'
--   rate  = how many EGP one unit of `base` buys  (USD → ~50.5)
-- The API answers the other way round (1 EGP = 0.0198 USD); the job inverts.
--
-- SEEDED with the exact hardcoded values and their real date, so charges are
-- byte-identical until the first successful pull. fetched_at is the truth —
-- 2026-07-29 — not NOW(): if the first pull fails, the 7-day staleness alert
-- must fire, because the rates really are that old.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fx_rates (
  base        TEXT        NOT NULL,
  quote       TEXT        NOT NULL,
  rate        NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  fetched_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (base, quote)
);

INSERT INTO fx_rates (base, quote, rate, fetched_at) VALUES
  ('USD', 'EGP',  50.5,  '2026-07-29T00:00:00Z'),
  ('GBP', 'EGP',  68.7,  '2026-07-29T00:00:00Z'),
  ('AED', 'EGP',  13.75, '2026-07-29T00:00:00Z'),
  ('SAR', 'EGP',  13.47, '2026-07-29T00:00:00Z'),
  ('QAR', 'EGP',  13.87, '2026-07-29T00:00:00Z'),
  ('KWD', 'EGP', 165.8,  '2026-07-29T00:00:00Z'),
  ('BHD', 'EGP', 134.3,  '2026-07-29T00:00:00Z'),
  ('OMR', 'EGP', 131.3,  '2026-07-29T00:00:00Z')
ON CONFLICT (base, quote) DO NOTHING;

-- Per-table RLS opt-in that 073's worked example mandates for every table born
-- after 070: ENABLE with no policies and no FORCE = default-deny for anon /
-- authenticated; the app connects as a rolbypassrls role and is unaffected.
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
