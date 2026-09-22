-- ============================================================================
-- 115 — pre_launch_leads.handled_at: "answered" is not "launch-notified"
--
-- Migration 114's v_needs_attention treats a lead as waiting while
-- launch_notified_at IS NULL, because that was the only column that could
-- stand for "someone has been back to them".
--
-- Answering Karol Szczepanowski on 22 September proved that wrong within the
-- hour. He ticked consent = NO when he enquired, so he must never be sent
-- launch news — launch_notified_at can never legitimately be set for him. He
-- has now had a full, personal reply, and under 114 he would have stayed in
-- the attention queue forever, alerting every single day.
--
-- That is not a cosmetic bug. The first thing a new alerting system does
-- teaches you whether to trust it, and an alert about someone already handled
-- is how people learn to swipe alerts away. The sweep exists because three
-- doors were ignored; an alerting channel that cries wolf recreates the same
-- outcome by a different route.
--
-- So the two facts get two columns. handled_at means a human replied.
-- launch_notified_at keeps its own meaning — marketing was sent — and stays
-- governed by consent.
-- ============================================================================

ALTER TABLE pre_launch_leads
  ADD COLUMN IF NOT EXISTS handled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handled_by  TEXT,
  ADD COLUMN IF NOT EXISTS handled_note TEXT;

COMMENT ON COLUMN pre_launch_leads.handled_at IS
  'A human has replied to this enquiry. Distinct from launch_notified_at, '
  'which means marketing was sent and is governed by consent. A lead with '
  'consent=false can be handled and must never be launch-notified.';

CREATE INDEX IF NOT EXISTS pre_launch_leads_unhandled_idx
  ON pre_launch_leads (created_at) WHERE handled_at IS NULL;

-- ── the view, corrected ─────────────────────────────────────────────────────
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

-- Waiting means nobody has REPLIED. Whether they were later sent launch news
-- is a separate question, and for a consent=false lead the answer is never.
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
WHERE LOWER(COALESCE(d.status, 'new')) IN ('new', 'pending', 'submitted');
