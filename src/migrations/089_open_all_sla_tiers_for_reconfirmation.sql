-- 089_open_all_sla_tiers_for_reconfirmation.sql
-- ============================================================================
-- 2026-08-24 — open every tier to every doctor, then ask them to confirm.
--
-- After 086 fixed the vocabulary, the coverage picture was:
--
--     Orthopedics        VIP 1   Urgent 1
--     Cardiology         VIP 0   Urgent 0
--     Urology            VIP 0   Urgent 0
--     Internal Medicine  VIP 0   Urgent 0
--     OB/GYN             VIP 0   Urgent 0
--     Radiology          VIP 0   Urgent 0
--
-- 25 of 31 doctors sat at ["standard"] alone. That is almost certainly not a
-- considered choice: the tier checkboxes appear once, on the signup form, with
-- Standard pre-ticked and the other two blank — and there has never been
-- ANYWHERE in the doctor portal to change them afterwards (grep
-- sla_tiers_supported across src/views: signup only). So the default became
-- the answer, permanently, and the platform sells an 18-hour tier one doctor
-- can serve and a 4-hour tier one doctor can serve.
--
-- Ziad's call: open all three for everyone, and have each doctor reconfirm or
-- switch back. That is the right way round — opt-out with a prompt beats an
-- opt-in nobody was shown, and the accompanying commit gives them the control
-- they never had.
--
-- WHY THIS IS SAFE TO DO TO EVERY DOCTOR AT ONCE
--
-- The tier list is not the only gate. eligibleDoctorsFor also requires
-- is_active, NOT is_paused, NOT pending_approval, onboarding_complete, and a
-- matching doctor_services row; capacity is enforced separately per tier via
-- max_active_cases / max_active_cases_urgent. Widening the tier list cannot by
-- itself route a case to someone unqualified for it — it only stops the tier
-- list being the thing that silently eliminates the whole pool.
--
-- The honest risk is the other one: a doctor who genuinely cannot turn a case
-- round in 4 hours now appears in the Urgent pool until they say otherwise.
-- That is what sla_tiers_confirmed_at and the banner in the accompanying commit
-- exist to close, and why this is a prompt rather than a silent change.
--
-- ONLY REAL, WORKING DOCTORS. Paused, deactivated and pending-approval accounts
-- are left exactly as they are: they cannot be assigned anything regardless, and
-- rewriting a paused doctor's preferences while they are away is not ours to do.
-- ============================================================================

-- Records that a doctor has affirmatively reviewed their turnaround tiers.
-- NULL = never asked, or asked and not yet answered — the banner condition.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sla_tiers_confirmed_at timestamptz;

COMMENT ON COLUMN users.sla_tiers_confirmed_at IS
  'When the doctor last confirmed users.sla_tiers_supported from the portal. NULL means unconfirmed — the reconfirmation banner shows until they save. Set by POST /portal/doctor/services.';

UPDATE users
   SET sla_tiers_supported  = '["standard", "vip", "urgent"]'::jsonb,
       -- Deliberately cleared even for the six who already had all three: the
       -- point of the exercise is an affirmative answer from every doctor, and
       -- a row that was never confirmed should not look confirmed just because
       -- its value happens to match.
       sla_tiers_confirmed_at = NULL
 WHERE role = 'doctor'
   AND COALESCE(is_active, true)      = true
   AND COALESCE(is_paused, false)     = false
   AND COALESCE(pending_approval, false) = false
   AND sla_tiers_supported IS DISTINCT FROM '["standard", "vip", "urgent"]'::jsonb;

-- Guard: every assignable doctor must now carry all three. If one does not, the
-- WHERE above excluded a row it should have caught and that doctor is still
-- invisible to VIP and Urgent routing — fail rather than record success.
DO $$
DECLARE narrow integer;
BEGIN
  SELECT count(*) INTO narrow
    FROM users
   WHERE role = 'doctor'
     AND COALESCE(is_active, true)      = true
     AND COALESCE(is_paused, false)     = false
     AND COALESCE(pending_approval, false) = false
     AND NOT (COALESCE(sla_tiers_supported, '[]'::jsonb) @> '["standard","vip","urgent"]'::jsonb);
  IF narrow > 0 THEN
    RAISE EXCEPTION
      '089: % assignable doctor(s) still do not carry all three tiers', narrow;
  END IF;
END $$;
