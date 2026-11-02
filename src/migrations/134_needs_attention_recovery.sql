-- ============================================================================
-- 134 — v_needs_attention: nudges on abandoned drafts, and coverage leads
--
-- 2 Nov 2026 (patient recovery, Parts A and C). Migration 126's view, with:
--
--   * two columns APPENDED to every arm (CREATE OR REPLACE VIEW can only add
--     columns at the end, and every existing column keeps its name and type):
--       nudges_sent    draft-resume nudges sent for an abandoned_case draft
--       last_nudge_at  when the last one went (notifications.at is timestamp
--                      WITHOUT time zone holding UTC digits, labelled UTC)
--     NULL on every other kind;
--   * abandoned_case: a draft whose resume link was opened within the hour is
--     off the list until it goes idle again, and a draft with a coverage lead
--     is listed once, as coverage_lead (draft_resume_tokens: 132;
--     coverage_leads: 133). Its predicate is otherwise 126's, unchanged;
--   * a new kind, coverage_lead (severity 3, quiet in services/ops_push_prefs):
--     a patient waiting for a specialty we do not open yet.
--
-- Every other arm is 126's, byte for byte (this file's view was generated from
-- 126's text). Never edit 126; the next change to the view is a new migration.
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
  2                                                 AS severity,
  NULL::int                                         AS nudges_sent,
  NULL::timestamptz                                 AS last_nudge_at
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
  1,
  NULL::int,
  NULL::timestamptz
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
  1,
  (SELECT COUNT(*)::int FROM notifications n
     WHERE n.channel = 'internal' AND n.dedupe_key LIKE 'draft\_resume:' || o.id || ':%'),
  (SELECT MAX(n.at) AT TIME ZONE 'UTC' FROM notifications n
     WHERE n.channel = 'internal' AND n.dedupe_key LIKE 'draft\_resume:' || o.id || ':%')
FROM orders o
LEFT JOIN users u ON u.id = o.patient_id
WHERE COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') <> 'demo_appreview'
  AND o.deleted_at IS NULL
  AND COALESCE(o.draft_step, 0) >= 1
  AND COALESCE(o.payment_status, '') NOT IN ('paid', 'captured')
  AND LOWER(COALESCE(o.status, '')) IN ('draft', 'pending', 'expired_unpaid', 'awaiting_payment')
  AND o.created_at < NOW() - INTERVAL '1 hour'
  -- 134: a draft whose resume link was opened in the last hour is being worked
  -- on again — off the list until it goes idle. A draft with a coverage lead
  -- is listed once, as coverage_lead, not twice.
  AND COALESCE((SELECT MAX(t.last_opened_at) FROM draft_resume_tokens t WHERE t.order_id = o.id),
               '-infinity'::timestamptz) < NOW() - INTERVAL '1 hour'
  AND NOT EXISTS (SELECT 1 FROM coverage_leads cl WHERE cl.order_id = o.id)

UNION ALL

SELECT
  'doctor_application',
  d.id::text,
  COALESCE(NULLIF(d.full_name, ''), 'Unknown'),
  d.email,
  d.phone,
  'Applied: ' || COALESCE(d.specialty_id, d.specialty_other, '-'),
  d.created_at,
  3,
  NULL::int,
  NULL::timestamptz
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
  1,
  NULL::int,
  NULL::timestamptz
FROM payment_claims pc
JOIN orders o ON o.id = pc.order_id AND o.deleted_at IS NULL
LEFT JOIN users u ON u.id = pc.patient_id
WHERE pc.status = 'pending'
  AND COALESCE(o.payment_status, '') NOT IN ('paid', 'captured')
  -- 126: the one change to a 117 arm. A claim on a practice case is a
  -- rehearsal, and this kind is now pushed loud on a clock.
  AND COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') NOT IN ('demo_appreview', 'practice_seed')

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
  1,
  NULL::int,
  NULL::timestamptz
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
-- routes/api/admin.js). `ref` is the refund id. LEFT JOIN, with the order
-- predicates written so that a refund whose order row is missing still shows
-- (every o.* is NULL and passes) while one on a soft-deleted or practice order
-- does not.
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
  2,
  NULL::int,
  NULL::timestamptz
FROM refunds r
LEFT JOIN orders o ON o.id = r.order_id
LEFT JOIN users u ON u.id = o.patient_id
WHERE r.status IN ('pending', 'approved', 'auto_approved')
  AND r.refunded_at IS NOT NULL
  AND (r.refunded_at AT TIME ZONE 'UTC') < NOW() - INTERVAL '48 hours'
  AND o.deleted_at IS NULL
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
  2,
  NULL::int,
  NULL::timestamptz
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
  3,
  NULL::int,
  NULL::timestamptz
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
-- status 'failed' ONLY. 'skipped' is the notification worker deciding not to
-- send (an opted-out recipient, a disabled channel, a duplicate) — a decision,
-- not a failure, and it outnumbers real failures about six to one.
-- Grouped per recipient: one person is one row, however many sends failed.
-- `ref` is the recipient's user id. In-app ('internal') rows are not sends.
-- A send about a soft-deleted or practice order is ignored; one with no order
-- at all (o.* NULL) still counts.
SELECT
  'send_failed',
  n.to_user_id::text,
  COALESCE(NULLIF(MAX(u.name), ''), 'Unknown'),
  MAX(u.email),
  MAX(u.phone),
  COUNT(*)::text || ' message(s) failed to send to this ' || MAX(u.role) || ' in 24h ('
    || STRING_AGG(DISTINCT n.channel, ', ') || ')',
  MIN(n.at) AT TIME ZONE 'UTC',
  2,
  NULL::int,
  NULL::timestamptz
FROM notifications n
JOIN users u ON u.id = n.to_user_id AND u.role IN ('patient', 'doctor')
LEFT JOIN orders o ON o.id = n.order_id
WHERE n.status = 'failed'
  AND COALESCE(n.channel, '') NOT IN ('', 'internal')
  AND n.at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'
  AND o.deleted_at IS NULL
  AND COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') NOT IN ('demo_appreview', 'practice_seed')
GROUP BY n.to_user_id

UNION ALL

-- ── 134: a patient waiting for a specialty we do not open yet ───────────────
-- coverage_leads (migration 133) not yet told and not yet converted. `ref` is
-- the lead id. A lead on a deleted or practice draft is ignored; a lead with
-- no draft (o.* NULL) still shows. wanted_text is what the patient typed, cut
-- to 80 characters: this list is staff-only.
SELECT
  'coverage_lead',
  cl.id::text,
  COALESCE(NULLIF(u.name, ''), 'Unknown patient'),
  u.email,
  COALESCE(cl.phone, u.phone),
  'Waiting for ' || COALESCE(NULLIF(sp.name, ''), NULLIF(LEFT(cl.wanted_text, 80), ''), 'a specialty not listed')
    || COALESCE(' (draft ' || o.reference_id || ')', ''),
  cl.created_at,
  3,
  NULL::int,
  NULL::timestamptz
FROM coverage_leads cl
LEFT JOIN users u ON u.id = cl.patient_id
LEFT JOIN specialties sp ON sp.id = cl.wanted_specialty_id
LEFT JOIN orders o ON o.id = cl.order_id
WHERE cl.notified_at IS NULL
  AND cl.converted_order_id IS NULL
  AND o.deleted_at IS NULL
  AND COALESCE(o.is_practice, false) = false
  AND COALESCE(o.source, '') NOT IN ('demo_appreview', 'practice_seed');

COMMENT ON VIEW v_needs_attention IS
  'Everything waiting on a human: people who reached out across all intake '
  'doors, transfers to verify (117), the operational kinds of 126 '
  '(paid_unassigned, refund_stale, specialty_uncovered, send_failed), and since '
  '134 coverage_lead, plus nudges_sent / last_nudge_at on abandoned_case. One '
  'definition, read by the attention sweep, GET /api/v1/admin/attention, /ops '
  'and Tash. Human state (ack / snooze / resolve) lives in attention_state.';
