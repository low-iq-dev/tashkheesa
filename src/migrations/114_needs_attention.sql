-- ============================================================================
-- 114 — v_needs_attention: one answer to "who is waiting on us"
--
-- WHY THIS EXISTS
-- ---------------
-- Three separate doors let a person reach Tashkheesa, and on 22 September all
-- three were found to have swallowed someone:
--
--   1. /coming-soon  — Karol, a patient in Poland, enquired on 30 July about a
--      second opinion on an epilepsy diagnosis. The row landed in
--      pre_launch_leads and nothing read that table. Eight weeks of silence.
--   2. /contact      — 66 submissions were written to error_logs at level
--      'info'. No status, no owner, nobody reading. (Migration 113 gave that
--      door a real table; this view is what makes it visible.)
--   3. the case wizard — hend registered on 15 July and started a case about
--      her mother's breast cancer, reached step 2 of 4 and stopped. No alert
--      exists for an abandoned draft at all, so nobody ever knew.
--
-- Each door was built separately and each assumed somebody was watching.
-- Nobody was. The common failure is not a missing notification: it is that
-- every door notifies on SUCCESS and nothing watches for SILENCE.
--
-- WHAT THIS IS
-- ------------
-- One view, one definition of "waiting", across every door. Whatever consumes
-- it — the sweep job, the ops dashboard, the Command app, Tash's daily brief —
-- reads the same rows, so the number cannot disagree between two places.
--
-- Deliberately a VIEW, not a table: there is no state to drift. A thing is
-- waiting because of the state of its own row, and it stops being waiting when
-- that row changes. Nothing to mark, nothing to reconcile, nothing to forget.
--
-- `kind` is stable and machine-readable; `waiting_since` is what any alert
-- should age against; `severity` ranks what a human should look at first.
-- ============================================================================

CREATE OR REPLACE VIEW v_needs_attention AS

-- ── A public contact-form submission nobody has worked ──────────────────────
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

-- ── A pre-launch / coming-soon enquiry never followed up ────────────────────
-- launch_notified_at NULL means nobody has been back to them. Karol's row.
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
WHERE l.launch_notified_at IS NULL

UNION ALL

-- ── A patient who started a case and stopped ────────────────────────────────
-- draft_step >= 1 means they did more than land on the page. Anything still
-- unpaid an hour later is someone who wanted something and hit a wall, which
-- is exactly who is worth calling. Practice cases and the App Review demo are
-- excluded — they are ours, not patients.
--
-- Severity 1: this is the highest-intent signal on the platform. They typed a
-- clinical question about themselves or someone they love and then stopped.
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

-- ── A doctor application nobody has opened ──────────────────────────────────
-- Lower severity than a patient: a specialist waiting a day is a slower loss
-- than a patient waiting a day, but it is still a person waiting on a reply.
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
WHERE LOWER(COALESCE(d.status, 'new')) IN ('new', 'pending', 'submitted');

COMMENT ON VIEW v_needs_attention IS
  'Every person waiting on a human reply, across all four intake doors. One '
  'definition, read by the attention sweep, /ops, the Command app and Tash. '
  'See migration 114 for the three silent failures that produced it.';

-- The sweep's query is "oldest unattended first", per door.
CREATE INDEX IF NOT EXISTS pre_launch_leads_unnotified_idx
  ON pre_launch_leads (created_at) WHERE launch_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS orders_abandoned_draft_idx
  ON orders (created_at)
  WHERE deleted_at IS NULL AND draft_step >= 1;
