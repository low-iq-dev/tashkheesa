-- ============================================================================
-- 116 — payment_claims: a patient's "I paid by transfer" is a CLAIM, not money
--
-- Launch contingency (2026-09-24). Paymob card payments have failed every
-- transaction since June, so the portal offers InstaPay / bank transfer as a
-- manual path (flag MANUAL_PAYMENT_ENABLED, default off — see
-- src/services/manual_payment.js and MANUAL_PAY_CONTRACT.md).
--
-- THE RULE this table exists to keep: a patient's claim NEVER marks an order
-- paid. It records what the patient told us (method, the reference they typed,
-- the sender name) and a superadmin checks the bank/InstaPay statement. Only
-- the existing POST /superadmin/orders/:id/mark-paid moves money state; when it
-- succeeds the order's pending claim is closed as 'confirmed'. A superadmin can
-- instead 'reject' it with a reason, which leaves the order unpaid.
--
-- One PENDING claim per order (partial unique index): a resubmit while pending
-- updates that row rather than stacking duplicates. Rejected/confirmed rows are
-- history and may be many.
--
-- Additive and idempotent. No foreign keys, matching the rest of the schema
-- (orders are anonymised, never deleted, on account erasure; the erasure
-- service deletes this table's rows for the patient — see
-- services/account_deletion.js OPTIONAL_USER_TABLES).
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_claims (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL,
  patient_id        TEXT,
  method            TEXT NOT NULL CHECK (method IN ('instapay', 'bank')),
  reference         TEXT NOT NULL,
  sender_name       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'confirmed', 'rejected')),
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT
);

COMMENT ON TABLE payment_claims IS
  'Patient-submitted InstaPay/bank transfer claims. UNVERIFIED — never marks an '
  'order paid. Resolved by a superadmin (confirmed via mark-paid, or rejected '
  'with a reason). See migration 116.';

CREATE UNIQUE INDEX IF NOT EXISTS payment_claims_one_pending_per_order
  ON payment_claims (order_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS payment_claims_order_idx
  ON payment_claims (order_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS payment_claims_pending_idx
  ON payment_claims (updated_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS payment_claims_patient_idx
  ON payment_claims (patient_id);

-- Per-table RLS opt-in that 073's worked example mandates for every table born
-- after 070: ENABLE with no policies and no FORCE = default-deny for anon /
-- authenticated; the app connects as a rolbypassrls role and is unaffected.
ALTER TABLE payment_claims ENABLE ROW LEVEL SECURITY;

-- ── v_needs_attention: a transfer waiting to be checked is someone waiting ──
-- Same view as migration 115, plus one door. A patient who has told us they
-- paid and hears nothing is the most expensive silence on the platform: they
-- have handed over money and their case has not started. Severity 1, aged from
-- the latest submission (a corrected reference is new information).
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

-- A transfer claim nobody has confirmed or rejected yet. `ref` is the ORDER id
-- (the superadmin payment page is /superadmin/orders/<ref>/payment).
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
  AND COALESCE(o.payment_status, '') NOT IN ('paid', 'captured');

COMMENT ON VIEW v_needs_attention IS
  'Every person waiting on a human reply, across all intake doors, plus '
  'patients waiting for a bank/InstaPay transfer to be confirmed (116). One '
  'definition, read by the attention sweep, /ops, the Command app and Tash. '
  'See migration 114 for the three silent failures that produced it.';
