-- ============================================================================
-- 126 — v_needs_attention: four operational kinds
--
-- 6 Oct 2026 (watchtower). The view answered "who reached out and was not
-- answered". These four answer "what is stuck that only a human can unstick":
--
--   paid_unassigned      a paid case with no doctor for more than 15 minutes
--   refund_stale         a refund still owed after 48 hours
--   specialty_uncovered  a specialty patients can order from with no doctor
--                        able to take the case; a second row, ref '<id>:urgent',
--                        when doctors exist but none of them covers Urgent
--   send_failed          notifications to a patient or doctor that failed or
--                        were skipped in the last 24 hours — ONE row per
--                        recipient, not one per message
--
-- The first five arms are migration 117's, byte for byte (payment_claim, the
-- transfer waiting to be verified, is already a kind there — the 60-minute
-- threshold is applied by the sweep, not by the view).
--
-- Practice cases are excluded from every arm that touches an order, with the
-- same predicate the abandoned_case arm has always used plus the practice_seed
-- source. Column types are unchanged (CREATE OR REPLACE VIEW would refuse
-- otherwise): refunds.refunded_at and notifications.at are timestamp WITHOUT
-- time zone holding UTC digits, so both are labelled UTC to stay timestamptz.
--
-- specialty_uncovered has no timestamp of its own. Its age is
-- attention_state.first_seen_at, stamped by the sweep (migration 125); until a
-- sweep has seen it, it is NOW().
-- ============================================================================

CREATE OR REPLACE VIEW v_needs_attention AS

SELECT
  'contact_submission'::text                        AS kind,
  c.id::text                                        AS ref,
  COALESCE(NULLIF(c.name, ''), 'Unknown')           AS who,
  c.email                                           AS email,
  NULL::text                                        AS phone,
  COALESCE(NULLIF(c.subject, ''), 'General enquiry') AS summary,
  c.created_at                                      AS waiting_since,
  2                                                 AS severity
FROM contact_submissions c
WHERE c.status = 'new'

UNION ALL

SELECT
  'pre_launch_lead',
  l.id::text,
  COALESCE(NULLIF(l.name, ''), 'Unknown'),
  l.email,
  COALESCE(l.phone_e164, l.phone),
  COALESCE(NULLIF(l.case_description, ''), 'Interest: ' || COALESCE(l.service_interest, '-')),
  l.created_at,
  1
FROM pre_launch_leads l
WHERE l.handled_at IS NULL

UNION ALL

SELECT
  'abandoned_case',
  o.id::text,
  COALESCE(NULLIF(u.name, ''), 'Unknown patient'),
  u.email,
  u.phone,
  COALESCE(NULLIF(LEFT(o.clinical_question, 120), ''), 'No question entered yet'),
  o.created_at,
  1
FROM orders o
LEFT JOIN users u ON u.id = o.patient_id
WHERE COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') <> 'demo_appreview'
  AND o.deleted_at IS NULL
  AND COALESCE(o.draft_step, 0) >= 1
  AND COALESCE(o.payment_status, '') NOT IN ('paid', 'captured')
  AND LOWER(COALESCE(o.status, '')) IN ('draft', 'pending', 'expired_unpaid', 'awaiting_payment')
  AND o.created_at < NOW() - INTERVAL '1 hour'

UNION ALL

SELECT
  'doctor_application',
  d.id::text,
  COALESCE(NULLIF(d.full_name, ''), 'Unknown'),
  d.email,
  d.phone,
  'Applied: ' || COALESCE(d.specialty_id, d.specialty_other, '-'),
  d.created_at,
  3
FROM doctor_applications d
WHERE LOWER(COALESCE(d.status, 'new')) IN ('new', 'pending', 'submitted')

UNION ALL

SELECT
  'payment_claim',
  pc.order_id::text,
  COALESCE(NULLIF(u.name, ''), NULLIF(pc.sender_name, ''), 'Unknown patient'),
  u.email,
  u.phone,
  'Transfer to verify (' || pc.method || ', ref ' || LEFT(pc.reference, 80) || ') on case '
    || COALESCE(o.reference_id, LEFT(o.id, 8)),
  pc.updated_at,
  1
FROM payment_claims pc
JOIN orders o ON o.id = pc.order_id AND o.deleted_at IS NULL
LEFT JOIN users u ON u.id = pc.patient_id
WHERE pc.status = 'pending'
  AND COALESCE(o.payment_status, '') NOT IN ('paid', 'captured')

UNION ALL

-- ── A paid case nobody is holding ───────────────────────────────────────────
-- The status list is ACTIVE_STATUS_LIST from routes/api/_assign_helpers.js —
-- the same "open work" set the Command queue counts — so a case cannot be
-- unassigned here and not there. Aged from the payment, not the draft.
SELECT
  'paid_unassigned',
  o.id::text,
  COALESCE(NULLIF(u.name, ''), 'Unknown patient'),
  u.email,
  u.phone,
  'Paid, no doctor: case ' || COALESCE(o.reference_id, LEFT(o.id, 8))
    || ' (' || COALESCE(NULLIF(o.urgency_tier, ''), NULLIF(o.tier, ''), 'standard') || ')',
  COALESCE(o.paid_at, o.created_at),
  1
FROM orders o
LEFT JOIN users u ON u.id = o.patient_id
WHERE COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') NOT IN ('demo_appreview', 'practice_seed')
  AND o.deleted_at IS NULL
  AND o.doctor_id IS NULL
  AND o.completed_at IS NULL
  AND COALESCE(o.payment_status, '') IN ('paid', 'captured')
  AND LOWER(COALESCE(o.status, '')) IN
      ('paid', 'in_progress', 'in_review', 'submitted', 'assigned',
       'rejected_files', 'sla_breach', 'breached', 'reassigned')
  AND COALESCE(o.paid_at, o.created_at) < NOW() - INTERVAL '15 minutes'

UNION ALL

-- ── A refund still owed after two days ──────────────────────────────────────
-- 'pending' is undecided; 'approved' / 'auto_approved' are decided and not yet
-- paid out. All three are money a patient is waiting for (the UNSETTLED set in
-- routes/api/admin.js). `ref` is the refund id.
SELECT
  'refund_stale',
  r.id::text,
  COALESCE(NULLIF(u.name, ''), 'Unknown patient'),
  u.email,
  u.phone,
  'Refund ' || r.status || ' for 48h+: EGP '
    || COALESCE(r.approved_amount, r.amount_egp, 0)::text || ' on case '
    || COALESCE(o.reference_id, LEFT(r.order_id, 8)),
  r.refunded_at AT TIME ZONE 'UTC',
  2
FROM refunds r
LEFT JOIN orders o ON o.id = r.order_id
LEFT JOIN users u ON u.id = o.patient_id
WHERE r.status IN ('pending', 'approved', 'auto_approved')
  AND r.refunded_at IS NOT NULL
  AND (r.refunded_at AT TIME ZONE 'UTC') < NOW() - INTERVAL '48 hours'
  AND COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') NOT IN ('demo_appreview', 'practice_seed')

UNION ALL

-- ── A specialty patients can order from, with nobody to take the case ───────
-- "Ready doctor" is services/doctor_eligibility.js eligibleDoctorClause:
-- active, not paused, approved, onboarding complete, and mapped to a service.
-- "Orderable" is services/service_bookable.js: the specialty is visible and
-- has at least one visible service — a visible specialty with nothing to sell
-- cannot strand a patient, so it is not reported.
SELECT
  'specialty_uncovered',
  sp.id::text,
  COALESCE(NULLIF(sp.name, ''), sp.id),
  NULL::text,
  NULL::text,
  'No ready doctor for ' || COALESCE(NULLIF(sp.name, ''), sp.id),
  COALESCE(st.first_seen_at, NOW()),
  2
FROM specialties sp
LEFT JOIN attention_state st ON st.kind = 'specialty_uncovered' AND st.ref = sp.id::text
WHERE COALESCE(sp.is_visible, true) = true
  AND EXISTS (
        SELECT 1 FROM services sv
         WHERE sv.specialty_id = sp.id AND COALESCE(sv.is_visible, true) = true)
  AND NOT EXISTS (
        SELECT 1 FROM services sv
          JOIN doctor_services ds ON ds.service_id = sv.id
          JOIN users du ON du.id = ds.doctor_id
         WHERE sv.specialty_id = sp.id
           AND du.role = 'doctor'
           AND COALESCE(du.is_active, true) = true
           AND COALESCE(du.is_paused, false) = false
           AND COALESCE(du.pending_approval, false) = false
           AND COALESCE(du.onboarding_complete, false) = true)

UNION ALL

-- ── …or covered, but by nobody who takes Urgent ─────────────────────────────
-- Separately flagged: ref is '<specialty id>:urgent'. Only reported when the
-- specialty HAS a ready doctor (otherwise the row above already says so).
SELECT
  'specialty_uncovered',
  sp.id::text || ':urgent',
  COALESCE(NULLIF(sp.name, ''), sp.id),
  NULL::text,
  NULL::text,
  'No Urgent cover for ' || COALESCE(NULLIF(sp.name, ''), sp.id),
  COALESCE(st.first_seen_at, NOW()),
  3
FROM specialties sp
LEFT JOIN attention_state st ON st.kind = 'specialty_uncovered' AND st.ref = sp.id::text || ':urgent'
WHERE COALESCE(sp.is_visible, true) = true
  AND EXISTS (
        SELECT 1 FROM services sv
         WHERE sv.specialty_id = sp.id AND COALESCE(sv.is_visible, true) = true)
  AND EXISTS (
        SELECT 1 FROM services sv
          JOIN doctor_services ds ON ds.service_id = sv.id
          JOIN users du ON du.id = ds.doctor_id
         WHERE sv.specialty_id = sp.id
           AND du.role = 'doctor'
           AND COALESCE(du.is_active, true) = true
           AND COALESCE(du.is_paused, false) = false
           AND COALESCE(du.pending_approval, false) = false
           AND COALESCE(du.onboarding_complete, false) = true)
  AND NOT EXISTS (
        SELECT 1 FROM services sv
          JOIN doctor_services ds ON ds.service_id = sv.id
          JOIN users du ON du.id = ds.doctor_id
         WHERE sv.specialty_id = sp.id
           AND du.role = 'doctor'
           AND COALESCE(du.is_active, true) = true
           AND COALESCE(du.is_paused, false) = false
           AND COALESCE(du.pending_approval, false) = false
           AND COALESCE(du.onboarding_complete, false) = true
           AND COALESCE(du.sla_tiers_supported, '["standard"]'::jsonb) ? 'urgent')

UNION ALL

-- ── Messages to a patient or doctor that did not go out ─────────────────────
-- Grouped per recipient: one person is one row, however many sends failed.
-- `ref` is the recipient's user id. In-app ('internal') rows are not sends.
SELECT
  'send_failed',
  n.to_user_id::text,
  COALESCE(NULLIF(MAX(u.name), ''), 'Unknown'),
  MAX(u.email),
  MAX(u.phone),
  COUNT(*)::text || ' message(s) not delivered to this ' || MAX(u.role) || ' in 24h ('
    || COUNT(*) FILTER (WHERE n.status = 'failed')::text || ' failed, '
    || COUNT(*) FILTER (WHERE n.status = 'skipped')::text || ' skipped; '
    || STRING_AGG(DISTINCT n.channel, ', ') || ')',
  MIN(n.at) AT TIME ZONE 'UTC',
  2
FROM notifications n
JOIN users u ON u.id = n.to_user_id AND u.role IN ('patient', 'doctor')
LEFT JOIN orders o ON o.id = n.order_id
WHERE n.status IN ('failed', 'skipped')
  AND COALESCE(n.channel, '') NOT IN ('', 'internal')
  AND n.at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'
  AND COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') NOT IN ('demo_appreview', 'practice_seed')
GROUP BY n.to_user_id;

COMMENT ON VIEW v_needs_attention IS
  'Everything waiting on a human: people who reached out across all intake '
  'doors, transfers to verify (117), and since 126 the operational kinds '
  'paid_unassigned, refund_stale, specialty_uncovered and send_failed. One '
  'definition, read by the attention sweep, GET /api/v1/admin/attention, /ops '
  'and Tash. Human state (ack / snooze / resolve) lives in attention_state.';
