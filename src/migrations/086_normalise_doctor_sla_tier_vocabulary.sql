-- 086_normalise_doctor_sla_tier_vocabulary.sql
-- ============================================================================
-- 2026-08-24 — every VIP order on the platform was unassignable, and the cause
-- was two vocabularies for one concept.
--
-- An order's urgency tier is standard / vip / urgent (routes/patient.js writes
-- these; migration 031 rewrote the legacy 'fast_track' rows to 'vip'). A
-- doctor's supported tiers live in users.sla_tiers_supported, and in this
-- database they read standard / **priority** / urgent.
--
-- The assignment gate compares them RAW:
--
--     COALESCE(sla_tiers_supported, '["standard"]'::jsonb) @> $2::jsonb
--
-- with $2 taken straight from orders.urgency_tier (src/auto_assign.js). There
-- is no mapping on that path — routes/api/_assign_helpers.js has one, but it
-- feeds only the advisory badge on the admin assign screen, not the gate. So
-- `["priority"] @> ["vip"]` is false for every doctor on the platform, and a
-- patient who pays the VIP surcharge for an 18-hour turnaround has their case
-- silently parked in the manual queue with nobody notified.
--
-- Before this migration:
--     ["standard"]                        25 doctors
--     ["standard","priority","urgent"]     5 doctors
--     ["standard","priority"]              1 doctor
--   → 0 doctors matching a VIP order. 31 doctors, zero coverage.
--
-- WHICH VOCABULARY WINS
--
-- 'vip'. It is what the patient sees on the pricing card ("VIP · 18-hour
-- turnaround"), what orders.urgency_tier stores, what the doctor signup form
-- has been POSTing since it was written (src/views/doctor_signup.ejs:326), and
-- what src/validators/doctor_signup.js already allows — ALLOWED_SLA_TIERS is
-- ['standard','vip','urgent'] and rejects 'priority' outright.
--
-- So 'priority' is not the current vocabulary of anything. It is residue from
-- an earlier naming that only ever survived in this column, and it was
-- actively broken in both directions: the gate could not match a VIP order,
-- and any doctor signing up through the live form wrote 'vip' into a column
-- the admin advisory then failed to recognise.
--
-- IDEMPOTENT. Re-running is a no-op: the WHERE clause only matches arrays that
-- still contain 'priority'.
-- ============================================================================

-- Replace 'priority' with 'vip' wherever it appears, preserving order and any
-- other elements. Rebuilding the array elementwise (rather than a text
-- replace on the whole JSON) keeps a doctor who somehow has BOTH values from
-- ending up with a duplicate.
UPDATE users
   SET sla_tiers_supported = (
         SELECT jsonb_agg(DISTINCT CASE WHEN elem = '"priority"'::jsonb
                                        THEN '"vip"'::jsonb
                                        ELSE elem END)
           FROM jsonb_array_elements(users.sla_tiers_supported) AS elem
       )
 WHERE role = 'doctor'
   AND sla_tiers_supported IS NOT NULL
   AND jsonb_typeof(sla_tiers_supported) = 'array'
   AND sla_tiers_supported @> '["priority"]'::jsonb;

-- Guard: no doctor row may carry the retired value after this runs. If one
-- does, the rewrite above missed a shape (a JSON string instead of an array,
-- say) and the gate is still broken for that doctor — fail loudly rather than
-- let the migration record itself as applied.
DO $$
DECLARE leftover integer;
BEGIN
  SELECT count(*) INTO leftover
    FROM users
   WHERE role = 'doctor'
     AND sla_tiers_supported::text ILIKE '%priority%';
  IF leftover > 0 THEN
    RAISE EXCEPTION
      '086: % doctor row(s) still carry the retired tier value ''priority'' — VIP orders will not assign to them',
      leftover;
  END IF;
END $$;
