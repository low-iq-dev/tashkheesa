# Add-on Service Abstraction — Design Doc

**Status:** APPROVED 2026-04-24. Phase 2 build in progress.
**Owner:** Ziad
**Date:** 2026-04-24 (rev 1 — commission model + prescription split corrected)
**Branch:** `fix/portal-batch-apr24`
**Scope:** Phases 1–5 described below.

## 0. Commission model (authoritative)

The Tashkheesa commission split is **two-tier**, not flat:

| Product type       | Platform share | Doctor share |
|--------------------|---------------:|-------------:|
| Main service (case fee, urgency tier)                  | **80%** | **20%** |
| Add-ons (video consult, prescription, future add-ons)  | **20%** | **80%** |
| SLA-style add-ons (no doctor work)                     | **100%** |   **0%** |

**Rationale:** platform takes the bulk on the main service (acquisition
+ infra + brand); doctor takes the bulk on add-ons (they do the extra
work on top of the case).

Consequence for the refactor:

- The existing `80` fallback at `src/routes/video.js:135` and `:173`
  is **correct** — video is an add-on.
- The `70` DEFAULT on `services.video_doctor_commission_pct` in
  `src/migrations/002_column_additions.sql:50` and on
  `services.doctor_commission_pct` at `:62` is **wrong** for add-ons.
- `addon_services.doctor_commission_pct` defaults to **80** (see §2.1.1
  seed table below).
- Main-service commission is computed elsewhere (not in the add-on
  registry); the 20%-to-doctor rule on cases stays unchanged in this
  refactor.
- Before Phase 4 cutover the copy at `src/views/doctor_profile.ejs:459-461`
  ("you keep 80%") must be verified: if it refers to video/add-on
  earnings → keep as-is; if it refers to main-case earnings → it's
  wrong and must say 20%. The commit that lands the commission fix
  carries that verification.

---

## 1. Current-state audit

### 1.1 Video consultation

A full bespoke subsystem, introduced in migration `004_video_consultation.sql`.
Lives across four dedicated tables (`appointments`, `video_calls`,
`appointment_payments`, `doctor_earnings`), one dedicated route file
(`src/routes/video.js`, ~1,386 lines), and its own payment-callback
branch at `src/routes/payments.js:213-243`. Patient-selected presence
is additionally flagged on `orders.video_consultation_selected` and
locked-in price on `orders.video_consultation_price`; the same selection
is mirrored into `orders.addons_json`. Doctor commission split lives on
`services.video_doctor_commission_pct` (defaulted to 70% in migration
002) but the route code hardcodes `80` as a fallback (`src/routes/video.js`
— flagged as a separate blocker, see §6). Pricing is **not** driven by
`tashkheesa_pricing_v2.xlsx`: `services.video_consultation_price` and
`services.video_consultation_prices_json` are seeded separately. The
lifecycle has booking + Paymob checkout + doctor acceptance + pre-call
+ Twilio room + completion events.

### 1.2 24-hour SLA upgrade

A pure flag with no lifecycle. Stored as `orders.sla_24hr_selected`
BOOLEAN + `orders.sla_24hr_price` DOUBLE + mirrored into
`orders.addons_json`. Pricing sourced from `services.sla_24hr_price`
(fallback 100 EGP) or `services.sla_24hr_prices_json`. Payment-callback
branch at `src/routes/payments.js:246-302` updates `orders.sla_hours`
and logs a `sla_24h_addon_selected` audit event. No fulfillment step
(the SLA is enforced by the existing `case_sla_worker.js`); no doctor
commission of its own — the SLA affects the case timer, nothing else.

### 1.3 Prescription

The shallowest of the three. Selected via patient checkbox, mirrored
to `orders.addons_json` with `{"prescription": true, "prescription_price": <n>}`.
Pricing is a hand-rolled lookup against `service_regional_prices` for
`service_id='addon_prescription'` (fallback 350 EGP), referenced at
`src/routes/payments.js:311` and `src/routes/patient.js:1355`. **No
lifecycle exists beyond the flag**: no doctor-side workflow to attach
a prescription, no patient-side delivery, no commission row, no refund
path if the case completes without one. The feature is effectively
vaporware today.

### 1.4 Shared pathology

All three add-ons:

- Store presence as a JSON blob in `orders.addons_json` (text column,
  not jsonb).
- Are detected in the payment callback via separate `if (addon === '1')`
  branches, each with its own SQL and event-log call.
- Have their pricing resolved in 3–4 different files with no shared
  helper.
- Share no interface, no registry, and no lifecycle abstraction.

The copy-paste cost to add a fourth add-on (e.g. "second-opinion rush
tier" or "translated report add-on") is O(N) — every new add-on re-invents
payment detection, pricing lookup, storage, audit logging, and display.

---

## 2. Proposed abstraction

### 2.1 Database schema

Two new tables. Both purely additive — old columns stay intact for
the duration of the migration.

#### 2.1.1 `addon_services` (registry of available add-ons)

```sql
CREATE TABLE addon_services (
  id                        TEXT PRIMARY KEY,         -- slug: 'video_consult', 'sla_24hr', 'prescription'
  type                      TEXT NOT NULL,            -- enum (text): 'video_consult' | 'sla_upgrade' | 'prescription'
  name_en                   TEXT NOT NULL,
  name_ar                   TEXT NOT NULL,
  description_en            TEXT,
  description_ar            TEXT,
  base_price_egp            INTEGER NOT NULL,         -- whole EGP (matches orders.price convention)
  prices_json               JSONB,                    -- multi-currency override, e.g. {"EGP": 400, "SAR": 100, "AED": 95}
  doctor_commission_pct     INTEGER NOT NULL DEFAULT 80,
  has_lifecycle             BOOLEAN NOT NULL DEFAULT false,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  sort_order                INTEGER NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addon_services_active ON addon_services (is_active, sort_order);
```

Seeded at migration time with three rows:

| id              | type           | base_price_egp | doctor_commission_pct | has_lifecycle |
|-----------------|----------------|---------------:|----------------------:|--------------:|
| video_consult   | video_consult  |            200 |                    80 |          true |
| sla_24hr        | sla_upgrade    |            100 |                     0 |         false |
| prescription    | prescription   |            400 |                    80 |          true |

All add-on commissions follow the §0 rule: 80% doctor / 20% platform
for anything a doctor does extra work on; 0% doctor for SLA-style
upsells where the platform does all the work.

Migration `019` additionally backfills the `services` table to resolve
the 70/80 default bug at the source:

```sql
-- Fix the misleading default (see §6)
ALTER TABLE services ALTER COLUMN video_doctor_commission_pct SET DEFAULT 80;
ALTER TABLE services ALTER COLUMN doctor_commission_pct       SET DEFAULT 80;

-- Backfill the handful of rows stuck at 70. Safe — every row the live
-- code path touches already returns 80 via the video.js fallback; this
-- just makes the column match what the code already produces.
UPDATE services SET video_doctor_commission_pct = 80 WHERE video_doctor_commission_pct = 70;
UPDATE services SET doctor_commission_pct       = 80 WHERE doctor_commission_pct       = 70;
```

The `80` fallbacks at `src/routes/video.js:135` and `:173` can now be
removed once the backfill is verified (Phase 4 prep work).

#### 2.1.2 `order_addons` (instances attached to orders)

```sql
CREATE TABLE order_addons (
  id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  addon_service_id                    TEXT NOT NULL REFERENCES addon_services(id),
  status                              TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' (attached, not paid)
    -- 'paid'    (payment confirmed; awaiting fulfillment — or immediately fulfilled for sla_upgrade)
    -- 'fulfilled' (doctor-side step complete, e.g. video held / prescription attached)
    -- 'cancelled' (patient cancelled before payment)
    -- 'refunded'  (paid but never fulfilled; refund owed)
  price_at_purchase_egp               INTEGER NOT NULL,     -- locked base-EGP price at checkout
  price_at_purchase_currency          TEXT    NOT NULL,     -- 'EGP' | 'SAR' | 'AED' | …
  price_at_purchase_amount            INTEGER NOT NULL,     -- locked amount in that currency
  doctor_commission_pct_at_purchase   INTEGER NOT NULL,     -- locked at checkout; guards against mid-lifecycle pct changes
  doctor_commission_amount_egp        INTEGER,              -- computed on fulfillment; NULL until then
  metadata_json                       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- video_consult: { appointment_id, twilio_room, call_duration_seconds, ... }
    -- prescription:  { pdf_storage_key, text_body, attached_at, attached_by }
    -- sla_24hr:      { original_sla_hours, new_sla_hours, deadline_iso }
  refund_pending                      BOOLEAN NOT NULL DEFAULT false,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at                        TIMESTAMPTZ,
  cancelled_at                        TIMESTAMPTZ,
  refunded_at                         TIMESTAMPTZ
);

CREATE INDEX idx_order_addons_order    ON order_addons (order_id);
CREATE INDEX idx_order_addons_status   ON order_addons (status);
CREATE INDEX idx_order_addons_pending_refund ON order_addons (refund_pending) WHERE refund_pending = true;
CREATE UNIQUE INDEX idx_order_addons_order_service ON order_addons (order_id, addon_service_id);
```

The last unique index enforces "one instance of each add-on per order"
— today's behavior across all three existing add-ons.

#### 2.1.3 `addon_earnings` (doctor payout per fulfilled add-on)

Parallel to the existing `doctor_earnings` table (which holds
appointment-scoped video earnings) but keyed off `order_addons.id`.
Kept separate so Phase 2 is purely additive — the old
`doctor_earnings` table is neither read nor written by the new code.

```sql
CREATE TABLE addon_earnings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_addon_id         UUID NOT NULL REFERENCES order_addons(id) ON DELETE CASCADE,
  doctor_id              TEXT NOT NULL,
  gross_amount_egp       INTEGER NOT NULL,        -- locked EGP at fulfill
  commission_pct         INTEGER NOT NULL,        -- snapshot of locked pct
  earned_amount_egp      INTEGER NOT NULL,        -- gross * pct / 100, rounded
  status                 TEXT    NOT NULL DEFAULT 'pending',
    -- 'pending' | 'paid'
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at                TIMESTAMPTZ
);

CREATE INDEX idx_addon_earnings_doctor       ON addon_earnings (doctor_id);
CREATE INDEX idx_addon_earnings_order_addon  ON addon_earnings (order_addon_id);
CREATE UNIQUE INDEX idx_addon_earnings_once  ON addon_earnings (order_addon_id);
```

The `UNIQUE` constraint on `order_addon_id` enforces "one earnings
row per fulfilled add-on" — `onComplete` is idempotent by design.

### 2.2 Lifecycle hooks interface

Each concrete add-on class in `src/services/addons/` extends a shared
`AddonService` base and implements the hook surface the user specified.

```js
// src/services/addons/base.js
class AddonService {
  /** @type {string}  — matches addon_services.id */
  static id;
  /** @type {string}  — matches addon_services.type */
  static type;
  /** @type {boolean} — mirror of addon_services.has_lifecycle */
  static hasLifecycle;

  /**
   * Patient has paid. Create any downstream rows (e.g. a pending
   * appointment for video). Do NOT trigger doctor notifications — those
   * fire in onFulfill when the doctor-side step is initiated.
   * @returns {Promise<void>}
   */
  async onPurchase(order, addon) { throw new Error('not implemented'); }

  /**
   * Doctor has completed the addon-specific step (video held, prescription
   * attached, etc.). For SLA-style addons with hasLifecycle=false, this
   * is called inline during onPurchase.
   * @returns {Promise<void>}
   */
  async onFulfill(order, addon, doctor) { throw new Error('not implemented'); }

  /**
   * Case has been marked complete and addon was fulfilled. Insert the
   * commission row. Called by the case completion handler, not by the
   * addon itself.
   * @returns {Promise<void>}
   */
  async onComplete(order, addon) { throw new Error('not implemented'); }

  /**
   * Case completed but this addon was NOT fulfilled. Mark for refund.
   * Sets order_addons.status='refunded', refund_pending=true. Does NOT
   * call Kashier — refund is manual for now (tracked in TODO.md).
   * @returns {Promise<void>}
   */
  async onRefund(order, addon) { throw new Error('not implemented'); }

  /**
   * Return an HTML snippet (or path to EJS partial) to show on the
   * patient payment page. Rendered once per addon_service in the
   * checkout view. Consumes addon pricing, not order state.
   * @returns {string|Object}  — { partial: 'addons/video_prompt_patient', locals: {...} }
   */
  renderPatientPrompt(addonService, ctx) { throw new Error('not implemented'); }

  /**
   * Return an HTML snippet to show on the doctor's case detail page
   * when THIS order has this addon attached. Prescription renders a
   * PDF-upload + text field; video renders a join-call card; SLA
   * renders an inline deadline badge.
   * @returns {string|Object}
   */
  renderDoctorPrompt(order, addon, ctx) { throw new Error('not implemented'); }
}
```

#### 2.2.1 Concrete implementations

| Class                    | File                                      | hasLifecycle | commission% | Notes |
|--------------------------|-------------------------------------------|-------------:|------------:|-------|
| `VideoConsultAddon`      | `src/services/addons/video_consult.js`    |         true |          80 | Wraps existing video.js booking; `onPurchase` creates a `pending_booking` appointment stub and writes `order_addons` row; `onFulfill` fires when the call ends; `onComplete` inserts an `addon_earnings` row at 80% of locked price |
| `Sla24hrAddon`           | `src/services/addons/sla_24hr.js`         |        false |           0 | `onPurchase` updates `orders.sla_hours=24` + recomputes `sla_deadline` + writes `order_addons` row immediately at `status='fulfilled'` (no doctor step); `onFulfill` / `onComplete` / `onRefund` are **no-ops** — SLA is a Tashkheesa-only fee with no doctor payout event |
| `PrescriptionAddon`      | `src/services/addons/prescription.js`     |         true |          80 | `onPurchase` writes `order_addons` row at `status='paid'`; `onFulfill` accepts PDF upload or text, stores in `metadata_json` as `{ pdf_storage_key, text_body, attached_at, attached_by }`; `onComplete` inserts `addon_earnings` at 80%; `onRefund` fires when case completes without attach — sets `status='refunded'`, `refund_pending=true`, logs `addon_refund_queued` audit event |

All three classes are registered in a single registry:

```js
// src/services/addons/registry.js
const registry = {
  video_consult: new VideoConsultAddon(),
  sla_24hr:      new Sla24hrAddon(),
  prescription:  new PrescriptionAddon(),
};
module.exports = {
  getAddon(id) { return registry[id] || null; },
  all() { return Object.values(registry); },
};
```

### 2.3 Shared pricing resolver

One function replaces every scattered lookup.

```js
// src/services/addons/pricing.js
/**
 * Resolve the price for an addon in a given currency.
 * Reads addon_services.prices_json first, falls back to base_price_egp
 * * static FX rate table. Returns { price, currency, base_egp } — the
 * caller stores all three on the order_addons row at purchase time so
 * FX drift doesn't touch locked-in historical amounts.
 */
async function resolveAddonPrice(addonServiceId, currency = 'EGP') { ... }
```

Replaces:

- `src/routes/payments.js:311` (prescription)
- `src/routes/patient.js:1355` (prescription + SLA lookups)
- `src/routes/video.js` (~20 scattered lookups, all paths through `resolvePriceFromJson`)
- `src/routes/patient.js:1342-1345` (video)

### 2.4 Shared lifecycle handler

One Express route file centralizes addon-related endpoints:

```js
// src/routes/addons.js
router.post('/api/orders/:orderId/addons/:addonId/fulfill',
            requireRole(['doctor']), asyncHandler(fulfillAddon));
router.post('/api/orders/:orderId/addons/:addonId/cancel',
            requireRole(['patient','admin']), asyncHandler(cancelAddon));
```

`fulfillAddon` dispatches to the right `AddonService.onFulfill` based
on the `order_addons.addon_service_id`. No more bespoke route files
per add-on (though `src/routes/video.js` stays for the Twilio-specific
UI paths — the addon hooks call into it).

---

## 3. Migration plan

**Non-negotiable:** the live system keeps working through every phase.
Zero downtime, zero breaking reads, zero destructive writes until Phase 4
is verified.

### Phase 2 — Build dormant (branch: `fix/portal-batch-apr24`)

1. Migration `019_addon_services.sql`:
   - Create `addon_services`, `order_addons`, `addon_earnings`.
   - Seed three `addon_services` rows (video_consult, sla_24hr, prescription)
     with the commission % from §0.
   - `ALTER TABLE services ALTER COLUMN video_doctor_commission_pct SET DEFAULT 80`
     + sibling statement for `doctor_commission_pct` + UPDATE to backfill
     any existing row still at 70 (fixes the bug surfaced in §6).
2. Code in `src/services/addons/`:
   - `base.js` (interface), `registry.js`, `pricing.js`
   - `video_consult.js`, `sla_24hr.js`, `prescription.js`
3. Route `src/routes/addons.js` — mounted but inert. All handlers
   short-circuit to `503 Service Unavailable` unless
   `process.env.ADDON_SYSTEM_V2 === 'true'`.
4. Unit tests: `node --test`, Node standard library only (no Jest /
   Vitest / Mocha / tape). One file per concrete class under
   `src/services/addons/__tests__/`. Tests run against the live local
   `tashkheesa` Postgres DB with a sentinel-prefix cleanup strategy —
   every test-created row uses an id that starts with `test-addon-`
   and an `after()` block deletes all such rows. No separate schema
   is created; Phase 2's additive migration is the test's ground truth.
5. Integration test: `scripts/test_addon_lifecycle.js` — creates a
   disposable order, attaches each addon type, fires each hook,
   asserts `order_addons` + `addon_earnings` state after each
   transition. Runnable via `node scripts/test_addon_lifecycle.js`.

**Feature flag:** `ADDON_SYSTEM_V2=false` by default. Every new write
path gates on this flag. Read paths unchanged.

**Commit message template:**
```
feat(addons): new addon service abstraction + three addon implementations (dormant, behind ADDON_SYSTEM_V2)
```

### Phase 3 — Dual-write (same branch)

1. Flip `ADDON_SYSTEM_V2=true` in Render env vars + `.env.example`.
2. Amend payment-callback in `src/routes/payments.js`:
   - For each addon detected (existing branching stays), additionally
     call `addonService.onPurchase(order, addon)` which inserts a
     `order_addons` row. Swallow errors from the new path with an
     `[ADDON V2 DUAL-WRITE FAILURE]` warn log — **never** let a V2
     error break an existing V1 checkout.
3. Amend video lifecycle (`src/routes/video.js`) and case-complete
   handler similarly: call the matching `onFulfill` / `onComplete`
   hooks in addition to the existing writes.
4. Read paths **still use old tables / columns** — no UI change.
5. Parity script `scripts/verify_addon_parity.js`:
   - For each order with `addons_json` populated, check there are
     matching `order_addons` rows with matching status/price.
   - Report: total orders, matched, mismatched, missing-in-v2,
     extra-in-v2. Output JSON to `logs/addon_parity_<timestamp>.json`.
   - Runs on-demand (not on deploy auto-trigger, to avoid compounding
     deploy failures).
6. Monitor ≥ 48 hours of production traffic. Mismatch threshold:
   **zero** mismatches tolerated. Any diff pauses the plan.

**Commit message:**
```
feat(addons): dual-write existing add-ons to new system for parity validation
```

### Phase 4 — Cutover (same branch)

**BLOCKER:** the 70/80% commission inconsistency (§6) **must** be
resolved before this phase. Both sources of truth (migration 002
default and `video.js` fallback) must agree and match the
`addon_services` seed row value. Resolution happens in a separate
commit before Phase 4 starts.

1. Read paths switched to `order_addons`:
   - Patient order page reads addon presence from `order_addons`
     instead of `orders.addons_json`.
   - Doctor case detail renders addons via
     `AddonService.renderDoctorPrompt` instead of inline EJS branches.
   - Admin views follow.
2. Remove dual-write — the new path becomes the only path. Old
   column writes are dropped from payment-callback.
3. `orders.addons_json` schema comment:
   `DEPRECATED 2026-MM-DD — see order_addons. Do not read or write.`
   Column itself is **not** dropped (historical data remains accessible
   for audit queries).
4. Old tables (`appointments`, `video_calls`, `appointment_payments`,
   `doctor_earnings`) stay intact — they continue to be the source of
   truth for video-specific operational data. `order_addons.metadata_json`
   holds foreign-key-style references (e.g. `{"appointment_id": "..."}`).

**Commit message:**
```
refactor(addons): cut over to new addon system, deprecate old write paths
```

### Phase 5 — Prescription as first-class feature (same branch)

With the abstraction live, the prescription feature is a thin delta:

- The `addon_services.prescription` row is already seeded in Phase 2 at
  **400 EGP flat, `doctor_commission_pct = 80`**. No schema change.
  Split: **Doctor 320 EGP (80%) / Tashkheesa 80 EGP (20%)** — computed
  by `onComplete` at fulfillment time, writes one row to
  `addon_earnings`.
- Flesh out `PrescriptionAddon.renderPatientPrompt`: the existing
  checkbox at `patient_payment_required.ejs` becomes driven by
  `addon_services`; tooltip copy set per user spec:
  - EN: "A digital prescription signed by your consultant, delivered with your report if clinically indicated."
  - AR: "روشتة رقمية موقعة من استشاريك، تُسلَّم مع التقرير عند الحاجة طبياً."
- `PrescriptionAddon.renderDoctorPrompt`: new card in the case detail's
  report-submission section showing "Patient requested prescription —
  attach PDF or enter text." PDF upload via existing multer middleware
  (R2 key stored under `doctor-prescriptions/<order_id>/<timestamp>.pdf`);
  text field stored in `metadata_json.text_body`.
- Case-complete handler: before marking complete, check if any
  `has_lifecycle=true` addons are in `status='paid'` (not yet
  `fulfilled`). If any, show a soft-warn modal:
  `"This case has a prescription add-on but none attached. Complete anyway?"`
  Two actions: "Complete anyway" (proceeds; triggers `onRefund` for the
  unfulfilled addon) and "Go back" (cancels the complete). No hard block.
- Refund path: `onRefund` sets `status='refunded'`, `refund_pending=true`,
  logs audit event `addon_refund_queued`. Kashier refund stays manual
  — `refund_pending=true` rows surface in a new admin dashboard widget
  (tiny scope, later commit).
- Patient display: case page renders a "View Prescription" button when
  a `prescription` addon exists with `status='fulfilled'`. Button
  resolves `metadata_json.pdf_storage_key` via existing signed-URL
  helper, or shows text inline if no PDF.
- Commission: `PrescriptionAddon.onComplete` inserts a `doctor_earnings`
  row ONLY if `status='fulfilled'` — i.e., the doctor actually attached
  something. No attach = no commission.

**Commit message:**
```
feat(prescriptions): first-class prescription add-on on new abstraction
```

---

## 4. Rollback plan

### Reversibility matrix

| Phase | What can we undo? | How? |
|-------|-------------------|------|
| **2** | Everything | `ADDON_SYSTEM_V2=false` — dormant code never runs. Can drop `order_addons` + `addon_services` tables; no data was written. |
| **3** | All new writes | Flip `ADDON_SYSTEM_V2=false` → dual-write stops. Old path still works untouched. `order_addons` rows are orphaned but harmless (not read by any UI). |
| **4** | Cutover only | Re-enable dual-write flag + point reads back to old tables. Old column data never stopped existing. Requires one commit revert + env flag flip. |
| **5** | Prescription feature | Revert the feature commit. `addon_services.prescription.is_active=false` hides the checkbox. Patient checkout stays functional without the option. |

### Hard guarantees

1. **Old tables are never dropped.** `appointments`, `video_calls`,
   `appointment_payments`, `doctor_earnings`, and
   `orders.addons_json` remain forever — they carry historical data.
   Post-cutover, they hold immutable history; pre-cutover, they're
   the live source of truth.
2. **Every new write is additive.** Phase 3 writes to `order_addons`
   in addition to the old path — old-path writes continue unchanged
   until Phase 4.
3. **Feature flag is binary + instant.** `ADDON_SYSTEM_V2=true|false`
   — no config cascade, no half-states.
4. **Zero-downtime cutover.** Phase 4 flips read paths via code deploy,
   not migration. No table locks, no backfill windows.
5. **Kashier refunds are never automated in this scope.** `refund_pending`
   is a flag; humans press the refund button in the Kashier dashboard.

### Abort criteria (triggers pause + report, never unilateral rollback)

- **Phase 3:** any parity mismatch (non-zero diff in
  `verify_addon_parity.js` output).
- **Phase 4:** any order_addons read that returns a different
  decision than the old `addons_json` read would have (spot-checked
  against the last 7 days of live orders before cutover).
- **Phase 5:** any doctor completes a case with prescription attached
  but no `doctor_earnings` row inserted, OR a refund is triggered
  but `refund_pending` doesn't land on the row.

---

## 5. Testing strategy

### 5.1 Unit tests (Phase 2)

One test file per `AddonService` class. Each asserts:

- `onPurchase` creates the correct `order_addons` row with locked
  price + commission_pct (80 for video_consult & prescription, 0 for
  sla_24hr).
- `onPurchase` for video creates the stub appointment; for SLA flips
  `orders.sla_hours` + immediately writes `order_addons` row at
  `status='fulfilled'`; for prescription leaves `status='paid'`,
  `refund_pending=false`.
- `onFulfill` transitions status `paid → fulfilled` and populates
  `metadata_json` correctly per type. SLA `onFulfill` is a no-op
  assertion.
- `onComplete` for video and prescription inserts the right
  `addon_earnings` row:
  `earned_amount_egp = price_at_purchase_egp * doctor_commission_pct_at_purchase / 100`.
  For prescription at 400 EGP × 80% = **320 EGP**.
  For video at 200 EGP × 80% = **160 EGP**.
  SLA `onComplete` is a no-op — no `addon_earnings` row written
  (SLA is a Tashkheesa-only fee).
- `onRefund` transitions `paid → refunded`, sets `refund_pending=true`,
  does NOT insert an `addon_earnings` row.
- `renderPatientPrompt` / `renderDoctorPrompt` return a non-empty
  string per locale (EN + AR).

Test runner: `node --test` (Node standard library, no external
framework). Strategy: tests run against the live local `tashkheesa`
database. Every test-created row has an `id` / `order_id` prefixed
with `test-addon-`; a shared `after()` in each test file deletes
everything with that prefix across `addon_earnings`, `order_addons`,
`orders`, and `users`. The Phase 2 migration is the test schema —
no separate test DB is created.

### 5.2 Integration tests (Phase 2)

`scripts/test_addon_lifecycle.js` — runs against local Postgres:

```
for each addon_type in [video_consult, sla_24hr, prescription]:
  create disposable order
  attach addon via onPurchase
  assert order_addons row matches expected
  fire onFulfill (where applicable)
  assert state
  fire onComplete
  assert addon_earnings row inserted (for types that produce commission: video_consult, prescription)
  tear down
```

Plus one negative path: fire `onRefund` after `onPurchase` without
`onFulfill`, assert `refund_pending=true` and no earnings row.

### 5.3 Parity tests (Phase 3)

`scripts/verify_addon_parity.js` — runs on-demand against production:

- Join `orders` with `order_addons`.
- For each order with `addons_json` populated, parse it and diff
  against the `order_addons` rows.
- Report: total orders examined, fully-matched, mismatched (with
  per-row diff), old-only (V1 write but V2 missing), V2-only (V2
  write but V1 missing — should never happen).
- Exit code 0 if zero mismatches; else 1 with JSON diff dumped.

### 5.4 Manual QA matrix (Phase 4, before cutover)

Preconditions: staging environment with migration 019 applied and
`ADDON_SYSTEM_V2=true`, dual-write active, 48 hours of traffic.

Matrix (each row is one manual test):

| # | Scenario | Expected |
|---|----------|----------|
| 1 | New patient, no add-ons, pays, doctor completes | `order_addons` empty; old flow works |
| 2 | New patient, video only, pays, books slot, doctor holds call, completes | 1 `order_addons` row (video_consult, fulfilled); `appointments` row matches |
| 3 | New patient, SLA only, pays, doctor completes in 20h | 1 `order_addons` row (sla_24hr, fulfilled) |
| 4 | New patient, prescription only, pays, doctor attaches PDF, completes | 1 `order_addons` row (prescription, fulfilled); PDF in R2 |
| 5 | New patient, prescription only, pays, doctor completes WITHOUT attaching | Warn modal fires; if "Complete anyway" → `order_addons.status=refunded`, `refund_pending=true`; admin dashboard shows the pending refund |
| 6 | New patient, all three add-ons, pays, doctor does everything | 3 `order_addons` rows; commission = sum of per-addon commissions |
| 7 | Patient cancels order before payment | No `order_addons` rows written (pending rows never reach `paid`) |
| 8 | Patient cancels order AFTER payment | All `order_addons` rows transition to `cancelled`; refund_pending=true for paid-but-unfulfilled |
| 9 | Historical order from before Phase 2 (pre-migration) | Reads from old columns gracefully; `order_addons` row absent is not an error |
| 10 | Bilingual check — patient-side AR locale, doctor-side AR locale | All rendered prompts respect locale |

All 10 rows must pass before Phase 4 is approved.

### 5.5 Post-cutover smoke (Phase 4 + 5)

- `verify_addon_parity.js` runs one final time against the read path
  — asserts UI reads return identical data vs. the pre-cutover read path.
- Synthetic canary: a script creates one prescription order end-to-end
  every hour on staging. If any step fails, it pages.
- Live production sampling: first 20 real orders post-cutover are
  manually spot-checked against the old columns before those columns
  are considered inert.

---

## 6. Commission-default bug (Phase 2 addresses, Phase 4 verifies)

Reframing after the commission-model clarification in §0: the
doctor-facing promise "you keep 80%" on video add-ons is correct, and
the `80` fallback at `src/routes/video.js:135` and `:173` returns the
right number. The bug is the **column default** that sat at 70.

| Source                                                   | Value | File:line                                      | Correct? |
|----------------------------------------------------------|------:|-----------------------------------------------|---------:|
| `services.video_doctor_commission_pct` column default    |   70  | `src/migrations/002_column_additions.sql:50` | ❌ should be 80 |
| `services.doctor_commission_pct` column default          |   70  | `src/migrations/002_column_additions.sql:62` | ❌ should be 80 |
| `video.js` fallback when column is NULL (branch A)       |   80  | `src/routes/video.js:135`                    | ✅ |
| `video.js` fallback when column is NULL (branch B)       |   80  | `src/routes/video.js:173`                    | ✅ |
| Doctor-facing copy: "you keep 80% of each video consultation fee" | 80 | `src/views/doctor_profile.ejs:459-461`   | ✅ (for video) |

Phase 2 fixes this at the source:

1. Migration 019 runs `ALTER TABLE services ALTER COLUMN
   video_doctor_commission_pct SET DEFAULT 80` + same for
   `doctor_commission_pct`.
2. Migration 019 `UPDATE`s any existing row still at 70 → 80.
3. The `80` fallback in `video.js` stays for the duration of Phases
   2–3 (harmless — column is now always populated with 80, but the
   fallback catches any row that somehow slipped through). Phase 4 prep
   work removes the fallback literal.

Phase 4 verification step (lands in the commit that kicks off Phase 4):

- Re-read `doctor_profile.ejs:459-461`. The copy talks about "Video
  consultations (add-on product): you keep 80%." That is correct for
  the add-on model. **But** the same paragraph also says the case
  second-opinion is "you receive 20% of the service price" — confirm
  that's accurate under the §0 main/add-on split before cutover. If
  any wording needs to change, it ships in the Phase 4 commit.

TODO.md tracks the migration-default bug with pointers back here, but
the **fix lands in Phase 2** (migration 019), not in a separate
commit. The TODO entry is marked resolved as soon as Phase 2 is pushed.

---

## 7. Timeline (indicative)

| Phase | Wall-clock estimate | Prereqs |
|-------|---------------------|---------|
| 1     | Today (this doc)                           | — |
| 2     | 3–4 days (new code, tests, no integration) | Phase 1 approved |
| 3     | 2 days build + 48h monitoring              | Phase 2 merged |
| 4     | 1–2 days (commission fix + cutover)        | Phase 3 parity clean, §6 resolved |
| 5     | 2–3 days (prescription feature)            | Phase 4 verified |

Two weeks end-to-end is the right estimate. The design is intentionally
boring — every phase has a rollback, every write is additive, every
read is gated. No heroics.

---

## 8. Open questions — RESOLVED 2026-04-24

1. **Commission model:** resolved in §0. Two-tier: main service 80/20
   platform/doctor, add-ons 20/80 platform/doctor. The `80` fallback
   in `video.js` was correct; the `70` migration default was the bug.
   Migration 019 fixes the default.
2. **SLA addon `onComplete`:** no-op confirmed. SLA is Tashkheesa-only,
   no doctor payout event, no `addon_earnings` row written.
3. **Test framework:** `node --test`, Node standard library only. No
   Jest / Vitest / Mocha / tape. Sentinel-prefix cleanup on the live
   local DB.
4. **Currency FX:** `prices_json` is authoritative per currency. Live
   FX automation is out of scope; logged as a separate TODO entry.
5. **Enum naming:** `sla_upgrade` (not `sla_modifier`). Matches how
   a support conversation would describe it.

### Prescription pricing (authoritative)

- **Price:** 400 EGP flat across all tiers and currencies (unless
  overridden per-currency via `prices_json`).
- **Split:** Doctor 320 EGP (80%) / Tashkheesa 80 EGP (20%).
- `addon_services.prescription.doctor_commission_pct = 80` at seed.
- `onComplete` writes `addon_earnings` row at 320 EGP when the
  add-on is fulfilled.

---

## 9. Phase boundary checklist

Before starting **any** next phase, these must be true:

- [ ] Previous phase's commits pushed and live (or staged, for Phase 5).
- [ ] Previous phase's tests all green.
- [ ] Previous phase's parity script (if applicable) returned zero
      mismatches over the required observation window.
- [ ] User has explicitly approved the phase transition.
- [ ] No open bug blockers touching the affected code paths.

The single exception: §6 (commission inconsistency) must clear before
Phase 4 even begins; Phase 4 does not start without it.

---

*End of design doc. Approval required before Phase 2 begins.*
