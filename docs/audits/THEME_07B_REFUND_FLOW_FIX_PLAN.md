# Theme 7b — Instapay-Manual Refund Flow: Fix Plan

**Date:** 2026-05-10
**Author:** Claude Opus 4.7 (1M context)
**Working tree HEAD:** `3d6f05f` (Theme 6 fully shipped — production live and verified)
**Sources:** `docs/audits/THEME_07_STATE_MACHINE_FIX_PLAN.md` (specifically the §3 root-cause-2 + ALERT block + OQ-1/OQ-2 answers from Theme 7 execution); `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` (P0-STATE-3, P1-FIN-1..6); plus targeted reads of `src/migrations/028_refunds_table.sql`, `src/services/sla_breach.js`, `src/services/earnings_writer.js`, `src/services/paymob.js`, `src/notify/*`, `src/audit.js`, `src/routes/patient.js`, `src/routes/superadmin.js`, `src/views/patient_order.ejs`, `src/views/superadmin_alerts.ejs` against the live `3d6f05f` codebase for this scoping.

> Scoping document only. **No source files have been modified.** Schema diffs, route handler shapes, and view skeletons in §3 are *proposed*, not applied.

---

## ⚠️ ALERT — One load-bearing design decision needs Ziad's confirmation before §3 lands

The brief's proposed schema and the existing `src/migrations/028_refunds_table.sql` table are **structurally different**, not just additive. Migration 028 was designed as an **append-only ledger** for system-generated refunds (SLA breach auto-refunds via `services/sla_breach.issueBreachRefund`); it has no `status` column, no `instapay_handle`, no separation between `requested_amount` / `approved_amount`, and uses `NUMERIC(10,2)` EGP rather than `INTEGER` cents.

The new flow is a **patient-initiated workflow** with five lifecycle states (pending / auto_approved / approved / paid / denied) that need to coexist with the existing system-generated refund rows. This shapes the entire migration story, route validators, and UI affordances. §3-A presents two reconciliation paths (extend 028 vs. new `refund_requests` table that wraps 028); the recommendation is to extend 028 (smaller blast radius, single source of truth, paymob_refund_id already aligns), but Ziad needs to sign off before any migration is written. See **§3-A** and **OQ-7**.

---

## 1. Executive summary

A patient-initiated refund flow does not currently exist. The platform takes patient money via Paymob (one-way client at `services/paymob.js` exposes `createIntention` + `verifyPaymobHmac` only — no `refund()`), and the only refund path that fires today is `services/sla_breach.issueBreachRefund` on SLA-breach hooks (auto-zeroes the urgency uplift, writes an append-only `refunds` row with `refunded_by='system'`, leaves `paymob_refund_id` NULL). The actual money never leaves Tashkheesa's Paymob merchant account; the row records intent only. Ziad's approved approach is to keep this property and replace the missing money-leaving step with **manual Instapay payouts** — the database records the request and the manual transaction reference; superadmin issues the bank-to-bank transfer outside the system and enters the reference back.

**Sub-issue A** (schema) — the existing `refunds` table is an append-only ledger; the new flow needs a workflow with statuses. Recommendation: extend `refunds` in-place via migration 048 (add `status`, `instapay_handle`, `instapay_reference`, `requested_amount_egp`, `approved_amount_egp`, `requested_by`, `reviewed_by`, `reviewed_at`, `paid_at`, `denial_reason`); existing system-generated rows backfill to `status='paid'` with `refunded_at` becoming the canonical `paid_at`. Migration 048 (next sequential after 047). Schema interacts with `services/earnings_writer.markPartialPayOnReassignment` (it queries `refunds` by `reason='sla_breach'` for idempotency); the new columns are nullable so existing reads don't break. **§3-A documents the reconciliation; the alternative — a new `refund_requests` table that wraps `refunds` — is in OQ-7.**

**Sub-issue B** (patient UI) — the canonical patient case page is `src/views/patient_order.ejs:1` (rendered by `routes/patient.js:2447 GET /portal/patient/orders/:id`). Add a "Request refund" affordance in the Overview tab CTA area, gated on `getRefundEligibility(orderId)` so it only shows on eligible cases. Form: textarea for reason + text input for Instapay handle. i18n via the canonical `tt(key, en, ar)` helper used by Theme 10 throughout the patient portal. A status banner ("Refund request pending review", "Approved — Instapay payment in flight", "Denied — see reason") replaces the button once a request exists.

**Sub-issue C** (patient API) — `POST /portal/patient/orders/:id/request-refund` (matches the codebase URL convention; the `:id` is the `orders.id`, not a separate `case_id`). Validates: case ownership (patient owns the order), eligibility (helper from §3-H), no existing pending request, Instapay handle non-empty. Writes the `refunds` row with `status='pending'` (or `'auto_approved'` for pre-doctor-accept cases per the eligibility helper), logs `patient_refund_request` to `order_events`, queues a confirmation notification to the patient + a queue notification to active superadmins (mirrors the `notifyAdmins` fan-out shape from Theme 6 Phase 4).

**Sub-issue D** (superadmin queue) — new page `GET /superadmin/refunds` modelled on `superadmin_alerts.ejs` (`src/views/superadmin_alerts.ejs:1-101` is the template-shape precedent: breadcrumb, H1, table-with-actions). Columns: case ref, patient name, requested amount, Instapay handle, reason, status, requested at, action buttons (approve / deny / mark-paid). The existing dashboard widget at `superadmin.js:1300-1404` reads `appointment_payments.refund_status` (video appointments — separate flow); the new widget reads from `refunds.status='pending'` and links to `/superadmin/refunds`.

**Sub-issue E** (superadmin actions API) — three POST routes: `:id/approve` (sets `status='approved'`, `approved_amount_egp`, `reviewed_by`, `reviewed_at`; queues "your refund is approved" notification), `:id/deny` (sets `status='denied'`, `denial_reason`, `reviewed_*`; queues denial notification with the reason), `:id/mark-paid` (sets `status='paid'`, `instapay_reference`, `paid_at`; queues "Instapay payment is in flight" notification). Each writes an `order_events` row with the appropriate `actor_role='superadmin'` label.

**Sub-issue F** (notifications) — four new template constants: `PATIENT_REFUND_REQUESTED` (confirmation back to patient), `PATIENT_REFUND_APPROVED`, `PATIENT_REFUND_DENIED`, `PATIENT_REFUND_PAID` (with Instapay reference). Plus an admin queue notification `ADMIN_REFUND_QUEUED` fanned out via the `notifyAdmins`-style helper. All five use `queueMultiChannelNotification` for the patient (internal + email + WhatsApp where eligible) and `queueNotification` per-superadmin for admins.

**Sub-issue G** (audit trail) — every refund state change writes an `order_events` row via `audit.logOrderEvent` with labels `refund_requested`, `refund_auto_approved`, `refund_approved`, `refund_denied`, `refund_paid`. The patient case timeline view (`patient_order.ejs` Overview tab) and the superadmin order detail view will surface these in chronological order alongside existing case events (no new view code needed — existing event timeline already renders unknown labels with a generic shape).

**Sub-issue H** (eligibility helper) — new `src/services/refund_eligibility.js` exporting `getRefundEligibility(order, opts)`. Returns `{ eligible: bool, reason: string, autoApprove: bool, blockingStatus: string|null }`. The helper is the single source of truth used by (a) the patient case page to gate the "Request refund" button, (b) the patient API endpoint to reject ineligible requests, and (c) the superadmin queue to highlight cases that *should* have been auto-approved (defensive: the patient endpoint also pre-flips `status='auto_approved'` so the superadmin queue surfaces them as one-click "mark paid", not as decision-pending).

**Estimated effort**: A (4h migration + integration tests), H (2h, pure helper), C (3h, route + form validation), B (3h, view + form), D (4h, queue page + filters), E (3h, three routes + audit + notifications), F (1h, template strings + WhatsApp template registration), G (subsumed in C/E). **Total ≈ 20h** (~3 days). Phase order in §4. Not blocking: the actual Instapay payout is manual; no integration with bank APIs is in scope.

---

## 2. Current state

### 2-A. Refund infrastructure inventory

**Migration 028 — `refunds` table (exists, append-only ledger):**

```sql
-- src/migrations/028_refunds_table.sql:26-39
CREATE TABLE IF NOT EXISTS refunds (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_egp          NUMERIC(10,2) NOT NULL,
  reason              TEXT NOT NULL,
  refunded_at         TIMESTAMP DEFAULT NOW(),
  refunded_by         TEXT,
  paymob_refund_id    TEXT,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS idx_refunds_order   ON refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_reason  ON refunds(reason);
CREATE INDEX IF NOT EXISTS idx_refunds_created ON refunds(refunded_at);
```

**Observations:**
- Uses `order_id` (canonical orders table), not `case_id` — Ziad's brief used `case_id`; the codebase convention is `order_id`. **Resolved in §3-A by adopting `order_id`.**
- `amount_egp NUMERIC(10,2)` not `_cents INTEGER`. The codebase consistently uses `NUMERIC EGP` (orders.urgency_uplift_amount, services pricing). **§3-A keeps NUMERIC; OQ-9 confirms.**
- No `status` column.
- `refunded_by TEXT` is a single column — the existing writer at `services/sla_breach.js:68` hardcodes it to `'system'`. Need to replace with `requested_by` / `reviewed_by` / `paid_by` (or repurpose as `paid_by`).
- `refunded_at` is a single timestamp; the new flow needs `requested_at` (= `created_at`), `reviewed_at`, `paid_at`.
- `paymob_refund_id` already nullable — fits the brief's "present for future hybrid flexibility" exactly. Reuse as-is.
- `notes` is free-form text — useful for both denial reasons and manual operator notes.
- `ON DELETE CASCADE` on `orders(id)` — fine; matches the brief.

**Active writers/readers:**

| File | Line | Operation | Notes |
|---|---|---|---|
| `services/sla_breach.js:65-74` | INSERT | Writes `reason='sla_breach'`, `refunded_by='system'`, `paymob_refund_id=NULL` on every SLA breach (idempotent via existing-row check). |
| `services/sla_breach.js:56-62` | SELECT | Idempotency guard: `WHERE order_id=$1 AND reason='sla_breach' LIMIT 1`. |
| `services/earnings_writer.js:247` (`markPartialPayOnReassignment`) | (indirect) | Reads `refunds` is implied via the breach-recompute hook (`services/sla_breach.js:88` calls `recomputeOnBreach(orderId)`). Verified: earnings writer queries `orders.urgency_uplift_amount` (which `issueBreachRefund` zeroes), not `refunds` directly. |

**Important compat constraint:** the existing idempotency query
`WHERE order_id=$1 AND reason='sla_breach' LIMIT 1`
must keep working after the schema change. Adding columns is safe; adding a `status` column with a default doesn't break this read. **§3-A's migration is purely additive.**

### 2-B. Paymob integration — confirmed one-way

`src/services/paymob.js:260-263`:

```js
module.exports = {
  createIntention: createIntention,
  verifyPaymobHmac: verifyPaymobHmac,
};
```

Only those two functions exist. No `refund()`, no `void()`, no `capture()`. The TODO comment at `services/sla_breach.js:97-100` ("trigger Paymob actual-money refund — wired separately on Ziad's payments track") confirms the original plan was to add a Paymob refund client; Ziad's approved approach is to **not** add it and instead do manual Instapay payouts. This is the design decision codified by Theme 7b.

### 2-C. Patient cancel paths (related, not refund)

For completeness — the audit doc (Theme 7 §3) mentions two patient cancel paths:

| File | Line | Path | Refund behaviour |
|---|---|---|---|
| (web portal) | — | none | No patient cancel route exists in the web portal. |
| `src/routes/api_v1.js` (mobile API) | (mounted at `/api/v1/cases/:id/cancel`) | Three defects: 10-minute window from `created_at` (predates payment), `status IN ('submitted','under_review')` where `'under_review'` is not real (canonical is `'IN_REVIEW'`), raw `UPDATE orders SET status='cancelled'` bypasses canonical lifecycle. **No refund hook.** |
| `src/routes/superadmin.js:2718` | superadmin manual cancel | Raw `UPDATE orders SET status='cancelled'`, no refund. |

The new refund flow is **independent** of cancel — a patient can request a refund without cancelling (e.g. delayed report, dissatisfaction with doctor) — but a cancel-with-refund is a natural composite action. **OQ-3** asks whether to wire a single "Cancel + refund" affordance or keep them as two steps. For Theme 7b, scope is refund-only; cancel UX stays a future theme.

### 2-D. Patient portal — case detail page

**Route:** `routes/patient.js:2447 — GET /portal/patient/orders/:id`
**Renders:** `src/views/patient_order.ejs` (read for surface map)

**Page structure (verified):**
- Breadcrumb (Home → Case TSH-XXXXX)
- Topbar with hero copy: doctor name, status chip, dashboardState (`'limbo' | 'active' | 'completed'`)
- Tab navigation: Overview | Documents | Messages | Report
- Overview tab: timeline, SLA countdown, expected timing, pricing breakdown
- Existing patient action affordances on this page:
  - Upload modal (`POST /portal/patient/orders/:id/upload`)
  - Submit-info form (`POST /portal/patient/orders/:id/submit-info`, `routes/patient.js:2781`)
  - Send message (`POST /portal/patient/orders/:id/messages`, `:2663`)
  - View report download (when completed)

**Where the "Request refund" button goes:** Overview tab CTA area, just below the SLA countdown and above the Documents preview. Eligibility-gated — see §3-H.

**Form pattern precedent (used by submit-info at `routes/patient.js:2781`):**

```ejs
<form method="post" action="/portal/patient/orders/<%= order.id %>/request-refund"
      autocomplete="off" novalidate>
  <%= csrfField ? csrfField() : '' %>
  ... fields ...
  <button class="p-btn p-btn--primary" type="submit"><%= tt(...) %></button>
</form>
```

CSRF is wired via `csrfField()` (Theme 3); the patient routes already enforce the `requireRole('patient')` middleware.

### 2-E. Superadmin portal — main dashboard + queue patterns

**Main dashboard:** `routes/superadmin.js:988 — GET /superadmin` renders `src/views/superadmin.ejs`. Existing widget at `:1300-1404` shows `refundCount` / `refundTotal` from `appointment_payments.refund_status` — that's a **separate** video-appointment refund flow (not the orders/refunds table). The new orders-refund widget is additive: queries `refunds.status='pending'` for the count, links to `/superadmin/refunds`.

**Queue page precedent:** `src/views/superadmin_alerts.ejs:1-101` — breadcrumb, H1, "back to dashboard" button, table with [type | case ID | status | time], 50-item limit, paginated. The new `superadmin_refunds.ejs` clones this shape with [case ref | patient | requested amount | Instapay handle | reason | status | actions].

**Other queue references:** doctor-approval queue (`/superadmin/doctors/:id/approve`), additional-files-approval queue (`/superadmin/orders/:id/additional-files/approve`). Same row-level POST action shape.

### 2-F. Audit trail — `logOrderEvent`

`src/audit.js:19-44` — `logOrderEvent({ orderId, label, meta, actorUserId, actorRole })`. Writes to `order_events`. The Overview tab of `patient_order.ejs` and the superadmin order detail view (`/superadmin/orders/:id`) both render the event timeline ordered by `at` DESC.

Observed labels in the codebase (sample):
- Patient actions: `patient_reply`, `patient_reply_with_files`
- Doctor actions: `doctor_accepted_order`, `doctor_requested_additional_files`, `doctor_rejected_files`
- System: `case_auto_reassigned_capacity`, `sla_breach`, `case_completed`, `case_auto_deleted_unpaid`

**New labels for refund flow** (proposed):
- `refund_requested` (actor_role='patient')
- `refund_auto_approved` (actor_role='system') — for pre-doctor-accept cases
- `refund_approved` (actor_role='superadmin')
- `refund_denied` (actor_role='superadmin')
- `refund_paid` (actor_role='superadmin') — Instapay reference in `meta`

### 2-G. Notification infrastructure

**Templates registry** (`src/notify/templates.js:1-30`): `TEMPLATES` map of canonical names. Already includes `CASE_CANCELLED_REFUND` (`tashkheesa_cancelled_refund`) — that's a "case was cancelled and refunded" template, distinct from the new "refund request submitted/approved/denied/paid" stages. Need to add four new constants.

**WhatsApp template registry** (`src/notify/whatsappTemplateMap.js`): maps logical templates to Meta-approved template names + variable lists. Adding a new logical template requires adding an entry here AND registering the template with Meta (out-of-band — Meta approval cycle is 24-48h). **OQ-5** asks whether to use email-only for the denial template to avoid Meta template approval blocking the launch.

**Notification titles** (`src/notify/notification_titles.js`): bilingual (EN+AR) titles for in-app rendering. Need 4 new entries.

**Multi-channel send pattern** (sample from `routes/doctor.js`):

```js
queueMultiChannelNotification({
  orderId,
  toUserId: patient.id,
  channels: ['internal', 'email', 'whatsapp'],
  template: 'patient_refund_approved',
  response: { case_id, refundAmount, ... },
  dedupe_key: `refund_approved:${orderId}:patient`,
});
```

Internal-only for admin queue notifications; multi-channel for patient-facing.

### 2-H. i18n integration

Theme 10 shipped `tt(key, en, ar)` helper used in EJS templates. Pattern:

```ejs
<%= tt('refund.submit', 'Submit refund request', 'إرسال طلب الاسترجاع') %>
```

For Theme 7b, add ~12 new keys under the `refund.*` namespace (form labels, button text, status messages, denial reason copy). Egyptian Arabic dialect, matching Theme 10 §2D-3's catalog conventions.

### 2-I. Half-built scaffolding (P3-REFUND-N candidates)

Found during scoping; **not in scope to fix** — flagging for the audit trail:

- **P3-REFUND-N1** — `services/sla_breach.js:97-100` carries an explicit `TODO(paymob): trigger Paymob actual-money refund` comment that has never been wired. After Theme 7b, this comment should be updated to clarify that the Instapay-manual flow has replaced the Paymob-refund track and that this hook now writes a `status='auto_approved'` row that flows into the superadmin queue for manual payout. **Not a code change for Theme 7b — just a comment update; bundle with §4 Phase 1.**

- **P3-REFUND-N2** — `routes/superadmin.js:2554-2575` has a manual-payment-status endpoint that allows setting `payment_status='refunded'` on the order with no `refunds` row written. This is a stale legacy path; it'll keep working (the `refunds` table is independent) but means the `refunds` ledger doesn't capture every refund. After Theme 7b, this path should be deprecated in favour of the new `mark-paid` flow. **Out of scope; future theme.**

- **P3-REFUND-N3** — `appointment_payments.refund_status` (video appointments) is a parallel refund track entirely; the new `refunds` workflow doesn't unify with it. The two tracks have different domain semantics (video appointment payment vs. case-level refund), and unification would be a multi-week migration. **Out of scope; future theme. The superadmin dashboard will have two refund widgets — one per track — until unified.**

- **P3-REFUND-N4** — `services/sla_breach.issueBreachRefund` zeroes `urgency_uplift_amount` BEFORE the refund row is committed; if the function crashes between the INSERT and the UPDATE, the order has an inflated uplift but a refunds row exists. Idempotency saves re-runs (existing-row check), but the inconsistency window exists. Out of scope for Theme 7b (existing system-generated path; not patient-facing); flag for Theme 8 observability.

---

## 3. Proposed design

Each sub-issue ships in its own commit (or merged commits per §4 Phase ordering). All diffs are *proposed*, not applied.

### 3-A. Schema migration (`src/migrations/048_refund_workflow.sql`)

**Recommendation: extend the existing `refunds` table in-place.** Rationale:

1. **Single source of truth.** The system-generated SLA-breach refunds and the new patient-initiated refunds become rows in the same ledger, distinguishable only by `reason` (`'sla_breach'` vs e.g. `'patient_request'`) and `actor_role` (`refunded_by='system'` vs the patient's user id).
2. **`paymob_refund_id` already aligns** with Ziad's brief ("present for future hybrid flexibility"). No column rename.
3. **Smaller blast radius.** Existing readers (`services/sla_breach.js:56-62`, `services/earnings_writer.js`) keep working unchanged — added columns default to NULL.
4. **Backfill is small.** Existing rows go to `status='paid'` (system already paid them out implicitly via the uplift zero-out) with `paid_at = refunded_at`.

The alternative (new `refund_requests` table that wraps `refunds`) is more invasive and creates two-table reads on every refund display. Surfaced in **OQ-7**.

**Proposed migration:**

```sql
-- src/migrations/048_refund_workflow.sql
--
-- Extend the refunds table (migration 028) with workflow columns
-- supporting the patient-initiated refund flow (Theme 7b). Existing
-- system-generated rows (SLA-breach auto-refunds via
-- services/sla_breach.issueBreachRefund) backfill to status='paid'.
--
-- Idempotent: every column addition uses IF NOT EXISTS.
-- ...

BEGIN;

-- (a) Workflow + identity
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS requested_by TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- (b) Amount split (requested vs approved). Existing amount_egp
-- becomes the authoritative "approved/paid" amount; for new
-- patient-initiated rows, requested_amount_egp is what the patient
-- asked for and amount_egp is what got approved.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS requested_amount_egp NUMERIC(10,2);

-- (c) Patient-flow inputs
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS instapay_handle TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS instapay_reference TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS denial_reason TEXT;

-- (d) Backfill existing system-generated rows.
-- Pre-Theme-7b rows were written by services/sla_breach.issueBreachRefund
-- with refunded_by='system' and reason='sla_breach'. Treat as paid.
UPDATE refunds
   SET status = 'paid',
       paid_at = refunded_at,
       requested_amount_egp = amount_egp,
       reviewed_by = COALESCE(refunded_by, 'system'),
       reviewed_at = refunded_at
 WHERE status IS NULL;

-- (e) Status enum-as-CHECK. Postgres ENUMs are heavy here (migration
-- of values is awkward); a CHECK constraint matches the project's
-- pattern (orders.status uses TEXT + alias map, not ENUM).
ALTER TABLE refunds
  DROP CONSTRAINT IF EXISTS refunds_status_check,
  ADD CONSTRAINT refunds_status_check
    CHECK (status IN ('pending','auto_approved','approved','paid','denied'));

-- (f) NOT NULL after backfill (separate step so the backfill above
-- has a chance to land before the constraint fires).
ALTER TABLE refunds ALTER COLUMN status SET NOT NULL;

-- (g) Indexes for the queue + per-patient lookups.
CREATE INDEX IF NOT EXISTS idx_refunds_status      ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_requested_by ON refunds(requested_by);
CREATE INDEX IF NOT EXISTS idx_refunds_status_created ON refunds(status, refunded_at DESC);

-- (h) Per-order partial-unique to prevent two PENDING patient requests
-- on the same case (the patient API also enforces this in code, but
-- defense in depth — and it lets the UPDATE in §3-C use ON CONFLICT
-- if we want).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_refunds_pending_per_order
  ON refunds(order_id) WHERE status = 'pending';

COMMIT;
```

**Mapping to Ziad's brief schema:**

| Brief field | This migration | Notes |
|---|---|---|
| `id (UUID)` | `id TEXT` (existing) | Codebase convention is TEXT-keyed UUIDs (`randomUUID()`). |
| `case_id (FK → orders)` | `order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE` (existing) | Renamed; `orders` is the canonical table. |
| `patient_id (FK → users)` | `requested_by TEXT` (new) | The patient is the requester. No FK constraint to `users` (codebase convention; users.id is TEXT and not constrained elsewhere on `refunds` either). |
| `requested_amount_cents (INTEGER)` | `requested_amount_egp NUMERIC(10,2)` (new) | EGP NUMERIC matches the codebase's existing `amount_egp` and `urgency_uplift_amount NUMERIC(10,2)`. **OQ-9** confirms — Ziad's brief uses cents; codebase uses NUMERIC EGP. |
| `approved_amount_cents (INTEGER)` | `amount_egp NUMERIC(10,2)` (existing — repurposed) | The existing column becomes "approved/paid amount". `approved_amount_egp = amount_egp` post-migration. |
| `instapay_handle TEXT` | `instapay_handle TEXT` (new) | Matches brief. |
| `instapay_reference TEXT` | `instapay_reference TEXT` (new) | Matches brief. |
| `paymob_refund_id TEXT` | `paymob_refund_id TEXT` (existing) | No change. |
| `reason TEXT` | `notes TEXT` (existing) for free-form patient text + `reason TEXT` (existing) for the categorical reason | Two columns, two purposes. The existing `reason` column has values like `'sla_breach'` / `'patient_request'`; `notes` has the free-form context. **The patient's reason text goes into `notes`; `reason` becomes `'patient_request'`. OQ-10** asks whether to add a separate `patient_reason` column for clarity. |
| `denial_reason TEXT` | `denial_reason TEXT` (new) | Matches brief. |
| `status (ENUM)` | `status TEXT` + CHECK constraint (new) | CHECK matches `orders.status` pattern in this codebase. |
| `requested_by` (FK → users) | `requested_by TEXT` (new) | Matches brief. |
| `reviewed_by` (FK → users) | `reviewed_by TEXT` (new) | Matches brief. |
| `reviewed_at TIMESTAMPTZ` | `reviewed_at TIMESTAMPTZ` (new) | Matches brief. |
| `paid_at TIMESTAMPTZ` | `paid_at TIMESTAMPTZ` (new) | Matches brief. |
| `created_at TIMESTAMPTZ` | `refunded_at TIMESTAMP DEFAULT NOW()` (existing) | Repurposed semantically: existing `refunded_at` is the **request creation time** for new rows. For the backfilled system rows, request time == approval time == paid time. **OQ-9** asks whether to add a `created_at` column or rename. Recommendation: keep `refunded_at` as the canonical creation timestamp; document. |
| `updated_at TIMESTAMPTZ` | (none — would need to add) | Not in existing migration 028. **OQ-11** asks whether to add `updated_at` (with a trigger) or rely on `reviewed_at`/`paid_at` as state-change timestamps. Recommendation: skip — the per-state timestamps suffice. |

### 3-B. Patient-facing UI — `src/views/patient_order.ejs`

Add a Request Refund affordance to the Overview tab. **Skeleton (not full HTML):**

```ejs
<%# Theme 7b — Refund affordance, gated on eligibility %>
<%# eligibility passed from route handler — see §3-C %>
<% if (refundEligibility && refundEligibility.eligible && !existingRefund) { %>
  <section class="patient-overview__refund-cta">
    <h3><%= tt('refund.cta_title', 'Need a refund?', 'محتاج استرجاع المال؟') %></h3>
    <p><%= tt('refund.cta_subtitle',
              'You can request a refund. We\'ll review within 24 hours.',
              'تقدر تطلب استرجاع المال. هنراجع طلبك خلال 24 ساعة.') %></p>
    <button type="button" class="p-btn p-btn--secondary"
            data-modal-open="#refund-request-modal">
      <%= tt('refund.cta_button', 'Request refund', 'طلب استرجاع المال') %>
    </button>
  </section>

  <%# Modal form (CSRF + reason textarea + Instapay handle text input) %>
  <dialog id="refund-request-modal" class="p-modal">
    <form method="post"
          action="/portal/patient/orders/<%= order.id %>/request-refund"
          autocomplete="off" novalidate>
      <%= csrfField ? csrfField() : '' %>
      <h2><%= tt('refund.form_title', 'Request a refund', 'طلب استرجاع المال') %></h2>

      <label for="refund-reason">
        <%= tt('refund.reason_label', 'Why do you need a refund?', 'ليه محتاج استرجاع المال؟') %>
        <span class="p-required">*</span>
      </label>
      <textarea id="refund-reason" name="reason" rows="4" required
                maxlength="2000"
                placeholder="<%= tt('refund.reason_placeholder', 'Tell us...', 'قول لنا...') %>"></textarea>

      <label for="refund-instapay">
        <%= tt('refund.instapay_label', 'Instapay handle or IBAN', 'حساب الإنستاباي أو الـ IBAN') %>
        <span class="p-required">*</span>
      </label>
      <input id="refund-instapay" name="instapay_handle" type="text" required
             maxlength="120"
             placeholder="<%= tt('refund.instapay_placeholder', 'e.g. 01012345678', 'مثلاً 01012345678') %>" />

      <p class="p-hint">
        <%= tt('refund.timeline_hint',
                'Approved refunds are paid via Instapay within 3-5 business days.',
                'الطلبات المعتمدة هتتدفع عن طريق الإنستاباي خلال 3-5 أيام عمل.') %>
      </p>

      <button type="submit" class="p-btn p-btn--primary">
        <%= tt('refund.submit_button', 'Submit request', 'إرسال الطلب') %>
      </button>
    </form>
  </dialog>
<% } else if (existingRefund) { %>
  <%# Status banner — replaces the CTA once a request exists %>
  <section class="patient-overview__refund-status patient-overview__refund-status--<%= existingRefund.status %>">
    <% if (existingRefund.status === 'pending' || existingRefund.status === 'auto_approved') { %>
      <%= tt('refund.status_pending',
              'Your refund request is pending review.',
              'طلب استرجاع المال قيد المراجعة.') %>
    <% } else if (existingRefund.status === 'approved') { %>
      <%= tt('refund.status_approved',
              'Refund approved — Instapay payment is being prepared.',
              'تم اعتماد استرجاع المال — جارِ تجهيز التحويل عبر الإنستاباي.') %>
    <% } else if (existingRefund.status === 'paid') { %>
      <%= tt('refund.status_paid',
              'Refund paid via Instapay (ref: %s).',
              'تم الاسترجاع عبر الإنستاباي (مرجع: %s).')
              .replace('%s', existingRefund.instapay_reference) %>
    <% } else if (existingRefund.status === 'denied') { %>
      <%= tt('refund.status_denied',
              'Refund request denied. Reason: %s',
              'تم رفض طلب الاسترجاع. السبب: %s')
              .replace('%s', existingRefund.denial_reason) %>
    <% } %>
  </section>
<% } %>
```

The route handler at `routes/patient.js:2447` (the `GET /portal/patient/orders/:id` handler that renders this view) gets two new locals: `refundEligibility` (from `getRefundEligibility(order)` per §3-H) and `existingRefund` (the most-recent refund row for this order, or null).

### 3-C. Patient-facing API — `POST /portal/patient/orders/:id/request-refund`

New handler in `src/routes/patient.js` (proposed shape):

```js
router.post('/portal/patient/orders/:id/request-refund', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const reason = String(req.body.reason || '').trim();
  const instapayHandle = String(req.body.instapay_handle || '').trim();

  // 1. Validate inputs
  if (!reason || reason.length < 5) {
    return res.redirect(`/portal/patient/orders/${orderId}?refund_error=reason_required`);
  }
  if (!instapayHandle) {
    return res.redirect(`/portal/patient/orders/${orderId}?refund_error=instapay_required`);
  }

  // 2. Validate ownership + eligibility
  const order = await queryOne(
    "SELECT * FROM orders_active WHERE id = $1 AND patient_id = $2",
    [orderId, patientId]
  );
  if (!order) {
    return res.redirect('/dashboard?error=case_not_found');
  }
  const { getRefundEligibility } = require('../services/refund_eligibility');
  const eligibility = await getRefundEligibility(order);
  if (!eligibility.eligible) {
    return res.redirect(`/portal/patient/orders/${orderId}?refund_error=${encodeURIComponent(eligibility.reason)}`);
  }

  // 3. Idempotency — reject duplicate pending request
  const existing = await queryOne(
    "SELECT id FROM refunds WHERE order_id = $1 AND status IN ('pending','auto_approved') LIMIT 1",
    [orderId]
  );
  if (existing) {
    return res.redirect(`/portal/patient/orders/${orderId}?refund_status=already_pending`);
  }

  // 4. Compute requested amount (full case price by default; partial logic
  //    for post-IN_REVIEW cases is in the eligibility helper).
  const requestedAmount = Number(order.urgency_uplift_amount || 0) + Number(order.base_price || 0);

  // 5. Insert refund row
  const refundId = randomUUID();
  const status = eligibility.autoApprove ? 'auto_approved' : 'pending';
  await execute(
    `INSERT INTO refunds (id, order_id, status, requested_amount_egp, amount_egp,
                          instapay_handle, reason, notes, requested_by,
                          refunded_at, refunded_by)
     VALUES ($1, $2, $3, $4, $4, $5, 'patient_request', $6, $7, NOW(), $7)`,
    [refundId, orderId, status, requestedAmount, instapayHandle, reason, patientId]
  );

  // 6. Audit + notifications
  await logOrderEvent({
    orderId,
    label: status === 'auto_approved' ? 'refund_auto_approved' : 'refund_requested',
    meta: { refund_id: refundId, requested_amount_egp: requestedAmount, reason },
    actorUserId: patientId,
    actorRole: 'patient',
  });

  // Patient confirmation
  await queueMultiChannelNotification({
    orderId,
    toUserId: patientId,
    channels: ['internal', 'email'],
    template: 'patient_refund_requested',
    response: { caseRef: orderId.slice(0, 12).toUpperCase(), amount: requestedAmount },
    dedupe_key: `refund_requested:${refundId}:patient`,
  });

  // Superadmin queue alert (fan-out per active superadmin —
  // matches Theme 6 Phase 4 notifyAdmins shape)
  await notifyAdminsOfRefund({ refundId, orderId, status, requestedAmount });

  return res.redirect(`/portal/patient/orders/${orderId}?refund_status=submitted`);
});
```

**Failure modes (per the brief):**

| Failure | HTTP | Surface |
|---|---|---|
| Case not owned by patient | 302 → `/dashboard?error=case_not_found` (matches existing routes) | Generic — don't leak case-id existence |
| Case ineligible (e.g. completed) | 302 → `?refund_error=ineligible_state` | Banner on case page |
| Duplicate pending request | 302 → `?refund_status=already_pending` | Banner with link to existing request |
| Reason or Instapay handle missing | 302 → `?refund_error=reason_required` / `?refund_error=instapay_required` | Field-level error |
| DB write failure | 500 + `logErrorToDb` (matches the rest of the codebase) | Generic error page |

### 3-D. Superadmin queue — `GET /superadmin/refunds`

New page modelled on `superadmin_alerts.ejs`. Skeleton:

```ejs
<%- include('partials/superadmin_topbar') %>
<nav class="p-breadcrumb">
  <a href="/superadmin">Dashboard</a> → Refund requests
</nav>

<header class="p-page-header">
  <h1><%= tt('superadmin.refunds.title', 'Refund requests', 'طلبات الاسترجاع') %></h1>
  <a href="/superadmin" class="p-btn p-btn--ghost">← Back to dashboard</a>
</header>

<%# Filter chips: status (all / pending / auto_approved / approved / paid / denied) %>
<nav class="p-filter-bar">
  <a href="/superadmin/refunds?status=all"        class="<%= filterStatus === 'all' ? 'is-active' : '' %>">All</a>
  <a href="/superadmin/refunds?status=pending"    class="<%= filterStatus === 'pending' ? 'is-active' : '' %>">Pending (<%= counts.pending %>)</a>
  <a href="/superadmin/refunds?status=approved"   class="<%= filterStatus === 'approved' ? 'is-active' : '' %>">Approved — needs payout (<%= counts.approved %>)</a>
  <a href="/superadmin/refunds?status=paid"       class="<%= filterStatus === 'paid' ? 'is-active' : '' %>">Paid</a>
  <a href="/superadmin/refunds?status=denied"     class="<%= filterStatus === 'denied' ? 'is-active' : '' %>">Denied</a>
</nav>

<table class="p-queue-table">
  <thead>
    <tr>
      <th>Case</th><th>Patient</th><th>Requested</th><th>Approved</th>
      <th>Instapay</th><th>Reason</th><th>Status</th><th>Requested at</th><th>Actions</th>
    </tr>
  </thead>
  <tbody>
    <% rows.forEach(function(r) { %>
      <tr>
        <td><a href="/superadmin/orders/<%= r.order_id %>"><%= r.order_ref %></a></td>
        <td><%= r.patient_name %></td>
        <td><%= r.requested_amount_egp %> EGP</td>
        <td><%= r.amount_egp ? r.amount_egp + ' EGP' : '—' %></td>
        <td><%= r.instapay_handle %></td>
        <td class="p-cell--reason"><%= r.notes %></td>
        <td><span class="p-status p-status--<%= r.status %>"><%= r.status %></span></td>
        <td><%= dayjs(r.refunded_at).format('YYYY-MM-DD HH:mm') %></td>
        <td>
          <% if (r.status === 'pending' || r.status === 'auto_approved') { %>
            <form method="post" action="/superadmin/refunds/<%= r.id %>/approve" class="p-inline-form">
              <%= csrfField() %>
              <input type="number" name="amount" value="<%= r.requested_amount_egp %>" step="0.01" />
              <button class="p-btn p-btn--success" type="submit">Approve</button>
            </form>
            <button class="p-btn p-btn--danger" data-modal-open="#deny-<%= r.id %>">Deny</button>
            <%# Deny modal contains a textarea for denial_reason %>
          <% } else if (r.status === 'approved') { %>
            <form method="post" action="/superadmin/refunds/<%= r.id %>/mark-paid" class="p-inline-form">
              <%= csrfField() %>
              <input type="text" name="instapay_reference" placeholder="Instapay txn ref" required />
              <button class="p-btn p-btn--primary" type="submit">Mark paid</button>
            </form>
          <% } %>
        </td>
      </tr>
    <% }); %>
  </tbody>
</table>
```

Default filter: `status=pending`. Counts come from a single GROUP BY query.

### 3-E. Superadmin actions API

Three POST routes, all under `requireSuperadmin`:

```js
// POST /superadmin/refunds/:id/approve
//   body: { amount: numeric, notes?: string }
router.post('/superadmin/refunds/:id/approve', requireSuperadmin, async (req, res) => {
  const refundId = req.params.id;
  const approvedAmount = Number(req.body.amount);
  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
    return res.redirect('/superadmin/refunds?error=invalid_amount');
  }
  const refund = await queryOne("SELECT * FROM refunds WHERE id = $1", [refundId]);
  if (!refund || !['pending', 'auto_approved'].includes(refund.status)) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }
  await execute(
    `UPDATE refunds
        SET status = 'approved',
            amount_egp = $1,
            reviewed_by = $2,
            reviewed_at = NOW()
      WHERE id = $3 AND status IN ('pending','auto_approved')`,
    [approvedAmount, req.user.id, refundId]
  );
  await logOrderEvent({
    orderId: refund.order_id,
    label: 'refund_approved',
    meta: { refund_id: refundId, approved_amount_egp: approvedAmount },
    actorUserId: req.user.id,
    actorRole: 'superadmin',
  });
  await queueMultiChannelNotification({
    orderId: refund.order_id,
    toUserId: refund.requested_by,
    channels: ['internal', 'email'],
    template: 'patient_refund_approved',
    response: { caseRef: refund.order_id.slice(0, 12).toUpperCase(), amount: approvedAmount },
    dedupe_key: `refund_approved:${refundId}:patient`,
  });
  return res.redirect(`/superadmin/refunds?status=approved&just_approved=${refundId}`);
});

// POST /superadmin/refunds/:id/deny
//   body: { denial_reason: string (required) }
router.post('/superadmin/refunds/:id/deny', requireSuperadmin, async (req, res) => {
  const refundId = req.params.id;
  const denialReason = String(req.body.denial_reason || '').trim();
  if (!denialReason) {
    return res.redirect('/superadmin/refunds?error=denial_reason_required');
  }
  const refund = await queryOne("SELECT * FROM refunds WHERE id = $1", [refundId]);
  if (!refund || !['pending', 'auto_approved'].includes(refund.status)) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }
  await execute(
    `UPDATE refunds
        SET status = 'denied',
            denial_reason = $1,
            reviewed_by = $2,
            reviewed_at = NOW()
      WHERE id = $3 AND status IN ('pending','auto_approved')`,
    [denialReason, req.user.id, refundId]
  );
  await logOrderEvent({ ... label: 'refund_denied' ... });
  await queueMultiChannelNotification({
    ...
    template: 'patient_refund_denied',
    response: { caseRef, denialReason },
    ...
  });
  return res.redirect('/superadmin/refunds?status=denied');
});

// POST /superadmin/refunds/:id/mark-paid
//   body: { instapay_reference: string (required) }
router.post('/superadmin/refunds/:id/mark-paid', requireSuperadmin, async (req, res) => {
  const refundId = req.params.id;
  const ref = String(req.body.instapay_reference || '').trim();
  if (!ref) {
    return res.redirect('/superadmin/refunds?error=instapay_ref_required');
  }
  const refund = await queryOne("SELECT * FROM refunds WHERE id = $1", [refundId]);
  if (!refund || refund.status !== 'approved') {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }
  await execute(
    `UPDATE refunds
        SET status = 'paid',
            instapay_reference = $1,
            paid_at = NOW()
      WHERE id = $2 AND status = 'approved'`,
    [ref, refundId]
  );
  await logOrderEvent({ ... label: 'refund_paid' ... meta: { instapay_reference: ref } ... });
  await queueMultiChannelNotification({
    ...
    template: 'patient_refund_paid',
    response: { caseRef, amount: refund.amount_egp, ref },
    ...
  });
  return res.redirect('/superadmin/refunds?status=paid');
});
```

State-machine guarantees enforced via the `WHERE status IN (...)` clause on each UPDATE — if a concurrent action already advanced the row, the second UPDATE matches zero rows (idempotent, no double-fire).

### 3-F. Notifications

**New template constants** (add to `src/notify/templates.js`):

```js
PATIENT_REFUND_REQUESTED:   'tashkheesa_refund_requested',
PATIENT_REFUND_APPROVED:    'tashkheesa_refund_approved',
PATIENT_REFUND_DENIED:      'tashkheesa_refund_denied',
PATIENT_REFUND_PAID:        'tashkheesa_refund_paid',
ADMIN_REFUND_QUEUED:        'admin_refund_queued',
```

**Notification titles** (`src/notify/notification_titles.js`) — bilingual EN+AR for in-app:

```js
patient_refund_requested:  { en: 'Refund request submitted',     ar: 'تم استلام طلب الاسترجاع' },
patient_refund_approved:   { en: 'Refund approved',              ar: 'تم اعتماد طلب الاسترجاع' },
patient_refund_denied:     { en: 'Refund denied',                ar: 'تم رفض طلب الاسترجاع' },
patient_refund_paid:       { en: 'Refund paid via Instapay',     ar: 'تم تحويل المبلغ عبر الإنستاباي' },
admin_refund_queued:       { en: 'New refund request',           ar: 'طلب استرجاع جديد' },
```

**WhatsApp template registry** (`src/notify/whatsappTemplateMap.js`) — new entries with the same shape as `sla_breach`. **OQ-5** asks whether to skip WhatsApp for the denial template (Meta template approval lag).

**`notifyAdminsOfRefund` helper** — mirrors Theme 6 Phase 4's `notifyAdmins` shape. Add to `src/notify.js` (or as a shared helper alongside `dispatchSlaBreach` since both are admin fan-outs):

```js
async function notifyAdminsOfRefund({ refundId, orderId, status, requestedAmount }) {
  const recipients = await queryAll(
    "SELECT id FROM users WHERE role = 'superadmin' AND COALESCE(is_active, true) = true"
  );
  for (const r of recipients) {
    await queueNotification({
      orderId,
      toUserId: r.id,
      channel: 'internal',
      template: 'admin_refund_queued',
      response: JSON.stringify({ refund_id: refundId, status, amount_egp: requestedAmount }),
      dedupe_key: `refund_queued:${refundId}:${r.id}`,
    });
  }
}
```

### 3-G. Audit trail

No new code surface — `audit.logOrderEvent` is already in place. Per §3-C/§3-E, every state change writes a row with the appropriate label. The patient case timeline (`patient_order.ejs` Overview tab) and the superadmin order detail (`/superadmin/orders/:id`) both render `order_events` ordered by `at DESC`. Add five new `meta` payload schemas to a documentation table in `docs/PAYOUT_AND_URGENCY_POLICY.md` so the labels and their meta shape are captured for future maintainers.

### 3-H. Eligibility helper — `src/services/refund_eligibility.js`

```js
'use strict';

const { CASE_STATUS, normalizeStatus } = require('../case_lifecycle');

/**
 * Determines whether a patient-initiated refund request is eligible
 * for the given order, and whether it should auto-approve.
 *
 * @param {object} order - canonical orders row (or orders_active row)
 * @param {object} [opts] - optional overrides for testing
 * @returns {{
 *   eligible: boolean,
 *   reason: string,             // canonical reason key (i18n keyable)
 *   autoApprove: boolean,       // true → status starts as 'auto_approved'
 *   blockingStatus: string|null // current order.status if not eligible
 * }}
 *
 * Policy (Ziad's approved approach):
 *   - Pre-doctor-accept (statuses: NEW, SUBMITTED, PAID, ASSIGNED,
 *     REASSIGNED): eligible + autoApprove. Case never received service.
 *   - Post-IN_REVIEW (status IN_REVIEW or REJECTED_FILES, paid): eligible,
 *     review-required. Superadmin negotiates case-by-case for the first
 *     30 days; after that, codify policy.
 *   - Post-COMPLETED: not eligible (case fulfilled). Superadmin can
 *     still write a row manually via admin UI as an explicit override.
 *   - Cancelled, expired_unpaid, sla_breach refund already issued:
 *     not eligible (no money to return for unpaid; sla_breach uplift
 *     already refunded).
 *   - Unpaid (payment_status NOT IN ('paid','captured')): not eligible.
 */
function getRefundEligibility(order, opts = {}) {
  if (!order) return { eligible: false, reason: 'order_not_found', autoApprove: false, blockingStatus: null };

  // Must be paid to be refundable.
  const ps = String(order.payment_status || '').toLowerCase();
  if (ps !== 'paid' && ps !== 'captured') {
    return { eligible: false, reason: 'not_paid', autoApprove: false, blockingStatus: order.status };
  }

  const canonicalStatus = normalizeStatus(order.status);
  const PRE_DOCTOR_ACCEPT = new Set([
    CASE_STATUS.NEW, CASE_STATUS.SUBMITTED, CASE_STATUS.PAID,
    CASE_STATUS.ASSIGNED, CASE_STATUS.REASSIGNED,
  ]);
  const REVIEW_REQUIRED = new Set([
    CASE_STATUS.IN_REVIEW, CASE_STATUS.REJECTED_FILES,
  ]);

  if (PRE_DOCTOR_ACCEPT.has(canonicalStatus)) {
    return { eligible: true, reason: 'pre_doctor_accept', autoApprove: true, blockingStatus: null };
  }
  if (REVIEW_REQUIRED.has(canonicalStatus)) {
    return { eligible: true, reason: 'post_in_review_review_required', autoApprove: false, blockingStatus: null };
  }
  if (canonicalStatus === CASE_STATUS.COMPLETED) {
    return { eligible: false, reason: 'case_completed', autoApprove: false, blockingStatus: canonicalStatus };
  }
  if (canonicalStatus === CASE_STATUS.CANCELLED) {
    return { eligible: false, reason: 'case_cancelled', autoApprove: false, blockingStatus: canonicalStatus };
  }
  if (canonicalStatus === CASE_STATUS.SLA_BREACH) {
    return { eligible: false, reason: 'sla_breach_uplift_already_refunded', autoApprove: false, blockingStatus: canonicalStatus };
  }
  // Unknown / drift status — fail-closed.
  return { eligible: false, reason: 'unknown_status', autoApprove: false, blockingStatus: order.status };
}

module.exports = { getRefundEligibility };
```

The helper is consumed by:
- `routes/patient.js` GET handler at `:2447` — to decide whether to render the "Request refund" CTA.
- `routes/patient.js` POST `/portal/patient/orders/:id/request-refund` — to gate the create.
- (Optional) `routes/superadmin.js` GET `/superadmin/refunds` — to flag rows where `autoApprove` was true but the patient still got `status='pending'` (defensive — surfaces logic drift).

---

## 4. Implementation plan

### Phase ordering

| Phase | Sub-issues | Estimate | Dependencies | Lands in |
|---|---|---|---|---|
| **Phase 1 — schema + helper** | A + H | 5h | none | Single commit (`fix(refund): add status workflow to refunds table + eligibility helper (Theme 7b Phase 1)`) — schema migration 048 + new `services/refund_eligibility.js` + unit-style source-grep test for the helper. |
| **Phase 2 — patient flow** | B + C + F-patient + G-patient | 7h | Phase 1 | One commit (`fix(refund): patient refund-request flow (Theme 7b Phase 2)`) — view changes to `patient_order.ejs`, new POST handler, two new templates (`patient_refund_requested`, plus the in-app title strings), audit `refund_requested` / `refund_auto_approved` labels. Patient flow is end-to-end: a request can be submitted; the row exists; the patient sees "pending" banner. Superadmin actions don't exist yet — rows accumulate in `status='pending'`. |
| **Phase 3 — superadmin flow** | D + E + F-admin + G-admin | 7h | Phase 2 | One commit (`fix(refund): superadmin queue + approve/deny/mark-paid (Theme 7b Phase 3)`) — new queue page, three POST routes, three more templates (`patient_refund_approved`, `_denied`, `_paid`, plus admin `admin_refund_queued`), audit `refund_approved` / `refund_denied` / `refund_paid` labels. Closes the loop. |
| **Phase 4 — i18n catalog + WhatsApp templates + docs** | F-WA + (catalog) | 1h + Meta approval cycle (24-48h) | Phase 3 (template names finalised) | One commit (`fix(refund): i18n catalog + WhatsApp template registration (Theme 7b Phase 4)`) — adds the ~15 `refund.*` keys to `src/i18n.js`, adds entries to `src/notify/whatsappTemplateMap.js`. The Meta-side template approval is OUT-OF-BAND (Ziad submits via the Meta Business Suite — not a code change). Until Meta approves, WhatsApp falls back to email-only for refund states (the `queueMultiChannelNotification` path already handles this gracefully). |

**Total: 20h** (~3 days, with a 24-48h wall-clock wait for Meta WhatsApp approval before WhatsApp delivery actually fires).

### Why this ordering?

- Phase 1 unblocks both patient and admin code; the migration must land first regardless.
- Phase 2 ships a "halfway useful" feature (patient can submit; admin gets in-app notification). If Phase 3 slips, the platform is still better than today (refund requests are captured and visible in `order_events` even without UI).
- Phase 3 closes the loop. If the superadmin queue UI takes longer than expected, an emergency manual workflow is: superadmin runs the per-row UPDATE in Supabase SQL Editor + sends a manual email. The new templates are nice-to-have after that fallback.
- Phase 4 is post-functional; the email path works without it.

### Behind a feature flag?

Recommendation: NO. The feature is greenfield (no patient action exists today; no UI changes to existing flows; no risk of regression). Each phase is independently shippable.

OQ-12 asks whether to gate behind a `REFUND_FLOW_ENABLED` env var anyway as a safety hatch.

---

## 5. Verification steps

### V1 — Patient can request a refund

1. **Manual UAT:** as a patient with a paid case in `IN_REVIEW` state, navigate to `/portal/patient/orders/:id`. The Overview tab shows the "Request refund" CTA. Click → modal opens. Fill reason + Instapay handle → submit. Page redirects with `?refund_status=submitted` banner.
2. **DB check:** `SELECT * FROM refunds WHERE order_id = '<the case id>'` returns one row with `status='pending'`, `requested_by` = patient's user id, `notes` = the reason text, `instapay_handle` = the input.
3. **Audit check:** `SELECT * FROM order_events WHERE order_id = '<the case id>' AND label = 'refund_requested'` returns one row with `actor_user_id` = patient.
4. **Notification check:** the patient receives an in-app notification `patient_refund_requested` and an email; every active superadmin gets an in-app `admin_refund_queued` notification.
5. **Idempotency check:** submit a second request from the same UI (refresh + repeat). The endpoint redirects with `?refund_status=already_pending`. No second row inserted (verified by the partial unique index `uniq_refunds_pending_per_order`).

### V2 — Eligibility rules enforced

For each policy state, a UAT trace:

| Order state | Expected | How to verify |
|---|---|---|
| `NEW` (paid, no doctor) | CTA shown; submit → `status='auto_approved'` | DB row + audit label `refund_auto_approved` |
| `IN_REVIEW` (doctor accepted) | CTA shown; submit → `status='pending'` | DB row |
| `COMPLETED` | CTA hidden; direct POST returns `?refund_error=ineligible_state` | curl test from a logged-in patient session |
| `CANCELLED` | CTA hidden; same | same |
| Unpaid | CTA hidden; same | same |
| Already-pending refund | CTA replaced with "pending" banner | View source check |
| Already-paid refund | CTA replaced with "paid" banner showing reference | View source check |

### V3 — Superadmin approve/deny/mark-paid

1. With a `status='pending'` row from V1, navigate to `/superadmin/refunds`. The row appears in the "Pending" filter.
2. Approve with the requested amount → row status → `approved`. Patient receives `patient_refund_approved` notification + email.
3. (Outside the system: superadmin issues Instapay payment manually, copies the bank-confirmation reference.)
4. Mark paid with the Instapay reference → row status → `paid`. Patient receives `patient_refund_paid` notification + email with the reference.
5. Audit trail: `order_events` has three new rows (`refund_approved`, `refund_paid`) plus the original `refund_requested` from V1.
6. Try to approve an already-approved row (concurrency) → second UPDATE matches zero rows; redirect with `?error=invalid_state`. No double-fire of notifications.

### V4 — Notifications fire correctly + WhatsApp degrades gracefully

1. Set `WHATSAPP_ENABLED=false` (or the equivalent env-flag the codebase uses) and verify all four patient-facing notification templates still arrive via email-only. `queueMultiChannelNotification` handles this.
2. With `WHATSAPP_ENABLED=true` but the new Meta templates not yet approved, verify the WhatsApp send path returns `failed` in `notifications.status` (per `notification_worker`'s retry shape) and email still arrives. Patient is not blocked on Meta approval.
3. After Meta approves, the next refund event should send WhatsApp + email + internal cleanly.

### V5 — Migration 048 is safe to apply

1. **Local dry-run:** `BEGIN; <full migration>; ROLLBACK;` against the local DB executes cleanly (mirrors the Theme 7 hotfix's verification pattern).
2. **Backfill check:** existing system-generated rows (production has 0 today; local has 0) come back as `status='paid'`. Manually insert a synthetic system-generated row pre-migration; re-run the migration; assert it lands in `status='paid'`.
3. **`services/sla_breach.issueBreachRefund` regression:** integration test that a fresh SLA breach still writes a refunds row with `reason='sla_breach'` and the new status field defaults sensibly. Recommendation: have `issueBreachRefund` set `status='paid'` explicitly on insert (since system-generated breach refunds have always been treated as paid-at-time-of-write); update the INSERT in §4 Phase 1.

---

## 6. What to add to the test suite

All tests in `tests/core/`, source-grep style matching the Theme 1/3/5/6/7 pattern.

### T1 — `theme7b-refund-eligibility-helper.test.js`

Pure unit-style. Imports `services/refund_eligibility.getRefundEligibility` and runs it against a matrix of synthetic order objects:

```js
const cases = [
  { name: 'paid + NEW',           order: { payment_status: 'paid', status: 'NEW' },        expect: { eligible: true,  autoApprove: true } },
  { name: 'paid + IN_REVIEW',     order: { payment_status: 'paid', status: 'IN_REVIEW' },  expect: { eligible: true,  autoApprove: false } },
  { name: 'paid + COMPLETED',     order: { payment_status: 'paid', status: 'COMPLETED' },  expect: { eligible: false, reason: 'case_completed' } },
  { name: 'unpaid + NEW',         order: { payment_status: null,   status: 'NEW' },        expect: { eligible: false, reason: 'not_paid' } },
  { name: 'paid + CANCELLED',     order: { payment_status: 'paid', status: 'CANCELLED' },  expect: { eligible: false, reason: 'case_cancelled' } },
  { name: 'paid + SLA_BREACH',    order: { payment_status: 'paid', status: 'SLA_BREACH' }, expect: { eligible: false, reason: 'sla_breach_uplift_already_refunded' } },
  // ... cover every CASE_STATUS value
];
```

### T2 — `theme7b-refund-routes-shape.test.js`

Source-grep. Asserts:
- `routes/patient.js` has `router.post('/portal/patient/orders/:id/request-refund', requireRole('patient')`
- `routes/superadmin.js` has the three superadmin POST routes with `requireSuperadmin`
- All four endpoints invoke `csrfField`-protected forms in their corresponding views (regex: `<form method="post" action="/portal/patient/orders/[^"]+/request-refund"` includes `<%= csrfField`)

### T3 — `theme7b-migration-048-shape.test.js`

Source-grep on `src/migrations/048_*.sql`:
- `CREATE INDEX IF NOT EXISTS uniq_refunds_pending_per_order` (partial unique)
- `CHECK (status IN (...))` constraint with all five states
- All required columns added with `IF NOT EXISTS`
- BEGIN/COMMIT wrapper

### T4 — `theme7b-refund-state-transitions.test.js`

Integration-style (requires DB). For a synthetic order:
1. Insert `refunds` row via the patient POST route (or a direct INSERT mimicking the route's shape).
2. Walk through pending → approved → paid via the three superadmin routes (or direct UPDATEs).
3. Assert each state transition (a) succeeds when the source state is correct, (b) fails (zero-row UPDATE) when the source state is already advanced, (c) writes the corresponding `order_events` row.
4. Walk through pending → denied separately (terminal denial state).

### T5 — `theme7b-refund-notifications-shape.test.js`

Source-grep:
- `notify/templates.js` declares all five new template constants (`PATIENT_REFUND_REQUESTED`, etc.).
- `notify/notification_titles.js` has bilingual EN+AR for each.
- The patient route uses `queueMultiChannelNotification` for patient-facing templates, not `queueNotification` (so email + WhatsApp are wired).
- The admin fan-out helper (`notifyAdminsOfRefund` or equivalent) selects active superadmins and applies per-recipient dedupe key suffix (matches Theme 6 Phase 4's `notifyAdmins` shape).

### T6 — `theme7b-refund-eligibility-gates-ui.test.js`

Source-grep on `src/views/patient_order.ejs`:
- The "Request refund" CTA is wrapped in `<% if (refundEligibility && refundEligibility.eligible && !existingRefund) { %>`
- The status banner branch covers all four states (`pending`, `approved`, `paid`, `denied`).
- Form action URL matches the POST route exactly.
- `csrfField()` is rendered inside the form.

### T7 — Existing regression coverage

Verify no new failures in:
- `theme7-*.test.js` (49 assertions) — the refunds table change is additive; the `services/sla_breach` writer keeps working.
- `theme6-*.test.js` (35 assertions) — the new `notifyAdminsOfRefund` helper mirrors the existing `notifyAdmins` shape; the lint test should pass.

---

## 7. Rollback plan

| Phase | Files touched | Rollback cost |
|---|---|---|
| 1 — schema + helper | `src/migrations/048_refund_workflow.sql` (new), `src/services/refund_eligibility.js` (new) | `git revert <sha>` of the commit. The migration's column additions are `IF NOT EXISTS` and the backfill is idempotent — re-running adds no harm; rolling back the *column* requires a manual `ALTER TABLE refunds DROP COLUMN`, which is destructive only if patient-initiated rows exist. Before any patient flow lands, this is zero-risk. |
| 2 — patient flow | `src/routes/patient.js` (one new POST + view-locals on existing GET), `src/views/patient_order.ejs` (additive section), `src/notify/templates.js` (one new constant), `src/notify/notification_titles.js` (one new pair) | `git revert <sha>` removes the UI; existing rows in `refunds` with `status='pending'` remain (data preserved). Re-deploy of the same commit is safe (the `notify` constant added doesn't conflict with anything). |
| 3 — superadmin flow | `src/routes/superadmin.js` (three new POSTs + queue GET + dashboard widget), `src/views/superadmin_refunds.ejs` (new), `src/notify/templates.js` (three more), `src/notify/notification_titles.js` (three more pairs) | Same as Phase 2 — safe revert; data preserved. The queue UI disappears but the underlying rows stay queryable via Supabase. |
| 4 — i18n + WA | `src/i18n.js` (catalog additions), `src/notify/whatsappTemplateMap.js` (entries) | Safe revert; default-language fallbacks (English) take over for any unrendered keys. WhatsApp send path falls back to email-only via existing `queueMultiChannelNotification` shape. |

**Render rollback path:** if any of Phase 1-3 triggers an unexpected production behaviour, Render's "Rollback to previous deploy" UI restores the prior commit in <2 min. SLA: pre-launch, no patient-facing degradation since the refund flow is greenfield.

**Data rollback:** rolling back the migration after patient-initiated rows exist is **not safe** — those rows have `status` values not present in pre-Theme-7b schema. Recovery in that scenario would require either (a) re-applying the migration (idempotent), or (b) manually deleting the patient-initiated rows in Supabase before column drops. **OQ-13** asks whether to add a DB backup checkpoint before Phase 1 ships.

---

## 8. Open questions for Ziad

**OQ-1 — Schema reconciliation: extend `refunds` (recommended) vs. new `refund_requests` table.** §3-A's recommendation is to extend the existing `refunds` table in-place. The alternative is to create a new `refund_requests` table and treat `refunds` as the "paid out" ledger only; pending/approved requests live in `refund_requests`, and on `mark-paid` we copy a row across. **Recommendation: extend in-place** (single source of truth, smaller surface, fewer joins). Confirm before §3-A's migration is written.

**OQ-2 — Patient refund history view.** Brief asked: "Whether to build a full refund history view for patients (showing all their refund requests across all cases) or just per-case visibility." **Recommendation: per-case for v1.** Most patients have ≤1 case; a global history view is YAGNI. Add later as a "/portal/patient/refunds" route if patients ask. Confirm.

**OQ-3 — Patient-cancel-pending-refund.** Brief asked: "Whether the patient should be able to cancel a pending refund request before superadmin reviews." **Recommendation: yes, with a 1-hour window.** The patient might submit then change their mind; allowing self-cancel within a short window reduces superadmin queue noise without enabling abuse (no money has moved). Implementation: a small `POST /portal/patient/orders/:id/refund-request/cancel` route that flips status to a new state `'cancelled_by_patient'` (or just hard-deletes the row + writes an audit event). **Recommendation: hard-delete + audit event, since `'cancelled_by_patient'` adds another enum value.** Confirm.

**OQ-4 — Default refund amount for post-IN_REVIEW cases.** Brief asked. Three options:
  - (a) Full case price (matches "we couldn't deliver"). Implementation: `requestedAmount = base_price + urgency_uplift_amount`.
  - (b) Pro-rated based on time spent in IN_REVIEW (proxy for service value delivered). No precedent in the codebase; needs a policy + math.
  - (c) Always require superadmin to enter the amount (default = 0 → must edit). Patient submits "I want a refund"; superadmin decides.
  **Recommendation: (a) for simplicity in v1**, with the superadmin-side approval form letting them edit down to a partial. Codifies "full refund for non-completion" as the default; partials are a deliberate operator decision. Confirm.

**OQ-5 — Estimated refund timeline copy + WhatsApp template approval.** Brief asked: "Whether to surface an estimated refund timeline to the patient ('expect 3-5 business days for Instapay')." **Recommendation: yes, surface "3-5 business days" in both the form (pre-submit) and the approved-state banner (post-approval).** AND the WhatsApp template approval cycle: skip WhatsApp for the denial template (Meta tends to reject negative-tone templates) and ship denial as email-only. Approval + paid-state can use WhatsApp once Meta approves. Confirm both.

**OQ-6 — Email template language for the denial case.** Brief asked. Per the patient-friendly tone of the rest of the codebase, the denial template should: lead with the decision, give the reason verbatim from the superadmin's denial_reason field, link to the case page, point to support. Recommendation: draft email body as part of Phase 4 (i18n catalog) and review with Ziad before Meta WhatsApp template submission. Confirm.

**OQ-7 — Single-step "approve and mark paid" combined action vs. always two-step.** Brief asked. **Recommendation: always two-step** — separation between "we agree to refund" (a decision) and "money has actually left our hands" (an event with an Instapay reference) is policy-relevant. The combined action would lose the audit fidelity. Confirm — if Ziad wants the combined action, add a `POST /superadmin/refunds/:id/approve-and-mark-paid` that takes both fields and writes both transitions atomically, with a single `refund_paid` event (skip the intermediate `refund_approved`).

**OQ-8 — Defensive: hardcoded `'admin_alert'` fan-out vs. follow notify.js patterns.** The new `notifyAdminsOfRefund` helper duplicates the per-recipient fan-out shape from Theme 6 Phase 4's `notifyAdmins` (in `video_scheduler.js`) and Theme 7 Phase 2's `dispatchSlaBreach` (in `notify.js`). **Recommendation: factor into a shared helper at `src/notify.js` exported as `notifyAdmins({ template, payload, dedupeKey, orderId })`.** Migrate the two existing callsites to use it (small refactor, ships in the same Phase 1 commit). Confirm willingness to bundle that small refactor. If no, keep `notifyAdminsOfRefund` local to the refund path.

**OQ-9 — Cents (INTEGER) vs. NUMERIC EGP.** Brief schema used `requested_amount_cents (INTEGER)`. Codebase consistently uses `NUMERIC(10,2)` EGP for monetary values (`refunds.amount_egp`, `orders.urgency_uplift_amount`, `services.base_price`). **Recommendation: stay with NUMERIC EGP** for consistency with the existing `refunds.amount_egp`. No fractional cents have ever appeared in production; switching to integer cents would require a one-shot data conversion of every monetary column (multi-week migration). Confirm.

**OQ-10 — `notes` (free-form patient text) vs. dedicated `patient_reason` column.** §3-A reuses the existing `notes` column for the patient's free-form reason. The categorical `reason` column (existing) holds `'sla_breach'` | `'patient_request'`. **Recommendation: a dedicated new column `patient_reason TEXT` (nullable)** — separates the patient-supplied free-form text from operator notes. The operator might want to add a note ("Patient called and clarified...") on top of the patient's original reason; conflating them is bad UX. Adds one more column to migration 048. Confirm.

**OQ-11 — `updated_at` column on `refunds`.** Codebase has mixed conventions — `orders` has `updated_at`, `refunds` doesn't. **Recommendation: skip** — the per-state timestamps (`refunded_at` for create, `reviewed_at`, `paid_at`) provide finer-grained audit. Adding `updated_at` with a trigger is more code for less information. Confirm.

**OQ-12 — Feature flag (`REFUND_FLOW_ENABLED`).** §4 recommends NO. The feature is greenfield with no risk of regression. **Recommendation: skip the flag.** If Ziad disagrees, gate the patient POST + the queue page behind `process.env.REFUND_FLOW_ENABLED === 'true'`; the migration runs unconditionally (DDL is independent). Confirm.

**OQ-13 — DB backup checkpoint before Phase 1.** Standard practice for a schema migration that touches a table with production data is to take a Supabase point-in-time backup before running. Migration 048 is purely additive (column adds + idempotent backfill) so the risk is minimal, but per the production discipline established by the Theme 7 hotfix earlier today, a backup is cheap insurance. **Recommendation: yes, take a Supabase backup before pushing Phase 1.** Document in Phase 1's commit message. Confirm.

**OQ-14 — Existing "manual payment-status refund" path (P3-REFUND-N2).** `routes/superadmin.js:2554-2575` lets superadmin set `payment_status='refunded'` directly without writing a `refunds` row. Recommendation: deprecate that path in Phase 3's commit (replace the in-place UPDATE with a redirect to the new `/superadmin/refunds` queue, with a pre-filled "create refund" affordance). Adds ~2h to Phase 3. **Or punt to a future theme.** Ziad's call.

---

*End of Theme 7b scoping. No source files modified; only this report file is committed.*
