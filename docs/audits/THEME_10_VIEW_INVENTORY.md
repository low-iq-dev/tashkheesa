# Theme 10 — View Inventory (Phase 1 deliverable)

**Generated:** 2026-05-08
**Source:** `docs/audits/THEME_10_ARABIC_I18N_FIX_PLAN.md` (commit `305133b`)
**Working tree HEAD:** `0ed91dd` (`fix(pool): kill saturation antipattern...`)
**Method:** direct grep against `src/views/*.ejs` (excluding `admin*`, `ops-*`, `superadmin*`, `*.bak`).

This inventory is the input for **Theme 10 Phase 2 (bulk Arabic translation)**.
Phase 1 (this commit) ships the foundation: canonical `tt(key, enFallback,
arFallback)` helper, `src/locales/` archived, dialect-tone documented in
`src/i18n.js`. No view content is translated in Phase 1.

---

## 0. Conventions used in this file

- **status** — derived from the live grep, not the audit table:
  - `none` — zero i18n primitives (`<%= tt(`, `<%= t(`, `<%= L(`, `<%= _t(`, `isAr`, `lang === 'ar'`).
  - `partial` — 1–2 primitives total, view is mostly hardcoded English.
  - `covered` — ≥ 3 primitives **and** density ≥ ~1 per 30 lines.
  - `covered (debt)` — `covered` but uses local `L(en, ar)` / `_t(en, ar)`
    helper that needs migration to canonical `tt()`.
- **batch** — Phase 2 sub-batch this view lands in:
  - `2A` — P0 critical (homepage / coming-soon / services).
  - `2B` — P1 entry funnel + auth + error pages.
  - `2C` — P2 marketing tail (blogs, app-landing, specialty pages).
  - `2D` — P3 consistency cleanup (debt: replace `L`/`_t` with `tt`).
  - `oos-legal` — **out of scope** (legal pages stay EN per OQ-1 addendum).
  - `oos-internal` — internal-only surface, not user-facing.
  - `none` — already covered, no Phase 2 work required.
- **legal?** — yes if the view is privacy / terms / refund / delivery copy.
- **est. strings** — rough count of user-visible translatable strings,
  estimated from grep call counts + audit notes. Used for batch sizing.

---

## 1. Phase 2 — Batch A: P0 critical (3 views)

> Homepage + coming-soon + services. **Block launch.**
> Plus the homepage `<html lang="en">` + `onclick="switchLang(...)"` CSP fix
> (per OQ-6) which rides in the same atomic commit as the homepage translation.

| View | Lines | Status | Est. strings | Notes |
|---|---:|---|---:|---|
| `index.ejs` | 388 | none | ~69 | Hardcoded `<html lang="en">` line 2; hardcoded `<meta og:locale="en_US">` line 17; `onclick="switchLang(...)"` lines 82–83 (CSP-violating, fold in per OQ-6). |
| `coming_soon.ejs` | 400 | none | ~22 | Redirect target from `order_flow.js:54,116`, `static-pages.js:71`, 8× `patient.js`. Highest-impact AR gap after homepage. |
| `services.ejs` | 498 | partial | ~80 | Has 2 `isAr` ternaries + `__isAr` block at line 326. Otherwise EN-only nav cards. Homepage's primary outbound CTA. |

**Batch A total:** ~171 user-visible strings.

---

## 2. Phase 2 — Batch B: P1 entry funnel + auth + errors (10 views)

| View | Lines | Status | Est. strings | Notes |
|---|---:|---|---:|---|
| `about.ejs` | 49 | none | ~18 | Linked from homepage and coming-soon. |
| `contact.ejs` | 88 | none | ~20 | Form labels + footer links. |
| `faq.ejs` | 314 | partial (1) | ~40 | One inline `isAr` ternary; otherwise EN-only Q&A blocks. |
| `error.ejs` | 37 | none | ~6 | Already threads `lang`/`dir` from locals; body is EN-only. |
| `404.ejs` | 10 | none | ~3 | Surfaces on every typo'd URL. |
| `appointment_detail.ejs` | 165 | none | ~24 | Video-call detail page. |
| `public_case_thankyou.ejs` | 38 | none | ~8 | Public intake confirmation. |
| `login.ejs` | 85 | partial (2) | ~12 | Inline `effectiveLang` switch driving an EN/AR object — pattern doesn't match codebase; consolidate to `tt()`. |
| `order_confirmation.ejs` | 57 | partial (4) | ~10 | 2 `isAr` + 2 `lang === 'ar'`; mostly EN. |
| `order_upload.ejs` | 228 | partial (5) | ~30 | 4 `isAr` + 1 `lang === 'ar'`. Verify still in use before fixing — `742b464` retired patient flow. |

**Batch B total:** ~171 user-visible strings.

---

## 3. Phase 2 — Batch C: P2 marketing tail (7 views)

| View | Lines | Status | Est. strings | Notes |
|---|---:|---|---:|---|
| `app_landing.ejs` | 265 | none | ~45 | Mobile-app landing. |
| `_app_waitlist_form.ejs` | 25 | none | ~6 | App waitlist embed (partial). |
| `specialties_index.ejs` | 90 | partial (1) | ~18 | One inline ternary; rest EN. |
| `specialty_detail.ejs` | 225 | partial (1) | ~35 | One inline ternary; per-specialty marketing. |
| `blog_index.ejs` | 103 | partial (2) | ~22 | `__isAr` defined line 3, then ~22 EN-only blocks. |
| `blog_how_tashkheesa_works.ejs` | 214 | partial (2) | ~50 | `__isAr` defined line 3, then long-form EN content. |
| `blog_when_to_get_second_opinion.ejs` | 204 | partial (2) | ~48 | Same shape as above. |

**Batch C total:** ~224 user-visible strings.

---

## 4. Phase 2 — Batch D: P3 consistency cleanup / debt (covered + helper migration)

> These views render correctly today but use **local** `L(en, ar)` or
> `_t(en, ar)` helpers instead of the canonical `tt(key, enFallback,
> arFallback)`. Phase 2 mass-migration replaces them mechanically.
> See §6 for the exhaustive helper-replacement target list.

### 4a. Patient surface (uses local `L(en, ar)`):

| View | Lines | `L(` calls | `tt(` calls | Notes |
|---|---:|---:|---:|---|
| `patient_dashboard.ejs` | 434 | 25 | 0 | `__isAr` line 19, `function L` line 24. |
| `patient_new_case.ejs` | 992 | 84 | 0 | `__isAr` line 20, `function L` line 46. |
| `patient_order.ejs` | 858 | 62 | 0 | `__isAr` line 21, `function L` line 31. |
| `patient_payment_required.ejs` | 487 | 39 | 0 | `__isAr` line 18, `function L` line 23 + JS-injected `var L` line 428. |
| `patient_payment_success.ejs` | 188 | 14 | 0 | `function L` line 18. |
| `patient_profile.ejs` | 202 | 25 | 0 | `__isAr` line 11, `function L` line 16. |
| `patient_records.ejs` | 268 | 21 | 0 | `function L` line 16; **also has JS-literal `_isAr` interpolation hazard (P3-VIEW-60).** |
| `patient_alerts.ejs` | 163 | 5 | 0 | `__isAr` line 10, `function L` line 12. |
| `patient_referrals.ejs` | 143 | 13 | 0 | `function L` line 16. |
| `patient_review_form.ejs` | 175 | 10 | 0 | `_isAr` line 13, `__isAr` line 14, `function L` line 16. |
| `patient_reviews.ejs` | 120 | 8 | 0 | `_isAr` line 10, `__isAr` line 11, `function L` line 13. |
| `patient_appointments_list.ejs` | 135 | 6 | 0 | `__isAr` line 13, `function L` line 15. |
| `patient_case_report.ejs` | 357 | 22 | 0 | `__isAr` line 27, `function L` line 43. |
| `patient_prescriptions.ejs` | 101 | 7 | 0 | `__isAr` line 10, `function L` line 12. |
| `patient_prescription_detail.ejs` | 111 | 14 | 0 | `__isAr` line 12, `function L` line 14. |
| `patient_404.ejs` | 41 | 4 | 0 | `__isAr` line 6, `function L` line 6. |
| `patient_500.ejs` | 56 | 5 | 0 | `__isAr` line 10, `function L` line 14. |

### 4b. Doctor surface (uses local `_t(en, ar)`):

| View | Lines | `_t(` calls | `tt(` calls | Notes |
|---|---:|---:|---:|---|
| `portal_doctor_profile.ejs` | 1325 | 90 | 0 | `_isAr` line 25, `function _t` line 25. Largest single view. |
| `portal_doctor_case.ejs` | 565 | 81 | 0 | `_isAr` line 4, `function _t` line 18. |
| `portal_doctor_dashboard.ejs` | 741 | 0 | 0 | `_isAr` line 5, then 83 inline `isAr ?` ternaries (no helper). Migrate ternaries → `tt()`. |
| `doctor_signup.ejs` | 471 | 75 | 0 | `function _t` line 14. |
| `doctor_appointments.ejs` | 358 | 0 | 0 | `function _t` line 10 (defined but use is via 57 `isAr ?` ternaries). |
| `doctor_case_intelligence.ejs` | 744 | 0 | 0 | `function _t` line 71; 50 `isAr ?` ternaries. |
| `doctor_prescribe.ejs` | 1007 | 0 | 0 | `var L = {...}` JS object line 499 — different shape; 76 `isAr ?` ternaries. |
| `doctor_prescription_detail.ejs` | 185 | 16 | 0 | `_isAr` line 11, `function _t` line 16. |
| `doctor_prescriptions_list.ejs` | 129 | 15 | 0 | `_isAr` line 11, `function _t` line 14. |
| `doctor_login_v2.ejs` | 78 | 18 | 0 | `function _t` line 8. |
| `doctor_pending_approval.ejs` | 58 | 14 | 0 | `_isAr` line 2, `function _t` line 6. |
| `doctor_signup_submitted.ejs` | 32 | 6 | 0 | `_isAr` line 2, `function _t` line 6. |
| `portal_doctor_cases.ejs` | 215 | 10 | 0 | `function _t` line 19. |
| `portal_doctor_earnings.ejs` | 162 | 25 | 0 | `function _t` line 9. |
| `portal_doctor_guide.ejs` | 302 | 0 | 0 | `_isAr` line 3, `function _t` line 4 (defined but only 14 inline `isAr ?` ternaries). |
| `doctor_alerts.ejs` | 162 | 4 | 0 | `_isAr` line 9, `function L(en,ar) { return _isAr ? ar : en; }` line 10 (uses **L** not `_t` — odd hybrid). |
| `doctor_analytics.ejs` | 216 | 0 | 0 | `function _t` line 10; 22 `isAr ?` ternaries. |
| `doctor_reviews.ejs` | 102 | 0 | 0 | `_isAr` line 4, 8 `isAr ?` ternaries. |

### 4c. Other views with debt (inline `isAr` ternaries, no local helper):

| View | Lines | `isAr` count | Notes |
|---|---:|---:|---|
| `patient_walkthrough.ejs` | 859 | 130 | Heaviest inline-ternary user; heavy migration. |
| `patient_onboarding.ejs` | 411 | 47 | |
| `messages.ejs` | 337 | 38 | **JS-literal `_isAr` interpolation hazard (P3-VIEW-60).** |
| `intake_form.ejs` | 107 | 29 | |
| `public_case_new.ejs` | 151 | 41 | |
| `register.ejs` | 73 | 13 | Only view using `<%= t('flat.key') %>` (5 calls). Migrate to `tt()`. |
| `intake_thank_you.ejs` | 52 | 17 | |
| `forgot_password.ejs` | 114 | 9 | Drop duplicate `auth.errors.*` map (P3-VIEW-71). |
| `reset_password.ejs` | 55 | 8 | |
| `set_password.ejs` | 54 | 8 | |
| `reset_password_invalid.ejs` | 36 | 7 | |
| `order_review.ejs` | 221 | 42 | |
| `order_payment.ejs` | 78 | 11 | |
| `order_urgency_conflict.ejs` | 71 | 3 | + `function _t` line 3. |
| `order_start.ejs` | 28 | 5 | |
| `help_admin_guide.ejs` | 656 | 132 | |
| `help_doctor_guide.ejs` | 619 | 104 | |
| `help_patient_guide.ejs` | 693 | 124 | |
| `help_me_choose.ejs` | 195 | 0 (10× `lang === 'ar'`) | Pattern outlier — uses `lang === 'ar'` directly. |
| `video_appointment.ejs` | 457 | 3 | + 69 `tt(en, ar)` 2-arg calls. **All 2-arg `tt` calls need migration to 3-arg `tt(key, en, ar)`** (see §7). |
| `video_call_room.ejs` | 342 | 3 | + 17 `tt(en, ar)` 2-arg calls. |
| `video_call_ended.ejs` | 90 | 2 | + 14 `tt(en, ar)` 2-arg calls. |
| `appointment_booking.ejs` | 65 | 3 | + 9 `tt(en, ar)` 2-arg calls. |
| `appointment_availability.ejs` | 41 | 2 | + 4 `tt(en, ar)` 2-arg calls. |

---

## 5. Out of scope — legal pages (4 views)

> Per OQ-1 addendum: legal pages **stay in English**. Egyptian Law No.
> 181/2018 requires unambiguous Arabic legal language — out of MT scope.
> Ziad will handle legal AR separately with proper compliance review.

| View | Lines | Status | Notes |
|---|---:|---|---|
| `privacy.ejs` | 60 | **oos-legal** | Out of scope for translation. |
| `terms.ejs` | 56 | **oos-legal** | Out of scope. |
| `refund_policy.ejs` | 71 | **oos-legal** | Out of scope. |
| `delivery_policy.ejs` | 89 | **oos-legal** | Out of scope. |

---

## 6. Out of scope — internal / sandbox (1 view)

| View | Lines | Status | Notes |
|---|---:|---|---|
| `sandbox_order_intake.ejs` | 94 | **oos-internal** | Sandbox/dev surface; deprioritize. Either translate or delete in Phase 2D. |

---

## 7. Helper migration debt — exhaustive site list

Every site below uses a **non-canonical** translation helper. Phase 2
replaces them mechanically with `tt(key, enFallback, arFallback)`.

### 7a. `function L(en, ar)` definition sites (20 total)

```
src/views/patient_404.ejs:6
src/views/patient_500.ejs:14
src/views/patient_alerts.ejs:12
src/views/patient_appointments_list.ejs:15
src/views/patient_case_report.ejs:43
src/views/patient_dashboard.ejs:24
src/views/patient_new_case.ejs:46
src/views/patient_order.ejs:31
src/views/patient_payment_required.ejs:23
src/views/patient_payment_required.ejs:428   # JS-injected `var L = JSON.stringify(__payL)` — different shape, audit before mechanical replace
src/views/patient_payment_success.ejs:18
src/views/patient_prescription_detail.ejs:14
src/views/patient_prescriptions.ejs:12
src/views/patient_profile.ejs:16
src/views/patient_records.ejs:16
src/views/patient_referrals.ejs:16
src/views/patient_review_form.ejs:16
src/views/patient_reviews.ejs:13
src/views/doctor_alerts.ejs:10               # `function L` defined in a `_t`-style file — hybrid
src/views/doctor_prescribe.ejs:499           # JS-object `var L = {...}` — different shape, do NOT auto-replace
```

### 7b. `function _t(en, ar)` definition sites (15 total)

```
src/views/doctor_analytics.ejs:10
src/views/doctor_appointments.ejs:10
src/views/doctor_case_intelligence.ejs:71
src/views/doctor_login_v2.ejs:8
src/views/doctor_pending_approval.ejs:6
src/views/doctor_prescription_detail.ejs:16
src/views/doctor_prescriptions_list.ejs:14
src/views/doctor_signup.ejs:14
src/views/doctor_signup_submitted.ejs:6
src/views/order_urgency_conflict.ejs:3
src/views/portal_doctor_case.ejs:18
src/views/portal_doctor_cases.ejs:19
src/views/portal_doctor_earnings.ejs:9
src/views/portal_doctor_guide.ejs:4
src/views/portal_doctor_profile.ejs:25
```

### 7c. `_isAr` / `__isAr` local-flag definition sites (28 total)

These declarations should be deleted once their downstream `L(...)`,
`_t(...)`, and inline `isAr ?` ternaries are replaced with `tt()`.

```
src/views/admin_chat_moderation.ejs:5         # admin — out of scope for Theme 10
src/views/admin_reviews.ejs:4                 # admin — out of scope for Theme 10
src/views/admin_campaigns.ejs:4               # admin — out of scope for Theme 10
src/views/blog_how_tashkheesa_works.ejs:3
src/views/blog_index.ejs:3
src/views/doctor_alerts.ejs:9
src/views/doctor_pending_approval.ejs:2
src/views/doctor_prescription_detail.ejs:11
src/views/doctor_prescriptions_list.ejs:11
src/views/doctor_reviews.ejs:4
src/views/doctor_signup_submitted.ejs:2
src/views/patient_404.ejs:6
src/views/patient_500.ejs:10
src/views/patient_alerts.ejs:10
src/views/patient_appointments_list.ejs:13
src/views/patient_case_report.ejs:27
src/views/patient_dashboard.ejs:19
src/views/patient_new_case.ejs:20
src/views/patient_order.ejs:21
src/views/patient_payment_required.ejs:18
src/views/patient_prescription_detail.ejs:12
src/views/patient_prescriptions.ejs:10
src/views/patient_profile.ejs:11
src/views/patient_review_form.ejs:13-14
src/views/patient_reviews.ejs:10-11
src/views/portal_doctor_case.ejs:4
src/views/portal_doctor_dashboard.ejs:5
src/views/portal_doctor_guide.ejs:3
src/views/services.ejs:326
```

### 7d. `onclick="switchLang(...)"` inline handlers — CSP debt

```
src/views/index.ejs:82-83
```

OQ-6: fix folds into Batch 2A homepage commit.

### 7e. Legacy 2-arg `tt(enText, arText)` call sites

> The canonical signature is `tt(key, enFallback, arFallback)` — three args.
> The implementation in `src/middleware.js` preserves the prior behavior
> for 2-arg calls verbatim, **but in EN mode 2-arg calls return the
> Arabic fallback** (the second arg is treated as `enFallback`).
> This is pre-existing behavior — out of scope to fix in Phase 1, but
> every 2-arg call site below must be migrated to 3-arg form during
> Phase 2 to render correctly:

```
src/views/video_appointment.ejs           # 69 calls
src/views/video_call_room.ejs             # 17 calls
src/views/video_call_ended.ejs            # 14 calls
src/views/appointment_booking.ejs         # 9 calls
src/views/appointment_availability.ejs    # 4 calls
```

### 7f. `<%= t('flat.key') %>` (1 view, 5 calls)

```
src/views/register.ejs   # 5 calls — flat-key lookup against src/i18n.js. Migrate to tt() with explicit fallbacks.
```

---

## 8. Summary stats

- **84 user-facing views** total (excludes `admin*`, `ops-*`, `superadmin*`).
- **24 effectively English-only** (status `none` or `partial`):
  - 19 `none`: `404`, `_app_waitlist_form`, `about`, `app_landing`,
    `appointment_detail`, `coming_soon`, `contact`, `delivery_policy`,
    `error`, `faq`, `index`, `privacy`, `public_case_thankyou`,
    `refund_policy`, `sandbox_order_intake`, `services`,
    `specialties_index`, `specialty_detail`, `terms`.
    *(Of these, 4 are legal/oos and 1 is sandbox/oos → 14 are real Phase 2 work.)*
  - 5 `partial` (1–2 primitives): `blog_how_tashkheesa_works`, `blog_index`,
    `blog_when_to_get_second_opinion`, `login`, `order_confirmation`.
- **60 covered** views: render correctly in AR today but most carry
  helper-migration debt (Batch 2D).
- **5 oos**: 4 legal pages + 1 sandbox.
- **Translation work for Phase 2A (P0 critical):** ~171 strings, blocks launch.
- **Translation work for Phase 2B (P1 entry):** ~171 strings.
- **Translation work for Phase 2C (P2 marketing tail):** ~224 strings.
- **Helper migration in Phase 2D:** ~35 helper definition sites + ~700+
  call sites; mechanical find-and-replace, scripted.

---

## 9. Phase 1 deliverables — what shipped with this inventory

1. `src/middleware.js` — canonical `tt(key, enFallback, arFallback)` defined
   alongside `res.locals.t`. Behavior: catalog lookup first; falls back to
   `enFallback` (EN) or `arFallback` (AR); never throws, never returns
   `undefined`. Preserves prior server.js fallback behavior verbatim.
2. `src/server.js` — pre-existing fallback `tt`/`t` definitions retained as
   defense-in-depth (no-op when middleware sets them first), comment
   updated to make this explicit.
3. `src/i18n.js` — header comment documents Egyptian-dialect tone
   convention for non-legal AR strings; documents legal-EN-only carve-out;
   points contributors at this file for migration debt.
4. `src/locales/` → `src/locales.archived-2026-05/` (`git mv`); README
   inside the archived directory explains why and when it can be deleted.
5. `src/i18n/i18n.js` — path updated to track the rename; remains
   loadable; still dead code (no requires).
6. `docs/audits/THEME_10_VIEW_INVENTORY.md` (this file) — exhaustive
   per-view inventory; helper migration debt catalogued.

No view content was translated in Phase 1.
