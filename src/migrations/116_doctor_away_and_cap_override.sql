-- 116_doctor_away_and_cap_override.sql
-- ============================================================================
-- Doctor app availability (fix plan 2026-09-15, follow-up to 111) — three
-- additive pieces for the /api/v1/doctor/availability and /profile surface.
-- Nothing reads them until routes/api/doctor_me.js and the SLA sweep land.
--
-- 1. doctor_away_periods — the doctor's scheduled leave. NOT a second
--    availability flag: the platform already has ONE mechanism every routing
--    path respects (users.is_paused / paused_at / pause_reason — the accept
--    gate, eligibleDoctorClause in the pool and broadcast SQL, auto_assign).
--    An away period is a self-pause with dates: services/doctor_pause.js
--    applyDoctorAwayPeriods (run by the 5-minute SLA sweep) flips is_paused
--    with pause_reason='doctor_away' while a period contains the Cairo
--    calendar day, and lifts ONLY that reason when none does. Dates are
--    calendar dates (Africa/Cairo), inclusive on both ends. A period is
--    cancelled, never deleted, so "was the doctor on leave that week" stays
--    answerable.
--
-- 2. users.doctor_max_active_override — the doctor's own cap. It can only
--    LOWER the platform's max_active_cases: doctor_eligibility.capFor takes
--    the minimum of the two, so ops still set the ceiling and the doctor
--    chooses to hold fewer. NULL / 0 = no override. Applied to whichever
--    platform cap the order's tier selects (standard or urgent) — the doctor
--    is saying "no more than N open cases", not tuning a tier.
--
-- 3. users.payout_method / payout_handle — how the doctor is paid, set by ops
--    (the earnings statements already name cash / InstaPay / Shifa finance;
--    this records which one per doctor and the handle to pay to). Read-only
--    from the app. No CHECK constraint — vocabularies live in code
--    ('instapay' | 'cash' | 'shifa_finance' | 'bank'), as 111 did.
-- ============================================================================

CREATE TABLE IF NOT EXISTS doctor_away_periods (
  id           text PRIMARY KEY,                  -- 'away-<uuid>'
  doctor_id    text NOT NULL,
  from_date    date NOT NULL,                     -- Cairo calendar day, inclusive
  to_date      date NOT NULL,                     -- Cairo calendar day, inclusive
  note         text,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  cancelled_at timestamptz
);

-- The sweep asks "which uncancelled periods are still current" and the app
-- lists one doctor's upcoming periods; both filter on doctor and to_date.
CREATE INDEX IF NOT EXISTS idx_doctor_away_periods_doctor_to
  ON doctor_away_periods (doctor_id, to_date);

-- Same RLS posture as every table created since 070 (worked example: 073) —
-- default-deny for anon/authenticated; the owner-role app is unaffected.
ALTER TABLE doctor_away_periods ENABLE ROW LEVEL SECURITY;

ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_max_active_override integer;

ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_method text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_handle text;
