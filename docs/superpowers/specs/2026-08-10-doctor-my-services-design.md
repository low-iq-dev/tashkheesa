# Design — Doctor "My Services" + Supply Integrity

**Date:** 2026-08-10
**Branch:** `feat/doctor-my-services` (base `main`, the Render deploy branch)
**Status:** Design — awaiting user review before `writing-plans`.

---

## 1. Problem & goal

All 29 active Tashkheesa doctors were mapped to services without consent and none
have ever logged in (`password_hash IS NULL`, `first_login_at IS NULL`,
`onboarding_complete = false`). A mass email is about to invite them to set up
their account and confirm which services they will actually accept.

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
  never logged in / `onboarding_complete = false`. 1 inactive doctor.
- **`services.coming_soon` ALREADY EXISTS in prod** (`boolean NOT NULL DEFAULT
  false`) even though **no committed migration creates it** — it is live but not in
  schema-as-code. It is **already perfectly in sync** with the active-doctor
  mapping (the spec's re-sync formula would flip **0 rows** right now). 89 services
  are `coming_soon = true`; **67 of them are `is_visible = true`**.
- **All 140 visible services have `doctor_fee` and `base_price` populated** (0 NULL)
  — "You earn" always renders.
- **Mapping reality contradicts the "everyone mapped to everything" premise:** only
  **24 of 29** active doctors have any `doctor_services` rows (**5 have none**);
  254 rows across just 73 of 140 visible services. No inactive doctor holds
  mappings.
- **Zero-visible-service specialties:** Internal Medicine (**4** active doctors) and
  Pediatrics (**3** active) → **7 empty-catalogue doctors**, not 5. Two of them
  (Ahmed Medhat Abdelaziz, Nancy Ghoneim) hold `doctor_services` rows pointing at
  *non-visible* services, so the visible-only screen still shows them an empty list.
  Catalogued specialties (all with mappings): Urology (9 svc/7 drs), OB/GYN (9/4),
  Cardiology (9/4), Orthopedics (11/5), Radiology (11/2) = 22 doctors. 22 + 7 = 29 ✅.

**Implication:** the empty-catalogue set is defined by a **computed rule**
("doctor's specialty has zero visible services"), never a hardcoded name list.

---

## 3. Scope

### In scope — Package 1: My Services + Coming Soon supply integrity
### In scope — Package 2: Welcome-token hardening + bulk invite (security prerequisite)
### OUT of scope — Package 3: licence / availability / terms **blocking** compliance gates
- These do **not** exist in code today (no `terms_accepted` column, no licence
  upload/verification flow, `users.is_available` read nowhere). Building them is a
  substantial net-new feature and is a **separate work item**. This build must not
  break anything, but does not implement them. The 7 empty-catalogue doctors simply
  see a "services being finalised" note; there is nothing for them to "complete" yet.
- The `/apply` route is **not modified** (explicit carve-out).

---

## 4. Architecture & components

### Package 1

#### 4.1 `GET /portal/doctor/services`
- File: `src/routes/doctor.js` (single router; add near other `/portal/doctor/*`
  routes). Gate: existing `requireDoctor` (verify literal `doctor.js:113` at build).
- Loads: `SELECT ... FROM services WHERE specialty_id = $1 AND COALESCE(is_visible,true)=true`
  for the doctor's `specialty_id`; left-joins `doctor_services` for the logged-in
  doctor to compute the ticked flag per row. Also loads `users.sub_specialties`
  (jsonb) and the specialty name/name_ar for context.
- Renders `src/views/portal_doctor_services.ejs` (new), cloned from
  `portal_doctor_cases.ejs` conventions: `include('partials/header', { portalFrame:true,
  portalRole:'doctor', portalActive:'services', ... })` → `layouts/portal.ejs`
  (loads v2 CSS + sidebar) → `include('partials/doctor/topbar', {...})`.
- Row shows: service name (name_ar in AR), `base_price`, `doctor_fee` labelled
  **"You earn"** (`تكسب`), `sla_hours`, and a checkbox reflecting an existing
  `doctor_services` row. `sub_specialties` shown above the list as context.
  **Never uses `doctor_commission_pct`.**
- **Empty-catalogue escape hatch:** if the specialty has 0 visible services, render
  a short "services for your specialty are being finalised — you'll be notified"
  note instead of the list; **do not** set `onboarding_complete`.

#### 4.2 `POST /portal/doctor/services`
- Body: array of ticked `service_id`s (+ `confirm_empty` flag).
- **Server-side specialty guard:** reject any `service_id` whose `specialty_id` !=
  the doctor's `specialty_id` (do not trust client). Re-query the DB to authorize
  the full ticked set.
- **Diff in one `withTransaction`** (`require('../pg')`): INSERT missing rows
  (`ON CONFLICT (doctor_id, service_id) DO NOTHING`), DELETE unticked rows for this
  doctor. Pattern mirrors `superadmin.js:3040-3086` (DELETE-then-INSERT junction).
- **Zero-services rule:** if the ticked set is empty and `confirm_empty` is not set,
  re-render with a warning and require explicit confirmation. Never silent.
- On first successful save, set `users.onboarding_complete = true` (any explicit
  save, including a confirmed-empty save, counts as onboarding done — assignability
  is separately governed by service-level matching in §4.6).
- After commit, call the **re-sync helper** (§4.3).

#### 4.3 Re-sync helper — `src/services/services_coming_soon_sync.js`
- Single exported function running the **exact** spec SQL, unchanged, keyed on
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
- Accepts an optional `client` so it can run inside a caller's transaction, else
  uses the pool. Idempotent.
- **Call sites:** after any `doctor_services` change (§4.2), and after any change to
  a doctor's `is_active` — i.e. wire into:
  - Web approve: `superadmin.js` `POST /superadmin/doctors/:id/approve`.
  - Command API approve: `src/services/admin_doctor_approve.js`.
  - Command API pause/reactivate: `src/services/admin_doctor_pause.js` — note pause
    toggles `is_paused` not `is_active`, so re-sync is a **no-op** there by the
    formula, but reactivation that flips `is_active` must re-sync. Wire it where
    `is_active` can change; safe to call after pause too (0-change).
  - Any web superadmin edit that flips `is_active`.

#### 4.4 Coming Soon — catalogue guard (`src/views/services.ejs`)
- When `service.coming_soon`: render a `.v2-chip--soon` "Coming Soon" / "قريبًا"
  badge, wrap `.service-price` in `<% if (!service.coming_soon) %>` (hide price),
  and replace the `<a href>` CTA with a non-navigating, `aria-disabled` element (no
  link). Card markup at `services.ejs:468-484`.
- Query (`static-pages.js:99-119`) already returns `coming_soon` via `sv.*`. All 140
  visible services have `base_price > 0`, so the `base_price > 0` filter does not
  hide coming-soon rows in prod; no query relaxation required, but confirm at build.
  Route is cached (`_servicesCache`) — no cache-shape change needed (extra boolean
  column only), verify.

#### 4.5 Coming Soon — order POST reject (BOTH paths)
- **Web wizard** (`patient.js`): extend the visibility check at step3
  (`~1871-1874`) and step4 (`~1983-1997`) to also reject `coming_soon = true`.
  Reuse/extend `servicesVisibleClause()` (`patient.js:893-898`) → add a
  `servicesBookableClause()` = `COALESCE(is_visible,true)=true AND
  COALESCE(coming_soon,false)=false`.
- **Mobile API** `POST /api/v1/cases` (`api/cases.js:236`): currently checks
  **neither** `is_visible` nor `coming_soon`. Add both — reject unbookable services
  with a clear error (`SERVICE_NOT_BOOKABLE`). This is the important half: a stale
  page or direct POST must not create an unfulfillable order.

#### 4.6 Assignment safety — onboarding gate + service-level matching
Introduce a **shared eligibility fragment** to prevent drift across sites:
`src/routes/api/_assign_helpers.js` (or a new `src/services/doctor_eligibility.js`)
exporting an `ELIGIBLE_DOCTOR_CLAUSE(alias, { serviceIdParam })` builder that emits:
```
<alias>.role = 'doctor'
AND COALESCE(<alias>.is_active, true) = true
AND COALESCE(<alias>.is_paused, false) = false
AND COALESCE(<alias>.onboarding_complete, false) = true
AND EXISTS (SELECT 1 FROM doctor_services ds
            WHERE ds.doctor_id = <alias>.id AND ds.service_id = <serviceIdParam>)
```
(Preserve each site's existing `specialty_id` / tier / capacity / `pending_approval`
predicates.) The `EXISTS(doctor_services ...)` clause is the **service-level
matching** — doctors are eligible only for the specific service they confirmed.
Every site must have the case's `service_id` available; thread it where a site
currently carries only `specialty_id`.

**9 call sites** (verified; verify the 3 marked at build):
1. `api/admin.js:901` — candidates picker `GET /cases/:id/candidates`.
2. `api/admin.js:1089-1096` — single-assign `POST /cases/:id/assign` (SELECT +
   JS guard; add `onboarding_complete` + service-membership check →
   `DOCTOR_ONBOARDING_INCOMPLETE` / `DOCTOR_SERVICE_NOT_OFFERED`).
3. `services/admin_bulk_assign.js:107-111` — bulk pool query.
4. `services/admin_bulk_assign.js:130` — JS eligibility filter.
5. `case_sla_worker.js:41` — `buildAlternateDoctorQuery` clauses (hottest path,
   ~5 min). Covers both `selectAlternateDoctor` calls (`:102-122`).
6. `auto_assign.js:29-33` — `eligibleDoctorsFor`.
7. `auto_assign.js:133-136` — specialty pool COUNT (verify at build).
8. `assign.js:7-14` — `pickDoctorForOrder`.
9. `superadmin.js:3688` — reassign SELECT (verify at build).

#### 4.7 Soft nudge, sidebar, first-login landing (NO navigation hard-gate)
- **Sidebar:** add a "Services" item to `partials/doctor/sidebar.ejs` Work section
  (pattern at `:75-84`), add `'services':'services'` to the `_isActive` alias map,
  pass `portalActive:'services'`.
- **Global banner:** add a small partial included by the doctor topbar
  (`partials/doctor/topbar.ejs`, rendered by every doctor page) shown while
  `onboarding_complete = false` **and** the doctor's specialty has visible services
  — "Confirm the services you accept →". Do **not** tie to `first_login_at`
  (self-clears on first dashboard hit).
- **First-login landing:** in `POST /set-password` (and the `/magic-login`
  password-set redirect), if the user is a doctor with `onboarding_complete = false`
  **and** their specialty has visible services, redirect to `/portal/doctor/services`
  instead of `/portal/doctor`. Empty-catalogue doctors land on the dashboard. This
  is a one-time redirect at first login, not a persistent guard → **no redirect
  loops**. Keep `first_login_at` stamping as-is.

#### 4.8 Migration `078_services_coming_soon.sql`
- Idempotent `ALTER TABLE public.services ADD COLUMN IF NOT EXISTS coming_soon
  BOOLEAN NOT NULL DEFAULT false;` (no-op in prod, real on fresh/local DBs).
- Run one idempotent re-sync (the §4.3 SQL) so fresh/local DBs are correct; 0-change
  in prod. Verify every referenced column against `information_schema` before push
  (server refuses to boot on migration failure). Next number is **078** (highest is
  `077`).

### Package 2 — Welcome-token hardening + bulk invite

Existing flow **is reused** (not replaced): `password_reset_tokens` table +
`GET /magic-login/:token` + `GET/POST /set-password` + doctor-approve mint. Token
storage stays plaintext single-use UUID (RLS-enabled, service-role-only — same blast
radius as `users.password_hash`). Verified verdicts and required fixes:

- ✅ **Single-use** (`used_at` set before session) — keep.
- ✅ **No plaintext token logging** — keep.
- 🔴 **CRITICAL: `/magic-login/:token` establishes the session BEFORE checking
  `password_hash`** (`auth.js:492-530`) → a doctor who already set a password can be
  logged in password-free by any old unused token. **Fix:** if `password_hash` is
  set, do **not** auto-login; redirect to `/login`. This closes the backdoor
  regardless of remint state.
- 🔴 **Remint does not invalidate old tokens** (INSERT-only at
  `admin_doctor_invite.js:67-71`, `superadmin.js:3127-3131`, `auth.js:155-164`,
  `auth.js:428-442`). **Fix:** before each mint, in the same txn after any
  `FOR UPDATE`, `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS
  NULL`. Makes re-running the bulk batch safe (exactly one live token per doctor).
- 🔴 **No rate-limiting** on `/magic-login/:token`, `/reset-password/:token`,
  `/set-password`, invite/resend. **Fix:** add per-IP limiters reusing the
  `otpIpLimiter` pattern (`auth.js:320-341`).
- **Shorten welcome TTL 168h → 72h** (29 emails at once = wide window) and
  **single-source** `WELCOME_EXPIRY_HOURS` (currently duplicated in
  `doctor_welcome_payload.js:18` and `superadmin.js:55`).
- **Bulk action** `POST /superadmin/doctors/bulk-welcome-passwordless` (option (a)):
  loop the existing `inviteDoctor(client, {...})` service over
  `WHERE role='doctor' AND is_active=true AND password_hash IS NULL`, one txn per
  doctor. **Idempotent** (remint-DELETE makes re-runs produce one token each), skips
  anyone who already set a password, respects a `welcome_email_last_sent_at`
  cooldown, returns a recap `{ sent, skipped, failed }`. Reusable for every future
  doctor. Notifications carry a dedupe key.

---

## 5. Data model changes

| Change | Table | Detail |
|---|---|---|
| Add column (idempotent) | `services` | `coming_soon BOOLEAN NOT NULL DEFAULT false` — formalizes the already-live prod column in schema-as-code (migration 078). |
| No new columns | `users` | Reuse `onboarding_complete` (already exists, currently written-only) as the confirmation/assignment signal. No `terms_accepted` (Package 3, out of scope). |

**Boundary note:** the self-signup path (`auth.js:1063`, part of the carved-out
`/apply` area) writes `onboarding_complete = true` unconditionally, so it is not a
perfect gate on its own for *future* self-signups. This build does not touch that
path. The **service-level `EXISTS(doctor_services ...)` matching (§4.6) is the real
safety net** — a doctor with `onboarding_complete=true` but no confirmed row for a
given service is still excluded from that service's pool. The 29 current doctors are
all `onboarding_complete=false`, so both signals gate them today.
| No schema change | `doctor_services` | Existing junction; INSERT `ON CONFLICT DO NOTHING`, DELETE on untick. |

---

## 6. i18n / RTL

- Reuse the existing mechanism: request lang via `middleware.js:205-210`; `dir`
  via `getDir(lang)` on `layouts/portal.ejs`; the inline `tt(en, enAlt, ar)` helper
  used by existing doctor views (mirror the `portal_doctor_cases.ejs:40-41`
  convention) OR `res.locals.tt`. Numbers via `toLocaleString(isAr?'ar-EG':'en-US')`.
- Bilingual DB fields: `isAr && obj.name_ar ? obj.name_ar : obj.name`.
- New strings (EN/AR): "My Services / خدماتي", "You earn / تكسب", "Coming Soon /
  قريبًا", "Confirm the services you accept / أكد الخدمات التي تقبلها", the
  zero-services warning, and the empty-catalogue note. All `tt()` calls carry EN+AR
  fallbacks.

---

## 7. Error handling

- POST specialty mismatch → reject the offending id(s), re-render with error (never
  silently drop).
- Zero ticked without `confirm_empty` → warn + require confirmation.
- Order POST for unbookable service → `SERVICE_NOT_BOOKABLE` (web: `err=` redirect
  as today; API: JSON error).
- Assignment of ineligible doctor → `DOCTOR_ONBOARDING_INCOMPLETE` /
  `DOCTOR_SERVICE_NOT_OFFERED` (HTTP 409).
- Re-sync helper failures must not corrupt the doctor's save — the save txn commits
  first; re-sync runs after (best-effort with logging) OR inside the same txn if
  cheap and safe. Decide in plan; prefer post-commit best-effort to avoid coupling.

---

## 8. Testing

Required (from brief) + additions. Prefer prod-schema-clone / hermetic tests; do
prod write **dry-runs** via Supabase MCP `BEGIN…ROLLBACK` before any real write.

- Doctor sees only their own specialty's visible services (not others').
- Cross-specialty `service_id` in POST is rejected server-side.
- Unticking the last active doctor on a service flips it to `coming_soon` (re-sync).
- Re-ticking restores bookable state.
- Order POST for a `coming_soon` service is rejected — **web wizard AND
  `POST /api/v1/cases`**.
- Order POST for `is_visible=false` rejected on the mobile API (new guard).
- Zero-services save requires explicit confirmation; `onboarding_complete` flips.
- Empty-catalogue (Pediatrics) doctor first login: no redirect to /services, no
  services banner, no loop; `onboarding_complete` stays false.
- Doctor with `onboarding_complete=false` is not in any assignment pool (all 9
  sites, esp. `case_sla_worker`).
- Service-level matching: a doctor who ticked only service A is **not** an eligible
  candidate for a case of service B in the same specialty.
- Doctor confirms services → becomes assignable for the ticked services.
- Token: old unused welcome token cannot log a doctor in after password set
  (backdoor closed); re-running the bulk batch yields exactly one live token per
  doctor; rate-limiter blocks rapid redemption attempts.
- Doctor with an already-assigned open case can still open its detail page while
  gaps outstanding (no navigation gate exists — assignment gate only).

---

## 9. Deployment sequencing (must communicate)

1. **All 29 doctors are `onboarding_complete=false`**, so the moment the assignment
   gate ships they are **all unassignable until they confirm services**. Intended
   safety behaviour; the loop is already dark. Order: **deploy code → send welcome
   emails → doctors confirm → assignable.**
2. **~67 of 140 visible services** have no active doctor and will render "Coming
   Soon" (price hidden, CTA disabled) the instant the catalogue guard ships — ~half
   the public catalogue. Correct per the supply model; flagged for awareness. Shrinks
   as doctors confirm services.
3. Migrations apply on boot from `main`; server refuses to start on failure.
   Column-verify via `information_schema` before push.

---

## 10. Explicitly NOT doing

- No Supabase Auth users; no RLS access path (custom JWT sessions only).
- No use of `doctor_commission_pct` anywhere.
- No changes to urgency multiplier / payout calculation.
- No `/apply` route changes.
- No licence/terms/availability blocking gates (Package 3, separate item).
- Re-sync stays keyed on `is_active`, not `is_paused` (do not change without asking).
