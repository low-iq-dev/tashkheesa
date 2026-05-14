# Theme 14 — AI Specialty Classifier + Manual Queue Routing: Fix Plan

**Status:** v2 — all §8 decisions locked 2026-05-14. Beginning phased execution.
**Drafted:** 2026-05-14 (v1: initial scoping) · 2026-05-14 (v2: decisions locked, phased plan)
**Author:** Claude Code (scoping pass) + Ziad (decisions)

## 1. Executive Summary

Today, the wizard's Step 3 ("Choose specialty") only shows specialties that already have an active doctor on the panel. With the active-doctor count currently at **0 for every specialty in prod** (pre-launch staffing state, verified 2026-05-14 via `SELECT COUNT(*) FROM users WHERE role='doctor' AND is_active=true GROUP BY specialty_id`), the wizard either renders an empty Step 3 or — if the POST handler is reached — fails with `err=specialty_unavailable` (`src/routes/patient.js:1567-1569`). Patient-facing recommendation must not depend on supply-side doctor capacity.

Theme 14 inverts the relationship:

1. After Step 2 (files uploaded + intake text captured), an AI classifier reads the patient's chief complaint and the structured data already extracted from uploaded files, and recommends ONE specialty from the canonical list with a confidence score and one-line reasoning.
2. Step 3 shows the recommendation prominently. The patient confirms or overrides.
3. The order persists with the chosen specialty regardless of doctor availability.
4. Backend post-payment routing decides: if a tier-eligible doctor exists, auto-assign via the existing `src/auto_assign.js` path; otherwise the order lands in a **manual assignment queue** that superadmin works.

Net effect: classification is supply-blind, assignment is supply-aware, and the wizard never gates on staffing.

Per the locked §8 decisions, three confidence tiers shape the UI: **≥0.95 produces a locked recommendation (no patient override available)**, **0.55–0.94 allows override under an SLA-disclaimer modal that strips refund eligibility for that order**, and **<0.55 routes the case directly to the operator manual queue with no patient-side specialty pick**. The classifier itself reads from a runtime query over `specialties WHERE is_visible = true` (currently 22 rows; no static enum baked into code).

## 2. Current State

### 2a. Step 3 today — doctor-availability gated

**View (GET render):** `src/routes/patient.js:1305-1324` populates the specialty list:

```sql
SELECT s.id, s.name, s.name_ar, COALESCE(d.active_count, 0) AS active_count
FROM specialties s
LEFT JOIN (
  SELECT specialty_id, COUNT(*) AS active_count
  FROM users WHERE role = 'doctor' AND COALESCE(is_active, true) = true
  GROUP BY specialty_id
) d ON d.specialty_id = s.id
WHERE COALESCE(s.is_visible, true) = true
  AND COALESCE(d.active_count, 0) > 0
ORDER BY d.active_count DESC, s.name ASC
```

**Submit (POST validate):** `src/routes/patient.js:1561-1569` re-checks the same predicate server-side and redirects with `err=specialty_unavailable` if no active doctor exists.

**Patient-facing copy:** `src/views/patient_new_case.ejs:349-418` renders the specialty cards. Each card carries `data-specialty-id`; a `limited` badge fires when `active_count === 1`. No reasoning shown — patient picks blind.

### 2b. Specialty inventory in production

Live query 2026-05-14 (28 rows total, 22 with `is_visible = true`):

```
Visible:    Anesthesiology, Cardiology, Cardiothoracic Surgery, Clinical Nutrition,
            Dermatology, Emergency Medicine, Endocrinology, Gastroenterology,
            Hematology, Nephrology, Neurology, OB/GYN, Oncology, Ophthalmology,
            Orthopedics, Pathology, Psychiatry, Pulmonology, Radiology,
            Rheumatology, Urology, Vascular Surgery

Hidden:     Add-on Services (synthetic; not a specialty),
            ENT, General Surgery, Internal Medicine, Lab & Pathology, Pediatrics
```

Active doctors per specialty right now: **0 across all 28** — confirms the wizard's Step 3 is unusable in this configuration.

**Open inconsistency to resolve in §8 Q-extra:** Ziad's brief references "16 canonical specialties per `Tashkheesa_Canonical_Pricing_v4.xlsx`." Prod has 22 visible / 28 total. Either the canonical list is a subset, or some prod rows are seed cruft, or the xlsx is stale. The AI classifier's specialty enum must align with whichever list is canonical (otherwise it returns specialties the order pipeline can't accept).

### 2c. Existing AI integration

**Module:** `src/case-intelligence.js` (handles document extraction post-upload).
**Config:** `src/config/anthropic.js` exposes `modelSonnet()` / `modelHaiku()` / `modelVision()`. Defaults: `claude-sonnet-4-6` (extraction + chat), `claude-haiku-4-5` (fast triage), `claude-sonnet-4-6` (vision).

**Existing prompt** (`EXTRACTION_SYSTEM_PROMPT` + `EXTRACTION_USER_PROMPT`, `case-intelligence.js:20-36`):
- System: "You are a medical document data extractor. … NEVER interpret, diagnose, summarize findings, or add clinical commentary. Extract only. Never interpret."
- User: returns `{document_category, language, lab_values[], patient_info{name, age, gender, complaint, medications, allergies, family_history}}`.
- **Does NOT classify specialty.** The "never interpret" guardrail is deliberate — extraction is strict. Specialty classification is interpretation, so it needs its own prompt with explicit permission to reason about routing (not diagnosis).

**Aggregation:** `aggregateCaseData(caseId)` at `case-intelligence.js:329-` merges all file-level structured data into a single per-case object. Fields available to a specialty classifier: `patient_info.complaint`, lab abnormalities (rows with `status='above'|'below'`), `documents_inventory` (which document categories are present), `missingDocuments` array. This is the right input surface — the classifier should consume the **aggregated** view, not raw file text.

### 2d. Assignment pipeline today

**Module:** `src/auto_assign.js` (`autoAssignDoctor(orderId)`).
**Trigger:** pg-boss queue `auto-assign`, kicked from `src/job_queue.js:160` after order events.
**Behavior:**
1. Reads `orders_active` row (id, specialty_id, doctor_id, status, urgency_tier).
2. Calls `eligibleDoctorsFor({specialtyId, tier})` — tier-filtered.
3. If empty pool: logs `[auto-assign] No active doctors for specialty …` or `No tier-eligible doctor` (distinguishes specialty-empty from tier-empty); writes `logSlaRoutingShortage` audit; returns `{assigned: false, reason: 'no_doctors_available'}`.
4. Otherwise: picks lowest active-caseload doctor (tie-break: name ASC), `UPDATE orders SET doctor_id = $1`, logs `Order auto-assigned to doctor …` event, fires `order_auto_assigned_doctor` notification.

**Key insight:** there's already a state for "order exists, specialty chosen, no doctor yet" — `orders.doctor_id IS NULL` with non-null `specialty_id`. The auto-assign worker already produces this terminal state for `no_doctors_available`. What's missing is a **manual queue UI** for superadmin to see these orders and a tag/flag that distinguishes "queued for manual" from "currently being auto-assigned."

### 2e. Manual-assignment surface today

`/superadmin/orders` routes (`src/routes/superadmin.js`):
- `GET /superadmin/orders/new` (line 1444) — create order form
- `POST /superadmin/orders` (1479) — create handler
- `GET /superadmin/orders/trash` (1631) — soft-deleted view
- `GET /superadmin/orders/:id` (1662) — order detail
- Approve / reject additional-files routes (1729, 1839)
- Mark-paid (2403)

There is **no `/superadmin/orders/unassigned` queue today.** A superadmin currently has to spelunk through the full orders list and filter mentally on `doctor_id IS NULL`. Theme 14 needs to surface this queue explicitly.

### 2f. What this theme does NOT touch

- Pricing snapshot logic (already specialty-aware via `services` table).
- Wizard Steps 1, 2, 4, 5 (intake → upload → tier → pay). Step 4's pricing depends only on `service_id` which is downstream of `specialty_id`.
- Doctor-side flows (acceptance, SLA, completion).
- Patient ↔ doctor messaging.
- Notification templates (existing `order_auto_assigned_doctor` continues to fire when assignment lands).

## 3. Root Cause

Not a bug — a design inversion. The wizard was built assuming a staffed marketplace ("show what's available"). The product reality is that the AI should drive recommendation independent of staffing, and operations should solve the supply problem on the back end. Three concrete consequences of the current design that Theme 14 closes:

1. **Pre-launch dead-state:** with zero active doctors, Step 3 is empty and the wizard is unusable. Reverse-direction launch blocker.
2. **Cold-start specialty bias:** even post-launch, the existing query sorts specialties by `active_count DESC`, surfacing the most-staffed specialty first. This is anti-clinical — the patient should see what their data actually maps to, not what's overstaffed today.
3. **No semantic recommendation:** the patient picks blind. Domain knowledge ("a chest X-ray + dyspnea probably means pulmonology") is locked up in clinicians' heads and not surfaced. The AI has all the structured intake data — it should reason on it.

## 4. Fix Plan

### Sub-issue A — AI specialty classifier prompt + helper in `src/case-intelligence.js`

**New exported function:** `classifySpecialty({caseAggregate, patientComplaint, language}) → {specialty_id, confidence, reasoning, alternates: [{specialty_id, confidence}]}`.

- **Model:** `modelHaiku()` (`claude-haiku-4-5`). Classification is a triage-shape task; Haiku is calibrated for cost and latency, and the input is already-structured aggregated data, not raw documents.
- **System prompt** (new — NOT augmenting `EXTRACTION_SYSTEM_PROMPT`, which has an interpretation-forbidden guardrail we must preserve): "You are a medical triage routing assistant. Given a patient's chief complaint and structured findings, recommend the single best specialty for case review from a fixed list. You are routing, not diagnosing — never produce diagnoses, treatment plans, or clinical advice. Output JSON only."
- **User prompt:** receives `{complaint, age, gender, lab_abnormalities[], document_categories[], free_text_intake}` plus the canonical specialty enum (see Q1 in §8 — which list?). Asks for `{specialty_id, confidence (0.0–1.0), reasoning (≤140 chars), alternates: top-3-with-confidence}`.
- **Guardrails:** JSON-only output; specialty_id must be in the supplied enum (post-parse validation); if confidence < threshold (Q2) → return `specialty_id: null` with explicit `uncertain: true`.
- **Observability:** every classification call writes a row to a new `specialty_classifications` table (caseId, specialty_id, confidence, reasoning, alternates_json, model, prompt_hash, latency_ms, created_at). Required for both audit and the human-validation feedback loop Ziad will likely want post-launch.
- **Cost:** Haiku 4.5 at ~$1/Mtok input × ~500 tokens/case ≈ $0.0005/case. Negligible.

### Sub-issue B — Step 3 view rewrite

**File:** `src/views/patient_new_case.ejs:344-440`.

- Replace the "browse all specialties" card grid with a single recommendation card showing: specialty name (EN/AR), one-line reasoning, "Continue with [Specialty]" primary button, and "Change specialty" secondary link.
- "Change specialty" expands the legacy grid (now showing ALL visible specialties regardless of doctor count — supply blind, per §1).
- Confidence band shapes the card UI (Q4 locked):
  - **≥ 0.95 (locked):** card renders recommendation with primary CTA "Continue with [Specialty]". **No override link.** Patient cannot deviate.
  - **0.85–0.94 (auto-confirm + override):** card renders recommendation with primary CTA, plus a secondary "Different specialty?" link. Click → SLA-disclaimer modal (verbatim copy in Sub-issue F).
  - **0.55–0.84 (show-recommendation + override):** card framed as "This might be [Specialty]"; CTAs equal-weight. Same SLA-disclaimer modal on override.
  - **< 0.55 (manual review):** no recommendation card. Copy reads "Our team will route this case manually". Step 3 advances on continue; the order persists with `specialty_id=NULL`, `assignment_status='manual_pending'`, and lands in the superadmin manual queue (Sub-issue D).
- "Why?" collapsed-by-default toggle renders the AI's `reasoning` verbatim (Q3 locked). The prompt enforces routing-tone — diagnostic phrasing is banned (see Sub-issue A's system message).
- On any override, the POST handler logs to `specialty_classification_overrides` and sets `orders.no_sla_refund_eligibility = true` (see Sub-issue C).

### Sub-issue C — Backend assignment logic

**Files:** `src/routes/patient.js:1546-1591` (POST step3), `src/auto_assign.js`, `src/job_queue.js:107-114`.

- POST step3 drops the `docCount === 0 → specialty_unavailable` redirect (`patient.js:1567-1569`). Service-validity check (`patient.js:1571-1579`) stays.
- **Override path** (per Q4 lock): if the submitted `specialty_id` differs from the classifier's stored top-pick for this case, the POST handler:
  1. Inserts a row into a new `specialty_classification_overrides` table (`case_id, ai_specialty_id, ai_confidence, patient_specialty_id, override_at, override_reason TEXT NULL`).
  2. Sets `orders.no_sla_refund_eligibility = true`. The breach-refund machinery (`src/services/refund_eligibility.js` + `src/services/earnings_writer.js`) reads this flag and short-circuits refund computation when set. Aligns with Ziad's locked Q4: the patient took responsibility for the delay, so the SLA refund promise does not apply.
  3. The locked recommendation tier (confidence ≥ 0.95) has no override path in the UI; if a forged form somehow submits a mismatch, the POST handler rejects with `err=override_not_permitted`.
- After payment lands (`payments.js` post-Paymob success — wire site TBD during planning), the existing `auto-assign` job fires.
- `autoAssignDoctor` already returns `{assigned: false, reason: 'no_doctors_available'}` when the pool is empty. **Extend it** to set a new `orders.assignment_status` column with values `'auto'` (default), `'manual_pending'` (auto failed OR confidence < 0.55 OR forced override of locked tier), `'manual_claimed'` (superadmin claimed it), `'assigned'` (terminal). Migration adds: `orders.assignment_status`, `orders.no_sla_refund_eligibility` (boolean, default false), the `specialty_classifications` audit table (Sub-issue A), and the `specialty_classification_overrides` table.
- Auto-assign logs the failure reason in a new `assignment_attempts` row (or extends `logSlaRoutingShortage` audit table — TBD during planning).

### Sub-issue D — Superadmin manual queue UI

- New route: `GET /superadmin/orders/manual-queue` — lists orders where `assignment_status = 'manual_pending'` AND `payment_status = 'paid'`. Sort: SLA deadline ASC (most urgent first).
- New view: `src/views/superadmin_manual_queue.ejs`. Columns: case ref, specialty, urgency tier, SLA deadline (clock-ticking display), patient name, "Claim" + "Assign to doctor X" actions.
- New action route: `POST /superadmin/orders/:id/manual-assign` — body `{doctor_id}` — sets `doctor_id`, flips `assignment_status='assigned'`, fires the same `order_auto_assigned_doctor` notification (because to the doctor and patient, it should look identical to an auto-assignment).
- Optional: claim flow ("I'm working on this") to prevent two superadmins double-handling. Whether to build this v1 is Q5 in §8.

### Sub-issue E — Confidence threshold + uncertainty handling

Three thresholds, all live-tunable via `admin_settings` (Ziad-locked names + defaults):

- `classifier_threshold_lock` (default **0.95**): at or above this, the recommendation is locked — UI hides the override link entirely. Per Q4: patient cannot deviate.
- `classifier_threshold_auto` (default **0.85**): at or above this (but below lock), the recommendation card defaults the CTA to "Continue with [Specialty]" + secondary "Different specialty?" link that opens the SLA-disclaimer modal.
- `classifier_threshold_minimum` (default **0.55**): at or above this (but below auto), recommendation framed as "this might be" with equal-weight override path. **Below this:** no recommendation; Step 3 advances and the order routes directly to the operator manual queue (`assignment_status='manual_pending'`, `specialty_id` stays NULL).

The classifier emits `specialty_id: null, confidence: 0` (forcing the sub-minimum path) when the alternates' confidence spread is small (e.g. top-1 vs top-2 < 0.10) — genuine ambiguity is a manual-review signal, not a low-confidence guess.

### Sub-issue F — Patient-facing copy

EN + AR strings for:
- Recommendation card title (high-confidence): "We recommend: [Specialty]" / "نوصي بـ: [Specialty]"
- Recommendation card title (mid-confidence): "This might be [Specialty]" / "ربما يكون [Specialty]"
- Reasoning toggle label: "Why?" / "لماذا؟" (only shown if Q3 = yes)
- Override link: "Change specialty" / "تغيير التخصص"
- Uncertain state: "We need a bit more info — please pick the closest match" / "نحتاج لمزيد من المعلومات — اختر الأقرب"
- Manual-queue patient notification (when payment lands but no doctor yet): "Your case is being assigned to the right specialist — you'll get a notification within X hours" (X = ops SLA target; see Q6 in §8 re: payment timing).

All strings via `tt()` helper; no hard-coded English in views.

**Verbatim copy (Ziad-locked):**

- **SLA-disclaimer modal** (shown when patient clicks "Different specialty?" at confidence 0.55–0.94):
  > "Selecting a different specialty than recommended may delay your case. Tashkheesa carries no responsibility for delays from manual specialty changes. Continue?"
  >
  > `[Cancel]` `[Continue with my choice]`

- **Payment promise** (Step 5, before pay button — per Q6 locked):
  > "Your case will be assigned to a [Specialty] doctor within X hours. If we cannot assign within that window, you receive a full refund per our SLA policy."
  >
  > `X` resolves from `admin_settings.assignment_sla_hours` (default 6h — to be confirmed with ops before launch).

- **Routing-tone reasoning example** (Q3 locked, baked into Sub-issue A's system prompt):
  - ✓ ROUTING: "Your case mentions cardiac symptoms, which fall under Cardiology specialty review."
  - ✗ DIAGNOSTIC (banned): "You have cardiac arrhythmia."

### Sub-issue G — Regression tests

- **Unit tests** for `classifyCase` (Phase 1 deliverable): mocked Anthropic response → assert specialty_id in the runtime-fetched enum, confidence in [0,1], reasoning length ≤ 140, JSON-only output rejection on invalid model output, sub-minimum spread triggers `{specialty_id: null, confidence: 0}`.
- **Prompt guardrail tests:** assert that the system prompt contains the routing-tone constraint and the diagnostic-tone ban. Snapshot-test the prompt to prevent silent regressions to the guardrail wording.
- **Integration test:** end-to-end wizard Step 2 → Step 3 with a stubbed classifier, assert Step 3 renders the correct tier UI:
  - confidence 0.97 → no "Different specialty?" link present
  - confidence 0.90 → link present, modal opens on click
  - confidence 0.70 → equal-weight CTAs, modal opens on click
  - confidence 0.30 → no recommendation card; "Our team will route this case manually" copy
- **Boundary tests:** confidence at exactly 0.55 / 0.85 / 0.95 — strict-greater-than vs ≥ semantics matter.
- **Override flag propagation:** patient overrides at confidence 0.80 → assert `specialty_classification_overrides` row written AND `orders.no_sla_refund_eligibility=true` AND `refund_eligibility.isEligibleForRefund({reason:'sla_breach'})` returns false for this order.
- **Locked tier override-rejection:** simulate a forged POST step3 with `specialty_id` ≠ AI's locked-tier pick → assert handler responds with `err=override_not_permitted` and no override row written.
- **Boot test:** confirm `assignment_status`, `no_sla_refund_eligibility`, `specialty_classifications`, `specialty_classification_overrides` migrations apply cleanly to the prod schema snapshot used in `tests/lint/migration-applies.test.js`.
- **Negative path:** classifier returns specialty_id not in the runtime enum → POST step3 falls back to the manual-review path with `err=ai_recommendation_invalid`.
- **Manual queue:** assert that an order with `assignment_status='manual_pending'` shows up in `/superadmin/orders/manual-queue` and disappears after `POST /superadmin/orders/:id/manual-assign` lands.

### Sub-issue summary table

| Sub-issue | Phase | Scope | Files touched | Migration? | Notification template? |
|---|---|---|---|---|---|
| A — Classifier | **1** | `classifyCase` helper + new prompt | new `src/services/specialty_classifier.js` (NOT in `case-intelligence.js`) | Yes (`specialty_classifications` audit table) | No |
| B — Step 3 view | **2** | Recommendation card with 3 tiers + locked variant + override modal | `src/views/patient_new_case.ejs`, `src/routes/patient.js` (GET handler) | No | No |
| F — Copy | **2** | EN/AR strings + verbatim modal + payment-promise text | `src/views/patient_new_case.ejs`, `src/views/superadmin_manual_queue.ejs`, payment view | No | No |
| C — Backend routing | **3** | Drop docCount gate, add `assignment_status` + override SLA flag | `src/routes/patient.js`, `src/auto_assign.js`, `src/job_queue.js`, `src/services/refund_eligibility.js`, `src/services/earnings_writer.js` | Yes (`orders.assignment_status`, `orders.no_sla_refund_eligibility`, `specialty_classification_overrides`) | No (reuses existing) |
| E — Thresholds | **4** | `admin_settings` keys + classifier gating + superadmin UI | `src/services/specialty_classifier.js`, `src/routes/admin.js` settings UI | Migration (3 default rows in `admin_settings`: `classifier_threshold_lock`, `classifier_threshold_auto`, `classifier_threshold_minimum`) | No |
| D — Manual queue | **5** | New route + view + claim/contact/assign workflow | `src/routes/superadmin.js`, `src/views/superadmin_manual_queue.ejs` | No (uses Sub-issue C's columns) | No (reuses existing) |
| G — Tests | **6** | Unit + integration + boundary + override + migration apply | `tests/` (~6-8 new files) | No | No |

**Execution sequence (Ziad-locked):** Phase 1 (A) → Phase 2 (B + F) → Phase 3 (C) → Phase 4 (E) → Phase 5 (D) → Phase 6 (G). Each phase = one atomic commit. Show diff + tests before commit; no push without per-phase approval. Surface deviations immediately.

## 5. Verification Steps

### 5a. Pre-deploy (local)

- `node tests/run.js` green (Sub-issue G's new tests included).
- Manual wizard walkthrough: as a test patient, complete Step 1 + Step 2 with a known-input intake ("chest pain, lab report showing elevated troponin"); assert Step 3 surfaces Cardiology with confidence ≥ 0.85.
- Classifier dev-DB fixture: 10 hand-crafted case aggregates with expected specialty labels → assert top-1 accuracy ≥ 9/10 before merging.

### 5b. Pre-cutover (staging)

- Confirm `specialty_classifications` table migration applies + has expected indices.
- Confirm `orders.assignment_status` column defaults to `'auto'` for existing rows; sweep query: `SELECT assignment_status, COUNT(*) FROM orders GROUP BY 1` returns 100% `'auto'` post-migration.
- Confirm classifier latency p95 < 2 seconds against a synthetic batch.
- Stub Anthropic API → confirm graceful fallback (recommendation card hidden, legacy grid shown).

### 5c. Production cutover

- Deploy behind a feature flag `SPECIALTY_AI_ENABLED` (env var, off by default).
- After deploy, smoke-test with the flag off — wizard should behave identically to today.
- Flip flag on for staff users only first (allowlist by user_id), walk the flow live.
- 24h staff dogfood window. Watch `specialty_classifications` table for confidence distribution; tune Q2 thresholds in `admin_settings` if needed.
- Flag flip to all users.

### 5d. Post-cutover monitoring

- Daily query: top-1 confidence distribution histogram. Right-skew toward 1.0 = good; flat = the classifier isn't differentiating; left-skew = data is too sparse.
- Daily query: patient override rate (patient picked a non-recommended specialty). If > 30% sustained, classifier prompt needs revision or the canonical list is mis-scoped.
- Daily query: manual-queue depth (`assignment_status='manual_pending'` count + age). If sustained > 24h on any row, ops attention needed — not a Theme 14 bug but a staffing signal.

## 6. Test Coverage Required

| Layer | Test | Owner |
|---|---|---|
| Classifier prompt | Top-1 accuracy ≥ 90% on 10-case fixture | A |
| Classifier output | JSON-only, specialty_id in enum, confidence ∈ [0,1] | A |
| Wizard view | Recommendation card renders with right specialty, override grid works | B |
| Wizard POST | `specialty_unavailable` redirect dropped, service-validity check retained | C |
| Auto-assign | `assignment_status` transitions: `auto → assigned` OR `auto → manual_pending` | C |
| Manual queue | Order with `manual_pending` listed; claim action transitions to `assigned` | D |
| Threshold gating | Confidence at exactly 0.55 / 0.85 routes correctly | E |
| i18n | All new strings present in EN + AR maps | F |
| Migration | `specialty_classifications` + `orders.assignment_status` apply cleanly | G |
| Boot | No regression in `tests/lint/migration-applies.test.js` | G |
| End-to-end (manual) | Walk Step 1 → 5 as a test patient; assert correct routing | G |

## 7. Rollback Plan

**Layer 1 — Feature flag** (~30 sec to recover):
- Flip `SPECIALTY_AI_ENABLED=false` in Render env. Step 3 reverts to legacy grid; classifier helper short-circuits.
- Existing orders with `assignment_status='manual_pending'` remain queued; auto-assign continues working for new orders that pick a staffed specialty.

**Layer 2 — Threshold tune** (no deploy):
- If AI is over-confident on the wrong specialty, raise `AI_SPECIALTY_AUTO_CONFIRM_THRESHOLD` to e.g. 0.95 via `admin_settings`. Patient sees "this might be …" instead of "we recommend …". No code change.

**Layer 3 — Migration revert** (~10 min):
- `assignment_status` column is additive — drop via reverse migration if needed; existing data unaffected.
- `specialty_classifications` table is audit-only; drop is safe.
- Manual-queue route + view: feature-flag-gated; flag-off effectively unmounts.

**Layer 4 — Full revert:**
- `git revert` the theme commits. Worst case ~15 min including redeploy.

**What rollback explicitly does NOT cover:**
- Cases that have already been routed to `manual_pending` and claimed by a superadmin — those are normal `assigned` orders post-claim and won't revert.

## 8. Decisions (locked 2026-05-14)

All eight scoping questions were resolved by Ziad in the same session that produced this plan. Recorded verbatim below; the §4 sub-issues, §6 tests, and the verbatim copy in Sub-issue F derive directly from these decisions. Anything that contradicts §8 takes precedence over earlier sections — §8 is the source of truth.

### Q1 — When does classification run? **DECIDED: once at case-create.**

Classifier fires after Step 2 (file uploads complete + intake text saved + extraction aggregation done). Result is stored on the case row (the `specialty_classifications` audit table holds the full output; `orders` carries the chosen `specialty_id`). Re-classification is **not** patient-triggerable; it is an explicit operator action (a superadmin-only "re-classify" button in the manual queue UI, Sub-issue D). Rationale: aggregate inputs don't materially change between Step 3 render and submit, so re-running on every render burns API calls for no signal; auto-re-classifying on patient edits opens a fairness gap (different patients get different recommendations from the same intake).

### Q2 — Confidence thresholds. **DECIDED: 0.95 / 0.85 / 0.55, all live-tunable via `admin_settings`.**

Three thresholds, three tiers:
- **≥ 0.95** → auto-confirm AND lock UI (no override). `admin_settings.classifier_threshold_lock = 0.95`.
- **0.85–0.94** → auto-confirm with override path. `admin_settings.classifier_threshold_auto = 0.85`.
- **0.55–0.84** → show-recommendation with override path.
- **< 0.55** → manual review. `admin_settings.classifier_threshold_minimum = 0.55`.

All three thresholds are stored in `admin_settings` and read at classification time so Ziad can tune post-launch without a deploy.

### Q3 — Show AI reasoning to patient? **DECIDED: yes, collapsed "Why?" toggle. Prompt MUST enforce routing-tone, NOT diagnostic.**

Reasoning is rendered verbatim from the classifier output (≤140 chars). The UI toggle is collapsed by default — the patient sees the recommendation cleanly and can expand if they want context.

**Critical prompt constraint** (baked into Sub-issue A's `SYSTEM_PROMPT`):
- ✓ **ROUTING tone** (allowed): "Your case mentions cardiac symptoms, which fall under Cardiology specialty review."
- ✗ **DIAGNOSTIC tone** (BANNED): "You have cardiac arrhythmia."

The classifier is a router, not a doctor. The system prompt states this explicitly, includes the routing/diagnostic example pair, and instructs the model to refuse diagnostic framing. The Sub-issue G test suite snapshot-tests the prompt so a future edit cannot silently weaken this guardrail.

### Q4 — Allow patient to override AI recommendation? **DECIDED: confidence-tiered (revised from initial scoping).**

The initial scoping recommended "always allow override." Ziad revised this:

- **≥ 0.95 (locked):** NO override available. UI hides the alternative-specialty option entirely. Server-side POST handler rejects mismatched submissions with `err=override_not_permitted` (defense against forged forms).
- **0.55–0.94 (override allowed under disclaimer):** override link present. On click, modal renders:
  > "Selecting a different specialty than recommended may delay your case. Tashkheesa carries no responsibility for delays from manual specialty changes. Continue?"
  >
  > `[Cancel]` `[Continue with my choice]`
- **On confirm:** insert row into `specialty_classification_overrides` (case_id, ai_specialty_id, ai_confidence, patient_specialty_id, override_at, override_reason TEXT NULL), route per patient's choice, set `orders.no_sla_refund_eligibility = true`. The breach-refund machinery reads this flag and skips SLA-breach refund computation for this order — the patient took responsibility for the delay.

### Q5 — Manual queue UI. **DECIDED: new dedicated `/superadmin/orders/manual-queue` screen.**

Separate from the existing `/superadmin/orders` general queue. Features:
- SLA-clock visualisation per case (countdown display, banded by urgency tier).
- Filter controls: by specialty + by case age.
- Per-row actions: **Claim** (set `assignment_status='manual_claimed'` and stamp `manual_claimed_by` to prevent two superadmins double-handling), **Contact** (open in-app message thread / patient WhatsApp), **Assign to doctor** (POST `/superadmin/orders/:id/manual-assign` with body `{doctor_id}`).
- On assign: flips `assignment_status='assigned'`, sets `orders.doctor_id`, fires the existing `order_auto_assigned_doctor` notification (to patient and doctor, the experience is identical to an auto-assignment).

### Q6 — Payment timing in manual queue. **DECIDED: charge at Step 5 with explicit assignment promise.**

Verbatim Step 5 copy (before pay button):
> "Your case will be assigned to a [Specialty] doctor within X hours. If we cannot assign within that window, you receive a full refund per our SLA policy."

`X` resolves at render time from `admin_settings.assignment_sla_hours` (default to be confirmed with ops before launch — likely 6h). The existing SLA breach handler (`src/case_sla_worker.js`) extends to cover assignment-SLA, not just doctor-acceptance-SLA. Wires into the existing breach-refund machinery in `docs/PAYOUT_AND_URGENCY_POLICY.md` §4 — `reason='sla_breach' → full clawback` already in the earnings code.

Note: when `orders.no_sla_refund_eligibility = true` (Q4 override path), this promise is invalidated for that specific order. The Step 5 copy reflects this — the modal in Q4 was the moment the patient knowingly opted out of the SLA promise.

### Q7 — Augment existing extraction prompt OR new endpoint? **DECIDED: new endpoint, new file.**

`src/services/specialty_classifier.js` is a new module. It uses Haiku via `modelHaiku()` from `src/config/anthropic.js`. It does **not** touch `src/case-intelligence.js`'s `EXTRACTION_SYSTEM_PROMPT`.

Rationale (Ziad-confirmed): the extraction prompt has an explicit "never interpret" guardrail that is mature, reliable, and central to clinician trust. Specialty classification is interpretation (routing logic). Mixing the two prompts dilutes the extraction guardrail and increases the risk of diagnostic-flavored output bleeding into the doctor-facing structured data view. Separation also lets the two prompts iterate independently and use different model tiers (Sonnet for extraction, Haiku for classification).

### Q-extra — Canonical specialty list. **DECIDED: dynamic, runtime query over `specialties WHERE is_visible = true`. `routable` flag is a post-launch evolution.**

The classifier reads the live specialty list at classification time (not from a static enum baked into code). Currently 22 visible specialties in prod (`SELECT id, name FROM specialties WHERE is_visible = true ORDER BY name`). The list is passed into the classifier's user prompt as a JSON enum.

Implications:
- The xlsx-referenced "16 canonical" is treated as a launch-scope subset that may or may not match the visible 22 — irrelevant at the classifier level because the source of truth is `specialties.is_visible`.
- Toggling a specialty `is_visible = false` in `admin_settings` (or via the existing superadmin specialty management UI) removes it from the classifier's enum on the next case immediately, no deploy.
- The 6 currently-hidden rows (Add-on Services, ENT, General Surgery, Internal Medicine, Lab & Pathology, Pediatrics) stay excluded from classification until ops decides otherwise.
- Post-launch, if ops wants the routable set to be narrower than the visible set (e.g. hide a specialty from the patient-facing classifier without hiding it from operator-driven assignments), add a `routable` boolean column to `specialties` and key the classifier query on that instead of `is_visible`. Not v1 scope.

---

## §8 surfacing summary

All §8 decisions are locked. Phased execution begins immediately:

- **Phase 1** (Sub-issue A): `src/services/specialty_classifier.js` + mocked-Anthropic unit tests.
- **Phase 2** (Sub-issue B + F): Step 3 view rewrite + verbatim copy + override modal.
- **Phase 3** (Sub-issue C): Backend assignment logic + `assignment_status` + `no_sla_refund_eligibility` flag.
- **Phase 4** (Sub-issue E): `admin_settings` thresholds + superadmin UI.
- **Phase 5** (Sub-issue D): Manual queue route + view + claim/contact/assign workflow.
- **Phase 6** (Sub-issue G): Regression tests across all sub-issues.

Per the Ziad-locked execution rules: each phase is one atomic commit; show diff before commit; **no push without per-phase approval**; surface deviations explicitly.
