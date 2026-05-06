# Theme 10 — Arabic i18n: Fix Plan (Scoping Only)

**Date:** 2026-05-06
**Author:** Claude Opus 4.7 (1M context), interactive
**Source audit:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` §09 UI/UX (P0-UI-1..3, P1-UI-13/14, P2-UI-15) + Tier 11 P0 line items 62–65.
**Working tree HEAD:** `213d07d` (`docs(audit): comprehensive pre-launch audit 2026-05-06`)
**Status:** SCOPING ONLY — no code touched. Numbers verified by direct grep on the working tree at HEAD.

---

## 1. Executive Summary

Tashkheesa ships two i18n systems. One is alive (`src/i18n.js`, ~200 inline keys, exposed via `res.locals.t` / `res.locals.tt` in `src/middleware.js:220`). The other is fully dead (`src/locales/{en,ar}.json` + `src/i18n/i18n.js`'s `getTranslator`) — **not even loaded at runtime**: nothing requires `src/i18n/i18n.js`, so the 102 EN / 170 AR JSON keys are inert disk artifacts. Whoever has been editing them has been editing a parallel universe.

Of 84 user-facing top-level views (excluding `admin*`, `ops-*`, `superadmin*`), **19 have zero i18n primitives** and a further **5 have only one** — effectively 24 English-only pages. The audit's "33/122" stat folds in staff portals and counts views with one or two ternaries as English-only; both shapes of the number agree on the spirit: roughly a quarter of customer-reachable HTML never branches on language. Critical surfaces in this set: `index.ejs` (homepage, hardcoded `<html lang="en">`), `coming_soon.ejs` (the redirect target for `/order/start`), and all four legal pages (`privacy`, `terms`, `refund_policy`, `delivery_policy`).

RTL is partially wired: layouts thread `<%= pageDir %>` correctly, 72 `[dir=rtl]` CSS rules and 74 logical-property declarations exist, but 50 physical `margin-left/right` rules remain and `index.ejs` bypasses the layout entirely with a hardcoded `<html lang="en">`.

**Recommended path:** delete `src/i18n/i18n.js` + `src/locales/`, consolidate on `src/i18n.js`, then phase translations from homepage → legal → entry-funnel → tail, with a CI lint gate that fails new English-only views.

---

## 2. Current State

### 2A. Sub-issue A — User-facing view i18n inventory

**Filter applied:** `src/views/*.ejs`, excluding `*.bak`, `admin*`, `ops-*`, `superadmin*`. → **84 views**.
*(The audit's "122" denominator includes the 37 staff views — admin/ops/superadmin — and apparently also a slice of partials. The user-facing surface alone is 84.)*

**i18n call counts** measured by grep for any of: `<%= t(`, `<%= tt(`, `<%= L(`, `<%= _t(`, `<%= __(`, `isAr`, `_isAr`, `lang === 'ar'` inside `<% %>` tags.

| View | Calls | Lines | Priority bucket | Notes |
|---|---:|---:|---|---|
| index.ejs | 0 | 388 | **P0 — homepage** | Hardcoded `<html lang="en">`, hardcoded `<meta og:locale="en_US">`, EN-only nav + hero + CTAs. |
| coming_soon.ejs | 0 | 400 | **P0 — funnel** | Current `/order/start` and unavailable-wizard redirect target (`order_flow.js:54,116`, `patient.js` ×8 `/coming-soon` redirects, `static-pages.js:71`). |
| privacy.ejs | 0 | 60 | **P0 — legal** | Egyptian regulators expect AR. Body is ~28 translatable strings. |
| terms.ejs | 0 | 56 | **P0 — legal** | ~25 strings. |
| refund_policy.ejs | 0 | 71 | **P0 — legal** | ~29 strings. |
| delivery_policy.ejs | 0 | 89 | **P0 — legal** | ~33 strings. |
| services.ejs | 0 | 498 | **P0 — entry funnel** | Browse-services destination from homepage / coming-soon CTAs. |
| about.ejs | 0 | 49 | P1 — marketing | Linked from homepage and coming-soon. |
| contact.ejs | 0 | 82 | P1 — marketing | Linked from homepage. |
| faq.ejs | 0 | 314 | P1 — support | Customer support surface. |
| 404.ejs | 0 | 10 | P1 — error | Surfaces on every typo'd URL. |
| error.ejs | 0 | 37 | P1 — error | Generic 500. Already threads `<html lang>`/`dir` from locals (`error.ejs:2`), but body is EN-only. |
| public_case_thankyou.ejs | 0 | 38 | P1 — funnel exit | Public intake confirmation. |
| sandbox_order_intake.ejs | 0 | 94 | P3 — internal | Sandbox/dev surface; deprioritize. |
| appointment_detail.ejs | 0 | 165 | P1 — flow | Video-call detail page. |
| _app_waitlist_form.ejs | 0 | 25 | P2 — partial-ish | App waitlist embed. |
| app_landing.ejs | 0 | 258 | P2 — marketing | Mobile-app landing. |
| specialties_index.ejs | 0 | 90 | P2 — marketing | Specialty browse. |
| specialty_detail.ejs | 0 | 225 | P2 — marketing | Per-specialty detail. |
| login.ejs | 1 | 85 | **P0 — auth** | Has 1 inline `effectiveLang` switch driving an inline EN/AR object — practically translated, but pattern doesn't match the rest of the codebase. Treat as P3-debt (consolidate), not P0 retranslate. |
| order_confirmation.ejs | 1 | 57 | P1 — funnel | One-call: insufficient. |
| blog_index.ejs | 1 | 103 | P2 — marketing | Borderline. |
| blog_how_tashkheesa_works.ejs | 1 | 214 | P2 — marketing | Borderline. |
| blog_when_to_get_second_opinion.ejs | 1 | 204 | P2 — marketing | Borderline. |
| order_upload.ejs | 2 | 228 | P1 — funnel | Two calls, mostly EN. Already retired per `742b464` for patient flow; check before fixing. |
| forgot_password.ejs | 6 | 114 | P1 — auth | Uses `isArabicUi` ternary + duplicate auth.errors.* map (P3-VIEW-71 in source audit). |
| set_password.ejs | 8 | 54 | P1 — auth | Doctor onboarding password setup. |
| reset_password.ejs | 8 | 55 | P1 — auth | Verified inline `isAr` ternaries — covered. |
| reset_password_invalid.ejs | 5 | 36 | P2 — auth | Edge-case auth surface. |
| order_start.ejs | 6 | 28 | P2 — funnel | Tiny page; covered. |
| help_me_choose.ejs | 10 | 191 | P2 — support | |
| order_payment.ejs | 11 | 78 | P1 — funnel | Borderline; 11 calls in 78 lines is OK density. |
| order_review.ejs | 37 | 221 | covered | |
| order_urgency_conflict.ejs | 17 | 71 | covered | |
| public_case_new.ejs | 40 | 151 | covered | |
| intake_form.ejs | 30 | 107 | covered | |
| intake_thank_you.ejs | 18 | 52 | covered | |
| register.ejs | 16 | 73 | covered | Uses `<%= t('key') %>` from `src/i18n.js` — the only view that does. |
| messages.ejs | 18 | 337 | covered (debt) | P3-VIEW-60 — interpolates `_isAr` strings inside JS literals; latent escape bug. |
| patient_dashboard.ejs | 27 | 434 | covered | |
| patient_new_case.ejs | 87 | 992 | covered | |
| patient_order.ejs | 64 | 858 | covered | |
| patient_payment_required.ejs | 41 | 487 | covered | |
| patient_payment_success.ejs | 15 | 188 | covered | |
| patient_onboarding.ejs | 47 | 411 | covered | |
| patient_walkthrough.ejs | 123 | 859 | covered | |
| patient_profile.ejs | 28 | 202 | covered | |
| patient_records.ejs | 24 | 268 | covered (debt) | P3-VIEW-60 same JS-literal hazard. |
| patient_referrals.ejs | 16 | 143 | covered | |
| patient_review_form.ejs | 19 | 175 | covered | |
| patient_reviews.ejs | 11 | 120 | covered | |
| patient_alerts.ejs | 6 | 163 | covered | |
| patient_appointments_list.ejs | 7 | 135 | borderline | Density low — re-check. |
| patient_case_report.ejs | 23 | 357 | covered | |
| patient_prescriptions.ejs | 9 | 101 | covered | |
| patient_prescription_detail.ejs | 16 | 111 | covered | |
| patient_404.ejs | 4 | 41 | covered (low) | |
| patient_500.ejs | 5 | 56 | covered (low) | |
| portal_doctor_dashboard.ejs | 62 | 741 | covered | |
| portal_doctor_case.ejs | 85 | 565 | covered | |
| portal_doctor_cases.ejs | 11 | 215 | borderline | |
| portal_doctor_earnings.ejs | 26 | 162 | covered | |
| portal_doctor_guide.ejs | 11 | 302 | borderline | |
| portal_doctor_profile.ejs | 94 | 1325 | covered | |
| doctor_signup.ejs | 79 | 471 | covered | |
| doctor_signup_submitted.ejs | 6 | 32 | covered | |
| doctor_login_v2.ejs | 18 | 78 | covered | |
| doctor_pending_approval.ejs | 14 | 58 | covered | |
| doctor_alerts.ejs | 4 | 162 | borderline | Density low. |
| doctor_analytics.ejs | 19 | 216 | covered | |
| doctor_appointments.ejs | 53 | 358 | covered | |
| doctor_case_intelligence.ejs | 43 | 744 | covered | |
| doctor_prescribe.ejs | 70 | 1007 | covered | |
| doctor_prescription_detail.ejs | 16 | 185 | covered | |
| doctor_prescriptions_list.ejs | 17 | 129 | covered | |
| doctor_reviews.ejs | 5 | 102 | borderline | |
| help_admin_guide.ejs | 130 | 656 | covered | |
| help_doctor_guide.ejs | 102 | 619 | covered | |
| help_patient_guide.ejs | 124 | 693 | covered | |
| video_appointment.ejs | 70 | 457 | covered | (Note: source audit flags `dayjs` ReferenceError P0 for this file — out of scope here.) |
| video_call_room.ejs | 17 | 342 | covered | |
| video_call_ended.ejs | 14 | 90 | covered | |
| appointment_availability.ejs | 4 | 41 | covered (low) | |
| appointment_booking.ejs | 9 | 65 | covered | |

**Counts:**
- **Zero i18n calls:** 19 views — `_app_waitlist_form, 404, about, app_landing, appointment_detail, coming_soon, contact, delivery_policy, error, faq, index, privacy, public_case_thankyou, refund_policy, sandbox_order_intake, services, specialties_index, specialty_detail, terms`.
- **One i18n call (effectively English):** 5 — `blog_how_tashkheesa_works, blog_index, blog_when_to_get_second_opinion, login, order_confirmation`.
- **Effectively English-only:** 24 / 84 ≈ **28.6%**.
- **Source audit's 33/122 is consistent in spirit** with this finding once you (a) include the 7 admin / 4 ops / 1 superadmin staff views with zero-or-one i18n calls, and (b) accept that views like `login.ejs` (1 call) and `order_upload.ejs` (2 calls) functionally behave English-only. Both numbers tell the same story.

### 2B. Sub-issue B — Two parallel i18n systems

**System 1 — LIVE: `src/i18n.js`**
- Plain JS module exporting `t(key, lang)`, `en`, `ar` flat-key dictionaries (~196 EN keys, ~196 AR keys, hand-counted).
- Wired in `src/middleware.js:6,220` — `res.locals.t = (key) => translate(key, lang)`.
- Reinforced by `src/server.js:260-285` which adds a fallback `res.locals.t` and a `res.locals.tt(key, en, ar)` helper.
- Consumed by views via `<%= t('key') %>` (only `register.ejs` does this), and indirectly by `<%= tt('key', enFallback, arFallback) %>` (used across patient/doctor portal views).

**System 2 — DEAD: `src/locales/{en,ar}.json` + `src/i18n/i18n.js`**
- `src/i18n/i18n.js` defines `getTranslator(lang)` that reads `src/locales/en.json` (102 keys) and `ar.json` (170 keys, 68 AR-only) at module-require time.
- `grep -rn "require.*['\"].*i18n/i18n['\"]"` returns **no matches**. `grep -rn "getTranslator"` returns **only the definition**.
- `require('./i18n')` at `src/server.js:37` resolves Node-style to **`src/i18n.js` (the file)**, not to `src/i18n/i18n.js` (the nested file in the directory) — there is no `src/i18n/index.js` to redirect.
- Conclusion: `src/i18n/i18n.js` is **never required, never loaded**. The JSON files are not even read into memory at runtime. The audit's "loaded but never consumed" is generous — they're not loaded at all. Deleting both files plus `src/i18n/` will not break a single render path.
- The JSON files do contain real translation work — `patientDashboard.*` / `patientOrder.*` namespaces in AR (68 keys EN-missing), all drift from the EN side. None of those keys are referenced by any view (`grep "patientDashboard\|patientOrder" src/views src/routes` returns zero hits outside `locales/`).

**Recommendation: delete the dead system, do not migrate to it.** Justification:
1. The live system (flat-key inline JS) is the one views actually invoke; switching would force a 196-key key-rename across every consumer.
2. Nested-namespace JSON has the schema-drift problem the audit already caught (68 AR-only keys) — kill the schema mismatch by killing the schema.
3. JSON loading via `fs.readFileSync` at import time adds a fragile boot dependency for no benefit while we're inline.
4. Once the codebase grows past ~500 keys, swapping to `i18next` or similar is a single-day project; do that *then*, not now.

### 2C. Sub-issue C — Critical pages

| Page | Confirmed zero i18n? | Strings (rough) | Visual size | Notes |
|---|---|---:|---|---|
| `index.ejs` (homepage) | **Yes** — 0 calls, 388 lines, `<html lang="en">` hardcoded line 2, `<meta og:locale="en_US">` hardcoded line 17 | ~69 user-visible | Hero + nav + 4-card services + footer | Full rewrite needed; also touches schema.org JSON-LD `"availableLanguage": ["en", "ar"]` (already correct) but `og:locale:alternate` is right. |
| `coming_soon.ejs` | **Yes** — 0 calls, 400 lines | ~22 user-visible (heading, subtitle, 6 feature bullets, form labels ×6, buttons ×3, footer CTAs ×2) | Centered hero + interest-capture form | This is the destination for `order_flow.js:54` (default `/order/start` redirect), `static-pages.js:71` (direct `/coming-soon`), and 8 `patient.js` redirects when wizard is gated. Highest-impact AR gap after homepage. |
| `privacy.ejs` | **Yes** — 0 calls | ~28 body strings | Static legal copy | Translation = mostly text replacement. ~60 lines total. |
| `terms.ejs` | **Yes** — 0 calls | ~25 body strings | Static legal copy | ~56 lines. |
| `refund_policy.ejs` | **Yes** — 0 calls | ~29 body strings | Static legal copy | ~71 lines. Egyptian consumer-protection law expects AR. |
| `delivery_policy.ejs` | **Yes** — 0 calls | ~33 body strings | Static legal copy | ~89 lines. Refers to courier process + SLAs. |

**Translation work estimate:** the four legal pages are ~115 strings combined and roughly 1 day of native-speaker work + lawyer review. `coming_soon` is ~22 strings and an hour of translation. `index.ejs` is the largest of the set — 69 user-visible strings spanning hero, nav, services callouts, doctor section, blog teaser, testimonials, FAQ teaser, and footer — call it a half-day for translation + half-day for layout-flip QA.

### 2D. Sub-issue D — RTL support audit (added scope, flagged)

**This sub-issue is not scoped in the source audit's i18n section.** I'm including it because shipping 24 EN-only pages is one problem, and shipping the other 60 with broken RTL is a separate one — and the second is invisible until an Arabic user actually flips the toggle. Flagging as new scope so Ziad can decide whether to bundle it in Theme 10 or break it out as Theme 10b.

**Direction (`dir`) attribute threading:**
- ✅ Layouts wire it correctly: `layouts/public.ejs:39`, `portal.ejs:46`, `auth.ejs:15`, `partials/patient/head.ejs:49` all use `<%= pageDir %>` / `<%= __dir %>`.
- ✅ Helper: `src/utils/lang.js getDir()` is the single source of truth, called from `src/middleware.js:211`.
- ❌ **`index.ejs:2` hardcodes `<html lang="en">` with no `dir` attribute** — confirmed P0-UI-1 in the source audit. Bypasses every layout. Even if body copy were translated, `dir` wouldn't flip, screen readers would announce LTR English, and OG locale would lie.
- ❌ Other standalone-`<html>` views (each a candidate for the same bug class):
  - `error.ejs:2` — `<html lang="<%= typeof lang !== 'undefined' ? lang : 'en' %>" dir="<%= typeof dir !== 'undefined' ? dir : 'ltr' %>">` — defensive, OK.
  - `doctor_login_v2.ejs:10`, `doctor_signup.ejs:18`, `help_admin_guide.ejs:6`, `help_doctor_guide.ejs:6`, `video_call_room.ejs:9` — all thread `lang`/`dir` from locals; OK.
  - `index.ejs` is the only critical violator.

**CSS logical vs physical properties:**
- 50 physical `margin-left/right`, `padding-left/right` declarations across `public/css/`.
- 74 logical-property declarations (`margin-inline`, `padding-inline`, `inset-inline`, `border-inline`).
- 72 explicit `[dir=rtl]` selectors that override physical rules — RTL overrides exist but are scattered, not systematic.
- Net: most components RTL-flip correctly because of explicit overrides; a long tail of components quietly inherit LTR-only rules. Concrete examples seen during audit: `.p-crumbs svg.chev` (breadcrumb chevron) is mirrored via `scaleX(-1)` for `[dir=rtl]` (good); generic icon flip uses opt-in `.p-icon--flip` class (means each callsite must remember to apply it; easy to forget).

**Font stack for Arabic:**
- `--v2-font-arabic: "SF Arabic", "Noto Sans Arabic", "Helvetica Neue", sans-serif` — declared **only** in `public/css/portal-variables.css` (used by the patient/doctor portals).
- Homepage / marketing CSS (`public/css/variables.css`, `styles.css`) does not switch font stack on `[dir=rtl]`. AR text on the homepage will render in `Inter` / system fallback — acceptable but not pretty; numerals and ligatures will look off.
- Google Fonts link in `index.ejs:58` does load `Noto+Sans+Arabic:wght@400;600;700` — preloaded but never CSS-applied.

**Mirrored icons:**
- 4 `transform: scaleX(-1)` rules for chevrons / arrows in patient + doctor portal CSS.
- 1 `rotate(180deg)` (purpose unclear from grep alone).
- No global mirror policy. Inline SVGs in marketing pages have no mirror logic; arrows in service cards on `services.ejs`, the homepage hero CTA chevron, and footer back-to-top will not flip.

**Components likely to break visually in AR (informed estimates from the file scan, not interactive QA):**
1. Homepage nav (`index.ejs`) — no `dir`, language toggle is the broken-onclick bug already flagged in source audit (P0-VIEW item #8).
2. Marketing page chevrons (services, about, contact) — no mirror class.
3. Static-page legal lists (`<ul>` indents are physical `padding-left`).
4. Coming-soon form layout — input fields use class-based styles only; should flip OK, but the prefix-suffix icons inside select boxes are LTR-positioned.
5. Site-nav language pills on coming-soon footer / about / services — re-uses `partials/header.ejs` indirectly (need verify which marketing pages are layout-bound vs standalone).
6. Patient / doctor portals: looked clean on grep — most use logical properties or explicit `[dir=rtl]` overrides — so the visual breakage is concentrated on the marketing surface, which is exactly the surface that has zero i18n.

---

## 3. Root Cause

Three intertwined causes, in declining order of severity:

1. **No CI gate, no convention enforcement.** Nothing fails the build when a new view ships with hardcoded English. Three different translation patterns coexist (`t('key')`, `tt('key', en, ar)`, local `function L(en, ar)` / `_t(en, ar)` ternaries) — P2-UI-15 in the source audit. The path of least resistance for a developer adding a page is to write English and ship; nobody notices until a customer flips the toggle.
2. **Two i18n systems, neither obviously canonical.** A new contributor opening the repo sees `src/locales/en.json` and reasonably assumes that's where translations live — and edits a dead file. The AR-only 68 keys are evidence this has already happened.
3. **Marketing pages were authored as EN-only static HTML before i18n was retrofitted into the portal.** The portal got the t/tt helpers; `index.ejs`, `coming_soon`, blog, legal, services were never retrofitted. They predate the convention.

---

## 4. Fix Plan

### 4.A — Phased rollout for view translation (84 views, 24 effectively-EN)

**Phase 0 — System consolidation (prerequisite, ~2h, no string changes):**
- Delete `src/i18n/i18n.js` and `src/locales/`. Update `.gitignore` if it references them.
- Pick one helper convention. Recommend `tt(key, enFallback, arFallback)` — already widely used, has fallbacks built in, doesn't require pre-populating dictionary keys for every string. Document in `CLAUDE.md` and `DESIGN_SYSTEM.md`.
- Gate the next phase on: `grep -r "getTranslator\|src/locales" src/` returns 0.

**Phase 1 — P0 critical pages (~1.5 days):**
- `index.ejs` — fix hardcoded `<html lang="en">` to `<html lang="<%= lang %>" dir="<%= dir %>">`, fix `og:locale` to switch on `lang`, translate ~69 strings via `tt(...)`. Also resolves source-audit P0-VIEW item #8 (broken `onclick` lang toggle) and P0-UI-1.
- `coming_soon.ejs` — translate ~22 strings + form labels.
- Four legal pages — translate ~115 strings combined. Lawyer review for AR copy required (see §8).
- `services.ejs` — translate ~498-line page; this is the homepage's primary outbound CTA.

**Phase 2 — P1 entry funnel (~1 day):**
- `about.ejs`, `contact.ejs`, `faq.ejs`, `error.ejs`, `404.ejs`, `public_case_thankyou.ejs`, `appointment_detail.ejs`.
- `login.ejs`, `order_confirmation.ejs`, `order_upload.ejs` — consolidate from inline-dict / borderline pattern to `tt(...)`.

**Phase 3 — P2 marketing tail (~1 day):**
- `app_landing.ejs`, `_app_waitlist_form.ejs`, `specialties_index.ejs`, `specialty_detail.ejs`, three blog pages.
- `forgot_password.ejs` cleanup (drop the duplicate auth.errors.* map per source-audit P3-VIEW-71).

**Phase 4 — P3 debt and consistency (~half day):**
- `messages.ejs`, `patient_records.ejs` — fix the `_isAr` JS-literal interpolation hazard (P3-VIEW-60).
- Borderline-density views: `patient_appointments_list, doctor_alerts, doctor_reviews, portal_doctor_cases, portal_doctor_guide` — re-audit and fill gaps.
- `sandbox_order_intake.ejs` — internal only; either translate or delete.

### 4.B — Sub-issue B migration path

1. **Snapshot:** `git mv src/locales src/locales.archived-2026-05` (so the 68-AR-only translation work isn't lost — it's *content* even if the system is dead). Keep around for a release.
2. **Delete:** `git rm src/i18n/i18n.js && rmdir src/i18n` (the directory becomes empty).
3. **Verify:** `grep -rn "getTranslator\|require.*i18n/i18n\|src/locales" src/` returns zero matches. Boot the app; render at least one portal page and one marketing page, EN and AR, and confirm no 500.
4. **Document:** add a CLAUDE.md note: "i18n strings live inline in `src/i18n.js` (flat-key) and inline `tt(key, en, ar)` calls in views. **Do not** add `locales/*.json` files."
5. **Future work** (out of scope for this theme): once string count exceeds ~500, consider migrating to `i18next` with backend JSON. Estimate: 1 day for the swap, ~half day to backfill.

### 4.C — Sub-issues C & D

- **C** (critical pages): rolled into Phase 1 above.
- **D** (RTL): two parts.
  - **Part D1 — `index.ejs` `<html>` fix:** must ride with the homepage translation (Phase 1) since it's a one-line code change but blocks all RTL on the homepage.
  - **Part D2 — Marketing-page RTL pass:** after Phase 1–3 translations land, do an RTL visual pass on every marketing surface. Add `[dir=rtl]` overrides where needed; switch known offenders to logical properties. Estimate: ~half day. Out of scope to bundle into Phase 1 because translating EN-only content is a precondition for spotting RTL bugs.
- Decision needed (§8): treat D as Theme 10 inclusion or split as Theme 10b.

---

## 5. Verification Steps

For each translated view, prove the round-trip end-to-end:

1. **Render pass — EN:** `curl -s 'http://localhost:3000/<route>?lang=en' | grep -E '<html|og:locale'` → confirms `lang="en"`, `og:locale="en_US"`, no `dir="rtl"`.
2. **Render pass — AR:** same URL with `?lang=ar` → confirms `lang="ar"`, `dir="rtl"`, `og:locale="ar_EG"`. Visually scan the response body for any English string.
3. **Toggle persistence:** start at `/?lang=ar`, click any nav link, confirm the cookie `lang=ar` rides through and the next page is also AR. (Already wired in `middleware.js:206-208`.)
4. **Toggle persistence across login:** log in as a patient with `lang=ar` cookie; confirm `/portal` lands in AR (already covered for portal views; will need verification for marketing flows that bridge to portal).
5. **No missing-key warnings:** boot the app with `DEBUG=t,tt`, hit each translated page, grep the log for warnings. (`src/server.js:274` falls back silently to `key` — consider promoting to a `console.warn` for the duration of this rollout.)
6. **RTL visual check:** open Chrome DevTools, set viewport to 375 (mobile) and 1280 (desktop), enable `Emulate locale: ar-EG`, hit `/?lang=ar`, screenshot the homepage and scroll through. Check: text right-aligned, chevrons mirrored, sidebar / nav order flipped, form labels above inputs in correct read order. Compare against EN screenshot.
7. **Layout-bound vs standalone-`<html>`:** for any view in the marketing set, confirm it actually goes through a layout (and therefore inherits `pageDir`) versus declaring its own `<html>` tag. Currently 7 views declare their own `<html>` — they all need the `dir` attribute audited.
8. **Smoke-test the dual-system kill:** after Phase 0, `grep -rn "src/locales\|getTranslator" src/` must be empty, and the app must boot + render `/login` and `/portal/dashboard` clean.

---

## 6. What to Add to the Test Suite

Worth automating, in priority order:

1. **CI lint: hardcoded-English detector** *(highest value)*. A custom Node script that walks `src/views/**/*.ejs`, strips `<%...%>` blocks and HTML attribute names, and counts ASCII-letter strings of length ≥ 4 inside text nodes. If a view has > N (say 3) such strings AND zero matches for `tt\(|<%=\s*t\(|isAr|lang\s*===?\s*['\"]ar`, fail the build. Whitelist file for known exceptions (`sandbox_*`, `_app_waitlist_form` if intentional). Implementation cost: ~3h. Catches the entire root cause class (cause #1 above).
2. **Locale-key parity check** *(only if we keep flat dicts)*. CI script that diffs `Object.keys(en)` vs `Object.keys(ar)` in `src/i18n.js` and fails on mismatch. ~30 min.
3. **`<html>` attribute lint.** Grep for `<html lang=` in `src/views/**/*.ejs` and fail if the value is a literal string (not `<%= ... %>`). Catches the `index.ejs` class of bug. ~15 min.
4. **AR snapshot test for the homepage and 4 legal pages.** Render with `?lang=ar`, snapshot to `tests/snapshots/ar/`, fail PR diff if changes aren't acknowledged. Useful but lower ROI than the lint — snapshots churn under any visual change. Consider only after Phase 1 lands.
5. **Skip:** a full Playwright RTL visual-regression suite. Too expensive to maintain for a pre-launch product; revisit post-launch.

---

## 7. Rollback Plan

i18n changes are low-risk because nothing in the schema, payments, auth, or migrations touches them. Rollback strategies, by phase:

- **Phase 0 (system consolidation):** if deletion breaks something we missed, `git revert <sha>` — single commit, restores `src/i18n/i18n.js` and `src/locales/`. Verify `npm start` boots clean.
- **Phases 1–4 (per-view translations):** each view is a small atomic commit. Worst case: a translated string contains a stray apostrophe that breaks an EJS render — symptom is a 500 on that one route. Fix or `git revert <sha>` the offending commit. No database, no redeploy gymnastics.
- **`<html lang>` change in `index.ejs`:** revert is a one-line edit if any third-party (analytics, ad pixel) depends on `lang="en"` literally. Low likelihood.
- **CI lint introduction:** if it false-positives on an emergency hotfix, allowlist via `// i18n-lint: ignore` comment; revisit later.

---

## 8. Open Questions for Ziad

1. **Translation source.** Who writes the AR copy for the new translations? Three options:
   - (a) Native speaker writes from scratch for each view — best quality, ~2 days human time across the 24 views.
   - (b) Machine translation (Claude / DeepL) drafted, then a native speaker edits — fastest, ~1 day total (4h MT + 4h review).
   - (c) Ziad does it himself — costs your time, gold-standard tone consistency. The `src/i18n.js` AR keys read like (c) so far.
   For legal pages specifically, **a lawyer/compliance review of the AR text is non-negotiable** — Egyptian consumer protection regs (Law No. 181/2018) require the contract language to be unambiguous in Arabic.
2. **Phased shipping vs hold-the-launch.** Two postures:
   - "Ship EN-only pages with a banner: 'النسخة العربية قريبًا'" — soft-launch, accepts the 24 EN pages publicly.
   - "Hold the launch until 100% bilingual" — adds ~3–4 days to the critical path. Given the audit's other 64 P0s, this is probably not the binding constraint, but worth a call.
3. **RTL audit (sub-issue D).** Bundle into Theme 10 (adds ~half day) or split as Theme 10b? Splitting is cleaner because (a) you can't audit RTL until the page has any AR text, and (b) RTL bugs are visual-only — you can ship with them and fix after launch.
4. **Helper convention.** Confirm the recommendation to standardize on `tt(key, enFallback, arFallback)` and deprecate the local `L(en, ar)` / `_t(en, ar)` patterns. The audit (P2-UI-15) flags this as debt; we should either fix it now during the bulk-translation pass or commit to fixing it never.
5. **`src/locales/` archive vs delete.** The 68 AR-only keys in `ar.json` represent real translation work. Recommendation is to `git mv` to `src/locales.archived-2026-05` and keep for one release as a translation source. OK to retain one release, or delete now and trust git history?
6. **Out-of-scope adjacency.** The source audit lists the homepage `onclick="switchLang(...)"` CSP bug as P0-VIEW item #8. That fix is one-line (event listener instead of inline handler) but is technically a different theme. Should the homepage i18n PR also fix the toggle, since you'd be editing `index.ejs` anyway? Recommendation: **yes** — atomic commit makes sense, and the lang toggle being broken is the reason no AR users have been clicking through to discover the EN-only homepage.

---

## Appendix — Verification commands used

```
# View enumeration
ls src/views/*.ejs | grep -vE "^src/views/(admin|ops-|superadmin)" | grep -v "\.bak$"

# i18n call counting per view (ran via shell loop)
grep -cE "(<%[=-]?\s*t\(|<%[=-]?\s*tt\(|<%[=-]?\s*L\(|<%[=-]?\s*_t\(|<%[=-]?\s*__\(|<%[=-]?[^%]*\bisAr\b|<%[=-]?[^%]*\b_isAr\b|<%[=-]?[^%]*lang\s*===?\s*['\"]ar)" "$f"

# Dual-system status
grep -rn "require.*i18n" src/ server.js
grep -rn "getTranslator\|src/locales" src/

# Locale parity
wc -l src/locales/ar.json src/locales/en.json

# RTL CSS audit (counts via xargs)
find public -name "*.css" | xargs grep -hcE "margin-left|margin-right|padding-left|padding-right"
find public -name "*.css" | xargs grep -hcE "margin-inline|padding-inline|inset-inline|border-inline"
find public -name "*.css" | xargs grep -hcE "\[dir="

# Standalone <html> declarations
grep -rln "<html lang" src/views --include="*.ejs"

# Coming-soon / index call sites
grep -rn "/coming-soon\|render.*'coming_soon'" src/routes
```
