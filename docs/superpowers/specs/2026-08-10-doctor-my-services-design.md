# Design — Doctor "My Services" + Supply Integrity

**Date:** 2026-08-10
**Branch:** `feat/doctor-my-services` (base `main`, the Render deploy branch)
**Status:** Design — approved to proceed to `writing-plans` with 3 corrections applied (2026-08-10).

---

## 1. Problem & goal

All 29 active Tashkheesa doctors were mapped to services and none have ever logged
in (`password_hash IS NULL`, `first_login_at IS NULL`, `onboarding_complete = false`).
A mass email is about to invite them to set up their account and confirm which
services they will actually accept.

This build delivers:

1. A **doctor-facing "My Services" screen** to confirm the services they accept
   (their `doctor_services` rows are treated as **unconfirmed defaults**).
2. **Coming Soon guards** so services with no active doctor cannot be ordered and
   are clearly marked in the catalogue.
3. A **re-sync helper** that keeps `services.coming_soon` truthful whenever supply
   changes.
4. An **assignment safety gate** so unconfirmed / wrong-service doctors are never
   assigned cases.
5. **Reuse + hardening of the existing set-password/welcome-token flow**, plus a
   reusable bulk-invite action to onboard the 29 password-less doctors safely.

---

## 2. Verified production state (Supabase MCP, project `wvmhliweujmhlzknmuzh`, 2026-08-10)

Read-only, via MCP — never `DATABASE_URL` (per the hard credential rule).

- **Doctors:** 30 total, **29 active**, **29** with `password_hash IS NULL` /
  never logged in / `onboarding_complete = false`. 1 inactive.
- **`services.coming_soon` already exists in prod** (`boolean NOT NULL DEFAULT
  false`) and is **already perfectly in sync** with the active-doctor mapping (the
  re-sync formula would flip **0 rows** now). 89 services are `coming_soon = true`;
  **67 of them are `is_visible = true`**. It has no committed repo migration because
  it was applied directly to prod via Supabase MCP today — see §2.1 (migration drift).
- **All 140 visible services have `doctor_fee` and `base_price` populated** (0 NULL)
  — "You earn" always renders.
- **The bulk-map premise HOLDS (corrected):** "every active doctor mapped to every
  visible service **in their own specialty**" is exactly true for the 5 catalogued
  specialties — Cardiology 9/9 ×4, OB/GYN 9/9 ×4, Urology 9/9 ×7, Orthopedics 11/11
  ×5, Radiology 11/11 ×2 (= 22 doctors). The 5 doctors with **zero** `doctor_services`
  rows are in specialties whose catalogue is empty (nothing to map — not a failure).
  The 67 uncovered visible services sit in specialties with **no doctors at all**,
  which is exactly what `coming_soon` flags. (This does not change the decision to
  pre-tick from actual rows.)
- **Empty own-specialty catalogue:** Internal Medicine (4 active) and Pediatrics
  (3 active) have 0 visible services → 7 doctors. **But only 5 of them are truly
  empty** — see §2.2.

### 2.1 Migration drift (known, not a mystery)

Six migrations were applied directly to prod via Supabase MCP on 2026-08-10; all are
in `supabase_migrations.schema_migrations` but **none are in the repo**. Migration
078 (§4.8) reconciles the repo against remote so a fresh/local `migrate()` produces
a DB matching prod. Newest first:

| version | name | kind | re-run safety |
|---|---|---|---|
| 20260810094458 | add_coming_soon_flag_to_services | **schema** | idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, resync `UPDATE`) |
| 20260810094405 | enable_rls_on_pricing_backup_tables | **schema/RLS** | idempotent (`ENABLE RLS`); needs `to_regclass` guard for local (tables may not exist) |
| 20260810093816 | close_jamaleddin_duplicate_applications | data | idempotent (`UPDATE` by email) |
| 20260810093756 | map_new_doctors_to_services_and_close_applications | data | idempotent (`INSERT … NOT EXISTS`, status `UPDATE`s) |
| 20260810093745 | promote_16_applicants_to_active_doctors | **data (PII)** | ⚠️ **bare `INSERT … VALUES`, NO `ON CONFLICT`** — repo copy MUST add `ON CONFLICT DO NOTHING` or it fails on prod boot. Embeds 16 doctors' emails/phones/licence numbers. |
| 20260810093051 | map_active_doctors_to_own_specialty_services | data | idempotent (`INSERT … NOT EXISTS`) |

### 2.2 Escape-hatch set — UNION rule (CORRECTED; was a production bug)

A specialty-based rule ("specialty has zero visible services") would capture all 7
empty-catalogue doctors — **including Ahmed Medhat (`doc_28ddb18f22580b48`, 22 rows)
and Nancy Ghoneim (`doc_11a7efe3793123ed`, 20 rows)**, the platform's **only two
functional doctors** (42 cross-specialty mappings across Nephrology, Cardiology,
Pulmonology, Endocrinology, etc.). Skipping them past the services step means they
never set `onboarding_complete`, and the assignment gate then makes them permanently
unassignable → **outage on deploy.**

**The rule is UNION-based:**

```
doctor's service list =
    visible services WHERE specialty_id = doctor.specialty_id
  UNION
    every service the doctor already holds a doctor_services row for
    (any specialty, grouped under its own specialty heading)

escape hatch fires ONLY when that union is empty
```

This yields exactly **5**: Hassan Hossam, Ahmed Gharib, Reem Sabry, Yomna Mohsen,
Ahmed Raafat Hegazy. Medhat & Ghoneim get a normal 22/20-item cross-specialty screen
and confirm like everyone else. **Never a hardcoded name list — always computed.**

---

## 3. Scope

- **In — Package 1:** My Services + Coming Soon supply integrity.
- **In — Package 2:** Welcome-token hardening + bulk invite (security prerequisite).
- **OUT — Package 3:** licence / availability / terms **blocking** compliance gates —
  do not exist in code today (no `terms_accepted` column, no licence upload/verify
  flow, `users.is_available` read nowhere). Separate work item. This build must not
  break anything but does not implement them. The 5 empty-union doctors see a
  "services being finalised" note; nothing to "complete" yet.
- The `/apply` route is **not modified** (explicit carve-out).

---

## 4. Architecture & components

### Package 1

#### 4.1 `GET /portal/doctor/services`
- File: `src/routes/doctor.js`; gate: existing `requireDoctor` (verify literal
  `doctor.js:113` at build).
- **Service list = the UNION (§2.2):** (a) `services` where `specialty_id =
  doctor.specialty_id AND COALESCE(is_visible,true)=true`, plus (b) every service the
  doctor already holds a `doctor_services` row for (any specialty, any visibility).
  Left-join the doctor's `doctor_services` to compute the ticked flag per row.
  **Group rows under their service's specialty heading** (so Medhat sees his
  cross-specialty services grouped).
- Loads `users.sub_specialties` (jsonb) + specialty name/name_ar for context.
- Each row shows: service name (name_ar in AR), `base_price`, `doctor_fee` labelled
  **"You earn"** (`تكسب`), `sla_hours`, and a checkbox reflecting an existing
  `doctor_services` row. `sub_specialties` shown above the list. **Never uses
  `doctor_commission_pct`.**
- Renders new `src/views/portal_doctor_services.ejs`, cloned from
  `portal_doctor_cases.ejs`: `include('partials/header', { portalFrame:true,
  portalRole:'doctor', portalActive:'services', ... })` → `layouts/portal.ejs` (v2
  CSS + sidebar) → `include('partials/doctor/topbar', {...})`.
- **Empty-union escape hatch:** if the union is empty, render a short "services for
  your specialty are being finalised — you'll be notified" note instead of the list;
  **do not** set `onboarding_complete`.

#### 4.2 `POST /portal/doctor/services`
- Body: array of ticked `service_id`s (+ `confirm_empty`).
- **Server-side UNION validation (§2.2):** accept a `service_id` only if it is a
  visible service in the doctor's own specialty **OR** the doctor already holds a
  `doctor_services` row for it. Reject anything else (do not trust the client);
  compute the allowed set from the DB, not from the request.
- **Diff in one `withTransaction`** (`require('../pg')`): INSERT missing
  (`ON CONFLICT (doctor_id, service_id) DO NOTHING`), DELETE unticked rows for this
  doctor **within the allowed union** (never touch rows outside it). Mirrors the
  DELETE-then-INSERT junction pattern at `superadmin.js:3040-3086`.
- **Zero-services rule:** empty ticked set without `confirm_empty` → re-render with a
  warning and require explicit confirmation. Never silent.
- On first successful save, set `users.onboarding_complete = true` (any explicit
  save, incl. confirmed-empty). Assignability is separately governed by service-level
  matching (§4.6).
- After commit, call the re-sync helper (§4.3).

#### 4.3 Re-sync helper — `src/services/services_coming_soon_sync.js`
- Exports one function running the **exact** spec SQL, unchanged, keyed on
  `is_active` (NOT `is_paused`):
  ```sql
  UPDATE public.services sv
  SET coming_soon = NOT EXISTS (
    SELECT 1 FROM public.doctor_services ds
    JOIN public.users u ON u.id = ds.doctor_id
    WHERE ds.service_id = sv.id
      AND u.role = 'doctor' AND u.is_active = true
  );
  ```
- Accepts an optional `client` (run inside a caller's txn) else uses the pool.
  Idempotent.
- **Call sites:** after any `doctor_services` change (§4.2), and after any change to
  a doctor's `is_active`: web approve `superadmin.js` `/superadmin/doctors/:id/approve`;
  Command API `admin_doctor_approve.js`; Command API `admin_doctor_pause.js`
  (pause toggles `is_paused` → re-sync is a 0-change no-op, safe; reactivation that
  flips `is_active` must re-sync); any web superadmin edit that flips `is_active`.

#### 4.4 Coming Soon — catalogue guard (`src/views/services.ejs`)
- When `service.coming_soon`: `.v2-chip--soon` "Coming Soon" / "قريبًا" badge; hide
  `.service-price` (`<% if (!service.coming_soon) %>`); replace the `<a href>` CTA
  with a non-navigating `aria-disabled` element (no link). Card at `services.ejs:468-484`.
- Query (`static-pages.js:99-119`) returns `coming_soon` via `sv.*`. All 140 visible
  services have `base_price > 0`, so `base_price > 0` does not hide coming-soon rows;
  verify at build. Route is cached (`_servicesCache`) — extra boolean column only, no
  cache-shape change; verify.

#### 4.5 Coming Soon — order POST reject (BOTH paths)
- **Web wizard** (`patient.js`): extend the check at step3 (`~1871-1874`) and step4
  (`~1983-1997`) to also reject `coming_soon = true`. Add a `servicesBookableClause()`
  = `COALESCE(is_visible,true)=true AND COALESCE(coming_soon,false)=false` beside
  `servicesVisibleClause()` (`patient.js:893-898`).
- **Mobile API** `POST /api/v1/cases` (`api/cases.js:236`): checks **neither** today.
  Add both `is_visible` and `coming_soon` guards → reject with `SERVICE_NOT_BOOKABLE`.
  A stale page or direct POST must not create an unfulfillable order.

#### 4.6 Assignment safety — onboarding gate + service-level matching
Shared eligibility fragment (new `src/services/doctor_eligibility.js` or extend
`src/routes/api/_assign_helpers.js`) building:
```
<alias>.role = 'doctor'
AND COALESCE(<alias>.is_active, true) = true
AND COALESCE(<alias>.is_paused, false) = false
AND COALESCE(<alias>.onboarding_complete, false) = true
AND EXISTS (SELECT 1 FROM doctor_services ds
            WHERE ds.doctor_id = <alias>.id AND ds.service_id = <serviceIdParam>)
```
(Preserve each site's existing specialty / tier / capacity / `pending_approval`
predicates.) The `EXISTS(doctor_services …)` clause is the **service-level matching**
— doctors are eligible only for the specific service they confirmed. Thread the
case's `service_id` into any site that currently carries only `specialty_id`.

**9 call sites** (verify the 3 marked at build):
1. `api/admin.js:901` — candidates picker `GET /cases/:id/candidates`.
2. `api/admin.js:1089-1096` — single-assign `POST /cases/:id/assign` (SELECT + JS
   guards → add `onboarding_complete` + service-membership →
   `DOCTOR_ONBOARDING_INCOMPLETE` / `DOCTOR_SERVICE_NOT_OFFERED`, 409).
3. `services/admin_bulk_assign.js:107-111` — bulk pool query.
4. `services/admin_bulk_assign.js:130` — JS eligibility filter.
5. `case_sla_worker.js:41` — `buildAlternateDoctorQuery` clauses (hottest path, ~5min;
   covers both `selectAlternateDoctor` calls `:102-122`).
6. `auto_assign.js:29-33` — `eligibleDoctorsFor`.
7. `auto_assign.js:133-136` — specialty pool COUNT (verify at build).
8. `assign.js:7-14` — `pickDoctorForOrder`.
9. `superadmin.js:3688` — reassign SELECT (verify at build).

#### 4.7 Soft nudge, sidebar, first-login landing (NO navigation hard-gate)
- **Sidebar:** add a "Services" item to `partials/doctor/sidebar.ejs` Work section
  (pattern `:75-84`), add `'services':'services'` to the `_isActive` alias map, pass
  `portalActive:'services'`.
- **Global banner:** a small partial included by the doctor topbar
  (`partials/doctor/topbar.ejs`, rendered by every doctor page) shown while
  `onboarding_complete = false` **and** the doctor's service union (§2.2) is non-empty.
  Do **not** tie to `first_login_at` (self-clears on first dashboard hit).
- **First-login landing:** in `POST /set-password` (and the `/magic-login`
  password-set redirect), if the user is a doctor with `onboarding_complete = false`
  **and** a non-empty service union, redirect to `/portal/doctor/services`; the 5
  empty-union doctors land on the dashboard. One-time redirect, not a persistent
  guard → no loops. Keep `first_login_at` stamping as-is.

#### 4.8 Migration `078` — reconcile the 6 prod migrations, **schema-only** (§2.1)
RESOLVED (§11): 078 codifies **only the schema changes**; the 4 data migrations are
**documented by reference, not replayed** (PDPL — 16 doctors' emails/phones/licence
numbers must not enter permanent git history; re-running data INSERTs on every fresh
`migrate()` is an unnecessary footgun).

078 contains:
- `ALTER TABLE public.services ADD COLUMN IF NOT EXISTS coming_soon boolean NOT NULL
  DEFAULT false` + the `COMMENT ON COLUMN` + the `is_active`-keyed resync `UPDATE` +
  `CREATE INDEX IF NOT EXISTS idx_services_coming_soon ON public.services (coming_soon)
  WHERE is_visible` (verbatim from the prod migration; already idempotent).
- RLS-enable on `_bak_services_20260729` and `_bak_srp_20260729`, each guarded by
  `to_regclass('public._bak_…') IS NOT NULL` (tables may not exist locally).
- A **header comment** recording the 4 data migrations by `version`, `name`, and a
  one-line purpose, marked *"applied to prod via MCP 2026-08-10, NOT replayed — prod
  is source of truth."*

Column-verify via `information_schema` + BEGIN…ROLLBACK dry-run before push (expect a
0-change no-op on prod). Next number is **078**.

#### 4.9 Synthetic local-dev / test seed (NOT a migration)
Schema-only 078 leaves local dev with zero doctors, so the regression tests have
nothing to run against. Add a **separate, clearly non-production seed** (a script /
fixture under e.g. `scripts/dev/seed_my_services_fixtures.js` or a test fixture — **not
a numbered migration**, so it can never run against prod) using **synthetic data only**
(obviously-fake names, `@example.com` emails, fake licence numbers). It must cover the
four shapes:
1. **Cross-specialty doctor** — specialty with 0 visible services but N mappings in
   *other* specialties (the Medhat/Ghoneim shape the union rule exists for). Exercises:
   screen shows N items, save-with-no-changes preserves all N, doctor becomes assignable.
2. **Empty-union doctor** — specialty with 0 visible services AND 0 mappings (the
   Hossam/Gharib/Pediatrics shape). Exercises: escape hatch fires, no redirect loop,
   `onboarding_complete` stays false, doctor stays out of the assignment pool.
3. **Normal doctor** — specialty with N visible services, all mapped (Cardiology/
   Urology/Radiology shape). Exercises: pre-tick reflects rows; untick flips a service
   to `coming_soon`.
4. **Last-doctor-standing** — a service with exactly one mapped doctor, so unticking
   flips `coming_soon = true` and the order guard then rejects a purchase of it.

Note the local-boot constraint (migration 070 needs a Supabase `anon` role absent
locally): the seed + these tests run against a **prod-schema clone / hermetic harness**
that skips 070, not a raw local boot (see the plan for the harness).

### Package 2 — Welcome-token hardening + bulk invite

Existing flow **reused** (not replaced). Verified verdicts + fixes:

- ✅ Single-use (`used_at` before session) — keep. ✅ No plaintext token logging — keep.
- 🔴 **CRITICAL: `/magic-login/:token` establishes the session BEFORE checking
  `password_hash`** (`auth.js:492-530`) → old unused token logs in a
  password-holding doctor password-free. **Fix:** if `password_hash` set, do NOT
  auto-login; redirect to `/login`.
- 🔴 **Remint doesn't invalidate old tokens** (INSERT-only:
  `admin_doctor_invite.js:67-71`, `superadmin.js:3127-3131`, `auth.js:155-164`,
  `auth.js:428-442`). **Fix:** before each mint (same txn, after any `FOR UPDATE`)
  `DELETE FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL`.
- 🔴 **No rate-limiting** on `/magic-login/:token`, `/reset-password/:token`,
  `/set-password`, invite/resend. **Fix:** per-IP limiters reusing `otpIpLimiter`
  (`auth.js:320-341`).
- **Welcome TTL 168h → 72h**; single-source `WELCOME_EXPIRY_HOURS` (dup at
  `doctor_welcome_payload.js:18` + `superadmin.js:55`).
- **Bulk action** `POST /superadmin/doctors/bulk-welcome-passwordless`: loop existing
  `inviteDoctor(client, …)` over `role='doctor' AND is_active=true AND password_hash
  IS NULL`, one txn/doctor. **Idempotent** (remint-DELETE → one live token each),
  skips password-holders, respects `welcome_email_last_sent_at` cooldown, returns
  `{ sent, skipped, failed }`. Notifications carry a dedupe key. **Ship in the SAME
  release as the assignment gate** (a gate without invites strands every doctor).

---

## 5. Data model changes

| Change | Table | Detail |
|---|---|---|
| Formalize (idempotent, migration 078) | `services` | `coming_soon BOOLEAN NOT NULL DEFAULT false` (+ comment + partial index) — already live in prod, reconcile schema-as-code. |
| No new columns | `users` | Reuse `onboarding_complete`. No `terms_accepted` (Package 3, out). |
| No schema change | `doctor_services` | INSERT `ON CONFLICT DO NOTHING`, DELETE on untick (within the allowed union). |

**Boundary note:** self-signup (`auth.js:1063`, carved-out `/apply` area) writes
`onboarding_complete=true` unconditionally, so it is not a perfect gate for future
self-signups. This build does not touch it. The **service-level
`EXISTS(doctor_services …)` matching (§4.6) is the real safety net**. All 29 current
doctors are `onboarding_complete=false`, so both signals gate them today.

---

## 6. i18n / RTL
- Reuse existing: lang via `middleware.js:205-210`; `dir` via `getDir(lang)`;
  inline `tt(en, enAlt, ar)` per doctor-view convention (`portal_doctor_cases.ejs:40-41`)
  or `res.locals.tt`. Numbers `toLocaleString(isAr?'ar-EG':'en-US')`.
- Bilingual DB fields: `isAr && obj.name_ar ? obj.name_ar : obj.name`.
- New EN/AR strings: "My Services / خدماتي", "You earn / تكسب", "Coming Soon / قريبًا",
  "Confirm the services you accept / أكد الخدمات التي تقبلها", zero-services warning,
  empty-union note. Every `tt()` carries EN+AR fallbacks.

---

## 7. Error handling
- POST out-of-union `service_id` → reject, re-render with error (never silent-drop).
- Zero ticked without `confirm_empty` → warn + require confirmation.
- Order POST unbookable → `SERVICE_NOT_BOOKABLE` (web `err=` redirect; API JSON).
- Ineligible assignment → `DOCTOR_ONBOARDING_INCOMPLETE` / `DOCTOR_SERVICE_NOT_OFFERED`
  (409).
- Re-sync failure must not corrupt the save: save txn commits first, re-sync runs
  after (best-effort + logged). Prefer post-commit to avoid coupling; decide in plan.

---

## 8. Testing
Prefer prod-schema-clone / hermetic tests; prod write **dry-runs** via Supabase MCP
`BEGIN…ROLLBACK` before any real write.

- Doctor sees only their own specialty's visible services **plus any cross-specialty
  services they already hold** (union), and nothing else.
- **Regression (Correction 1):** Medhat (`doc_28ddb18f22580b48`) loads
  `/doctor/services`, saves with **no changes**, still has 22 rows, and **becomes
  assignable** (onboarding_complete flips, service-level match holds).
- Cross-specialty `service_id` the doctor does NOT already hold is rejected in POST.
- Unticking the last active doctor on a service flips it to `coming_soon`; re-ticking
  restores bookable.
- Order POST for a `coming_soon` service rejected — **web wizard AND
  `POST /api/v1/cases`**; `is_visible=false` rejected on the mobile API (new guard).
- Zero-services save requires explicit confirmation; `onboarding_complete` flips.
- Empty-union (Pediatrics) doctor first login: no redirect to /services, no banner,
  no loop; `onboarding_complete` stays false; can still open an assigned case.
- `onboarding_complete=false` doctor is in no assignment pool (all 9 sites, esp.
  `case_sla_worker`).
- Service-level matching: a doctor who ticked only service A is **not** eligible for
  a case of service B in the same specialty; confirming A makes them eligible for A.
- Token: old unused welcome token cannot log in a password-holding doctor (backdoor
  closed); re-running bulk batch yields exactly one live token per doctor; limiter
  blocks rapid redemption.
- Migration 078 dry-run on prod is a **0-change no-op** (esp. `promote_16` with
  `ON CONFLICT DO NOTHING`).

---

## 9. Deployment sequencing (must communicate)
1. **Deploy the assignment gate and the bulk-invite action in the SAME release.** All
   29 are `onboarding_complete=false` → unassignable until they confirm; a gate
   without a way to send invites strands every doctor. Order: **deploy (gate+invite)
   → send welcome emails → doctors confirm → assignable.** Nothing is assigned today
   and no doctor has logged in, so nothing breaks.
2. **~67/140 visible services render "Coming Soon"** the instant the catalogue guard
   ships. Intended and **already true in prod** (flag is live and in sync); the guard
   just makes the UI honest. Shrinks as doctors confirm.
3. Migrations apply on boot from `main`; server refuses to start on failure.
   Column-verify + dry-run 078 before push.

---

## 10. Explicitly NOT doing
- No Supabase Auth users; custom JWT sessions only.
- No `doctor_commission_pct` anywhere.
- No changes to urgency multiplier / payout calc.
- No `/apply` route changes.
- No licence/terms/availability blocking gates (Package 3).
- Re-sync stays keyed on `is_active`, not `is_paused` (do not change without asking).

---

## 11. Resolved decisions
**Migration 078 data-reconciliation depth (§4.8): RESOLVED → schema-only +
documented.** The 4 data migrations are recorded by reference, not replayed (PDPL /
no PII in git history / no data re-run footgun). A synthetic non-production seed
(§4.9) backs local dev + the regression tests.
