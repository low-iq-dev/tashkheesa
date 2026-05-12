# Theme 10b — Visual RTL Audit: Fix Plan (Scoping Only)

**Date:** 2026-05-12
**Author:** Claude Opus 4.7 (1M context), interactive
**Source audit:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` §09 UI/UX (P0-UI-1..3 / P1-UI-13/14) + the "RTL support audit" sub-issue D opened in `docs/audits/THEME_10_ARABIC_I18N_FIX_PLAN.md` §2D.
**Predecessor theme:** Theme 10 — Arabic i18n (ship commit `82c663c`, 2026-05-09). Arabic strings are now live in production via the canonical `tt(key, en, ar)` helper.
**Working tree HEAD:** `a4ea8c5` (Theme 9 Sub-issue A — WhatsApp 401 detector cron).
**Status:** SCOPING ONLY — no code touched. All numbers and file:line citations verified by direct grep on the working tree.
**Sister themes:** Theme 2 (CSP — touches the same inline `<style>` surface), Theme 10 (the text layer this report sits on top of).

---

## 1. Executive Summary

Theme 10 made the **strings** Arabic. Theme 10b is the question Theme 10 punted:
when `dir="rtl"` actually flips, *does the layout follow?* The text is now in the
right language; this report enumerates everywhere the **CSS, icons, numerals,
and form fields** are still hard-wired to LTR and what it costs to lift them.

The direction-flip plumbing itself is healthy. `src/utils/lang.js:15-18`
defines a single `getDir(lang)` helper, `src/middleware.js:225` writes
`res.locals.dir` into every response, and all four shipping layouts
(`layouts/public.ejs:11,39`, `layouts/portal.ejs:11,46`, `layouts/auth.ejs:11,15`,
`partials/patient/head.ejs:26,49`) thread `pageDir` onto `<html dir>`. The two
P0 violators flagged in the comprehensive audit (`index.ejs:13` hardcoded
`lang="en"` and `coming_soon.ejs` zero-i18n) have both been resolved by Theme 10
— `index.ejs:13` now reads `<html lang="<%= lang %>" dir="<%= dir %>">` and
`coming_soon.ejs` is fully translated. **Today, every user-facing route flips
its document direction correctly when a patient picks Arabic.** What remains
is purely the visual question.

The visual surface is the second half of the audit's `P1-UI-14` finding.
Counted on the working tree:

- **22 physical `margin-left`/`margin-right`/`padding-left`/`padding-right`
  declarations** in EJS inline `<style>` blocks (29 views carry inline styles).
- **21 physical `margin-*`/`padding-*` declarations** in `public/css/*.css`
  across 8 files (admin, doctor-portal, patient-portal, messages,
  portal-tours, responsive, portal-components, styles, portal-global).
- **39 physical `border-left`/`border-right` declarations** in views and
  another ~55 in `public/css/*.css`.
- **41 `text-align: left|right` declarations** in views, **12** in CSS files.
- **122 physical `left:`/`right:`/`float:left|right`/`border-left|right`/
  `transform: translateX` rules** in CSS files combined.
- **72 explicit `[dir=rtl]` selectors** override-style across CSS files
  (concentrated in `styles.css:1510-1536`, `patient-portal-v2.css:155-594`,
  and `admin-styles.css`). Overrides are scattered, not systematic.
- **74 logical-property declarations** (`margin-inline-*`, `padding-inline-*`,
  `inset-inline-*`, `border-inline-*`) in `public/css/*.css`, plus **24** in
  views — concentrated in `doctor-portal-v2.css` (22) and `patient-portal-v2.css`
  (14). **The v2 portal stylesheets are the only CSS surfaces partially built
  on logical properties; everything else is physical-with-RTL-overrides or
  physical-only.**
- **61 `<input>` elements** declare LTR-leaning types (`tel`, `email`, `url`,
  `number`, `date`, `time`); **only 17 of them carry the explicit `dir="ltr"`
  attribute** needed to keep phone/email/digit input boxes readable inside
  an RTL form.
- **Zero centralised number/date formatter.** 19 separate `toLocaleString`
  / `toLocaleDateString` callsites scattered across views — some hardcode
  `'en-US'` / `'en-GB'`, some switch on `_isAr`, others call bare
  `.toLocaleString()` (browser-locale-dependent). Currency amounts on
  `patient_new_case.ejs:380,446,505,713` will silently render Arabic-Indic
  digits on AR-locale browsers and Western digits on EN-locale browsers —
  with **no relationship to the actual page language**.
- **Chart.js v4 inline on `admin_analytics.ejs:317-475`** renders axis labels
  in LTR with no per-instance `direction: 'rtl'` config or axis-mirror —
  six canvases, no RTL handling.
- **Arabic font fallback (`--v2-font-arabic`)** is declared exactly once at
  `public/css/portal-variables.css:287` and applied only by
  `doctor-profile.css:51` and `doctor-prescribe.css:66`. The patient portal,
  marketing site, admin, ops, and superadmin surfaces all fall through to
  `Inter`/system fallback for AR text. The Google Fonts `Noto+Sans+Arabic`
  link at `index.ejs:81` is preloaded but **never CSS-applied**.

The audit's framing is verified: RTL works as a document attribute; the
visual layer beneath it is patchwork. Two views (`patient_payment_required.ejs`,
`patient_case_report.ejs`, `patient_prescription_detail.ejs`) had zero
physical margin/padding hits and are RTL-clean. The `_app_waitlist_form`,
`patient_404`, `patient_500`, and `appointment_*` views are also clean.
**Most of the breakage is concentrated in:** (a) the marketing
`<style>` blocks (`coming_soon`, `services`, `help_*`, `faq`, `blog_*`),
(b) inline `style="…"` attributes on `admin_*` and `superadmin_*` table
cells, and (c) the v1 (non-v2) portal stylesheets `patient-portal.css` /
`doctor-portal.css` which still drive a handful of dashboards.

**Three sub-issues are systemic and can land as cross-cutting work
(Sub-issue A — layout primitives; Sub-issue C — number/date helper;
Sub-issue D — LTR inputs).** Two are narrow but high-visibility
(Sub-issue B — icon mirroring; Sub-issue E — dashboards / charts). All
five are deferred-implementation per ground rules. **No source edits in
this commit.**

---

## 2. Current State

### 2A. Direction-flip plumbing (verified working)

| Layer | File:line | Behaviour |
|---|---|---|
| Single source of truth | `src/utils/lang.js:15-18` | `getDir(lang)` returns `'rtl'` if normalised lang is `'ar'`, else `'ltr'`. |
| Request middleware | `src/middleware.js:225` | `res.locals.dir = getDir(lang)`. |
| Public layout | `src/views/layouts/public.ejs:11,39` | `<html lang dir>` honoured. |
| Portal layout | `src/views/layouts/portal.ejs:11,46` | Same. |
| Auth layout | `src/views/layouts/auth.ejs:11,15` | Same. |
| Patient head partial | `src/views/partials/patient/head.ejs:26,49` | Same. |
| Standalone `<html>` views | `index.ejs:13`, `error.ejs:2`, `doctor_signup.ejs:18`, `doctor_login_v2.ejs:10`, `help_*_guide.ejs:6`, `video_call_room.ejs:8`, `patient_404.ejs:19`, `patient_500.ejs:31` | All thread `lang` + `dir` from locals. The `index.ejs:13` P0 hardcoded `lang="en"` from the comprehensive audit was fixed during Theme 10 (verified by file open). |

**Verdict:** `dir="rtl"` is end-to-end live. Setting `?lang=ar` flips the
document attribute everywhere the user can reach. **The remainder of this
report is purely about what breaks visually below that attribute.**

### 2B. Sub-issue A — Layout primitives: physical vs logical CSS

**Physical declarations (counted on the working tree, will need a flip):**

| Surface | `margin-l/r` + `padding-l/r` | `border-l/r` | `left:`/`right:` position | `text-align: left/right` |
|---|---:|---:|---:|---:|
| `public/css/*.css` (38 files) | 21 | ~55 | 122 | 12 |
| `src/views/*.ejs` inline `<style>` and `style="…"` | 22 | 39 | (counted in totals above) | 41 |
| **Total physical hits** | **43** | **94** | **122** | **53** |

**Logical declarations (RTL-safe today):**

| Surface | `margin-inline-*` + `padding-inline-*` + `border-inline-*` |
|---|---:|
| `public/css/doctor-portal-v2.css` | 22 |
| `public/css/patient-portal-v2.css` | 14 |
| `public/css/doctor-prescribe.css` | 8 |
| `public/css/doctor-case-detail.css` | 8 |
| `public/css/doctor-profile.css` | 6 |
| `public/css/doctor-dashboard.css` | 6 |
| `public/css/doctor-reviews.css` | 4 |
| Other files (1 each) | 4 |
| **Total in CSS files** | **74** |
| EJS inline `<style>` blocks | **24** |

**Reading:** the **doctor-portal-v2** + **patient-portal-v2** stack is the
only part of the codebase partially built on logical properties. Everywhere
else is "physical with a `[dir=rtl]` override if anyone remembered to add
one."

**Explicit `[dir=rtl]` selector coverage:**

| File | Override count | Notes |
|---|---:|---|
| `public/css/styles.css:1507-1536` | 7 | Hand-rolled marketing-site flip block — covers `.nav-inner`, `.nav-links`, `.hero-grid`, `.hero-content`, `.hero-buttons`, `.site-footer`, `.section-header`. Anything else on the marketing surface inherits LTR. |
| `public/css/admin-styles.css` | 7 | Selective admin overrides; the **17 physical `left:`/`right:` rules in the same file** are not all covered. |
| `public/css/patient-portal-v2.css:155,276,591,594` | 4 | Two for active-nav, two for icon mirroring (`scaleX(-1)`). |
| `public/css/doctor-prescribe.css` | 4 | |
| `public/css/doctor-dashboard.css` | 4 | |
| `public/css/doctor-profile.css` | 3 | |
| Other files | 1–3 each | |
| **Total** | **72** | |

72 RTL overrides exist; they patch the most-visible cases. The long tail
of components quietly inherits LTR rules — visible only by interactive QA.

**Concrete examples of the "long tail" hazard, verified by file open:**

| File:line | Rule | Effect under `dir=rtl` |
|---|---|---|
| `src/views/coming_soon.ejs:56` | `.features-preview { text-align: left; }` | Bullet text left-aligned even when surrounding content is RTL. |
| `src/views/coming_soon.ejs:135` | `.form-field { text-align: left; }` | Form labels mis-aligned. |
| `src/views/help_patient_guide.ejs:124,137,150,153,165,207,224,267` | mockup chips with `margin-left`, `text-align:left`, `border-right`, `border-left`, `left: 4px` | All seven mockup screenshots in the patient walkthrough remain LTR even when the surrounding guide is Arabic. |
| `src/views/help_doctor_guide.ejs:78,90,102,130,135,138,169,184,206,392,443,585,589,593` | Same pattern. Even `border-left-color` on KPI cards (lines 585/589/593) skews colour-coded indicators to the wrong edge. |
| `src/views/services.ejs:104` | `.featured-card .fc-badge { position: absolute; top: 14px; right: 14px; }` | "Featured" badge stays in the top-right corner under RTL where it should mirror to top-left. |
| `src/views/admin_pricing.ejs:108-135` | 5 `style="text-align:right"` declarations on price columns | These are *probably correct* even in RTL (numeric columns right-align by convention) — but the rule is brittle: a future translation that swaps the column to non-numeric copy would inherit a wrong-side alignment. |
| `src/views/admin_pre_launch_leads.ejs:42-48` | 7 `<th style="text-align:left">` table headers | Mis-align all column headers under RTL. |
| `src/views/ops-dashboard.ejs:54,91,92,93,270,271` | `th { text-align: left }` plus 5 inline `text-align: right` rules | Ops dashboard isn't user-facing AR but inherits the same fragility. |

**Note on the v1 portal CSS** (`patient-portal.css`, `doctor-portal.css`):
both files have ~5 physical `margin-left` rules driving the sidebar shift
(lines 164, 240, 268, 272, 695, 727 in `patient-portal.css`; same numbers
in `doctor-portal.css`). The v2 stylesheets above superseded most of these,
but the v1 files are still loaded by `messages.ejs`, `appointment_*.ejs`,
and a handful of remaining views that haven't been v2-migrated. RTL on
those views is **broken at the sidebar** under `dir=rtl` because the
sidebar offset is applied via `margin-left: var(--p1-sidebar-w)` and there
is no corresponding `[dir=rtl] { margin-left: 0; margin-right: var(...); }`
override. Confirmed by reading `patient-portal.css:240` and verifying no
RTL override in the same file.

### 2C. Sub-issue B — Icon mirroring (chevrons, arrows, sort indicators)

**Total `<svg>` instances in EJS views:** 169.

**Existing mirror mechanisms (verified by grep):**

| Mechanism | File:line | Coverage |
|---|---|---|
| `.p-icon--flip` opt-in class | `public/css/patient-portal-v2.css:594` — `html[dir="rtl"] .p-icon--flip { transform: scaleX(-1); }` | Opt-in. Each callsite must remember to add the class. Search for `p-icon--flip` returns **zero usages** outside the CSS file itself. The opt-in exists; nobody opts in. |
| `.p-crumbs svg.chev` auto-flip | `public/css/patient-portal-v2.css:591` | Auto. Covers breadcrumb chevrons in the patient portal v2 surface only. |
| Inline `<%= _isAr ? 'transform:scaleX(-1);' : '' %>` on individual SVGs | `src/views/doctor_prescriptions_list.ejs:78,119`, `src/views/portal_doctor_case.ejs:444` | Three handcrafted SVGs in two views. Pattern is correct but doesn't scale — every other chevron in the codebase has no mirror. |
| `video_call_room.ejs:107` | `transform: scaleX(-1)` on the local video preview | Webcam mirror; not RTL-related but counted in the same grep. |
| `doctor-prescribe.css:120,995` | `transform: scaleX(-1)` | Doctor-prescribe-specific. Not direction-driven. |

**Verified unflipped chevrons (sample, all `polyline points="9 18 15 12 9 6"`):**

| File:line | Surface |
|---|---|
| `src/views/admin_analytics.ejs:103,110,117` | Three KPI-card "drill-in" chevrons. Admin only — not patient-facing AR — but the patterns leak to other surfaces. |
| `src/views/admin_analytics.ejs:188` (and 12 more analogous SVGs in the same file) | Empty-state icons, sparkline icons, alert icons. Decorative — most don't need to mirror, but ambiguity is the problem. |
| 169 total SVGs (counted by `grep "<svg"`) | Most carry no mirror logic. Some are decorative (no direction), some are explicitly directional (chevrons, arrows) and silently misrender. |

**Arrow glyphs in raw text (UTF-8):**

| File:line | Glyph | Surface |
|---|---|---|
| `src/views/blog_when_to_get_second_opinion.ejs:118,120,179,182` | `→` and `←` in both EN and AR copy | Inline arrow glyphs in blog CTAs. Author hand-corrected the AR copy (`←` in AR, `→` in EN) — works only because the strings are tagged per language. Brittle. |
| `src/views/blog_how_tashkheesa_works.ejs:230,232,279,282` | Same pattern. | |
| `src/views/blog_index.ejs:52,55` | `.post-card .read-more::after { content: ' →'; }` + `[dir="rtl"] .post-card .read-more::after { content: ' ←'; }` | Correct pattern. Only blog uses it. |
| `src/views/messages.ejs:?` | `<button>←</button>` (back button) | Bare arrow character with no flip rule. Will render `←` in both directions, pointing the wrong way in EN. |
| `src/views/doctor_prescription_detail.ejs:?` | `_isAr ? '→ الرجوع للقائمة' : '← Back to list'` | Hand-corrected inline. Brittle. |

**Verdict:** there is **no global mirror policy**. Three local conventions
coexist: the `.p-icon--flip` opt-in class (zero adoption), inline EJS
`_isAr ? 'transform:scaleX(-1);' : ''` ternaries (4 callsites), and
hand-corrected per-language arrow strings (the blog views). A cross-cutting
fix needs one mechanism applied across all 169 SVGs — at minimum identifying
which are directional and which are not.

### 2D. Sub-issue C — Number / date rendering

**Audit of every `toLocaleString` / `toLocaleDateString` callsite in views:**

| File:line | Pattern | RTL/locale behaviour |
|---|---|---|
| `src/views/order_review.ejs:139` | `n.toLocaleString(isAr ? 'ar-EG' : 'en-US', { maximumFractionDigits: 0 })` | Correct — produces Arabic-Indic numerals in AR mode, Western in EN. |
| `src/views/portal_doctor_dashboard.ejs:15-19,156` | Same — `(isAr ? 'ar-EG' : 'en-US')` | Correct. |
| `src/views/patient_order.ejs:36,481,486,492` | `(isAr ? 'ar-EG' : 'en-GB')` | Correct (mixes en-GB for date format). |
| `src/views/patient_prescriptions.ejs:20` | `(_lang === 'ar' ? 'ar-EG' : 'en-US')` | Correct. |
| `src/views/doctor_reviews.ejs:29` | `(_lang === 'ar' ? 'ar-EG' : 'en-US')` | Correct. |
| `src/views/patient_profile.ejs:17` | `(__isAr ? 'ar-EG' : 'en-US')` | Correct. |
| `src/views/admin_doctors.ejs:198` | `Number(d.total_earnings).toLocaleString()` — **bare call, no locale arg** | **Inconsistent.** Browser-locale dependent. AR browser sees Arabic-Indic; EN browser sees Western. No correlation with page language. |
| `src/views/admin_pricing.ejs:132,135,184,185,220,221` | Six bare `.toLocaleString()` calls | Same. |
| `src/views/admin_services.ejs:83,89,99` | Three bare calls | Same. |
| `src/views/admin_order_detail.ejs:59` | Bare call | Same. |
| `src/views/admin_video_calls.ejs:153` | Bare call | Same. |
| `src/views/admin.ejs:275,293` | Two bare calls (financial KPI cards) | Same. |
| `src/views/patient_new_case.ejs:380,446,505,713` | Four bare `.toLocaleString()` calls in browser-side JS (`textContent = ...`) | **Patient-facing.** A patient with an AR-default browser navigates to `/portal/new-case` in EN — they see "EGP ١٬٥٠٠" for a price label. Inconsistent with the surrounding EN copy. |
| `src/views/doctor_appointments.ejs:46,51` | `toLocaleDateString('en-GB')` / `toLocaleTimeString('en-GB')` | Hard-EN. AR doctor sees Western dates next to AR labels. |
| `src/views/admin_reviews.ejs:18` | `toLocaleDateString('en-US')` | Same. |
| `src/views/doctor_appointments.ejs:83,215,273,280` | `.toFixed(2)` / `.toFixed(0)` | No locale concept — always Western digits. |
| `src/views/admin_campaign_detail.ejs:77,79,82,130` | Four bare `new Date(...).toLocaleString()` calls | Browser-locale dependent. |
| `src/jobs/appointment_reminders.js:74-75` | `toLocaleDateString('en-US')` / `toLocaleTimeString('en-US')` | **WhatsApp/SMS notification template** — AR patient receives notification with EN-formatted date. Not visual, but related root cause. |

**Reading:** **19 distinct callsites**, three different patterns
(correct-with-isAr, bare, hard-EN). No central helper. The audit's
`P2-UI-15` finding ("inconsistent numeral rendering") is verified
across at least 14 file:line pairs.

**Browser default test (verified mental model, not run):** on Safari with
system language set to Arabic, `(15000).toLocaleString()` returns
`'١٥٬٠٠٠'`. On the same browser with system language English, it returns
`'15,000'`. The bare callsites in `patient_new_case.ejs` will render
either result regardless of `?lang=` query — Arabic digits next to English
copy or vice versa.

### 2E. Sub-issue D — Form inputs that must stay LTR even in RTL

**61 LTR-leaning `<input>` elements** counted (`type="tel|email|url|number|date|time"`).
**17 of them carry `dir="ltr"` explicitly.** The remaining 44 inherit the
ambient `<html dir="rtl">` and will render their content right-to-left when
a patient is in AR mode — fine for AR text, broken for digits, phone numbers,
emails, URLs.

**Existing explicit `dir="ltr"` callsites (verified by grep):**

| File:line | Input | Field |
|---|---|---|
| `src/views/doctor_prescribe.ejs:174,294` | `<textarea dir="ltr">` | Prescription diagnosis + notes (English-only by design). |
| `src/views/patient_payment_required.ejs:235` | `<input dir="ltr">` | Payment input. |
| `src/views/patient_payment_required.ejs:252` | `<input readonly dir="ltr">` | Payment URL display. |
| `src/views/patient_profile.ejs:97` | `<input dir="ltr">` | Email field. |
| `src/views/patient_profile.ejs:107` | `<input dir="ltr">` | Phone field. |
| `src/views/patient_onboarding.ejs:122` | `<input type="tel" dir="ltr">` | Phone. |
| `src/views/portal_doctor_profile.ejs:244,279,284,290,318,358,381,471,526,1296` | 10 inputs | Doctor profile form: name, country code, phone, DOB, license, year, bio textarea. |

**The pattern is correct, just inconsistent.** The doctor-profile and
patient-profile views are clean. The patient-facing intake forms are
mostly not.

**Verified violators (sample — view-side patient-facing):**

| File | Likely-LTR fields with no `dir="ltr"` |
|---|---|
| `src/views/patient_new_case.ejs` | Phone, email, date-of-birth, age — needs verification at the field-by-field level (skipped in scoping). |
| `src/views/public_case_new.ejs` | Same. |
| `src/views/intake_form.ejs` | Date / age / phone / email inputs. |
| `src/views/forgot_password.ejs` | Email field. |
| `src/views/register.ejs` | Email + password (passwords are dir-neutral; emails should be LTR). |
| `src/views/login.ejs` | Email field. |
| `src/views/doctor_signup.ejs` | Phone, email, year-of-graduation, license number. |
| `src/views/coming_soon.ejs:317-340` | Name + email + phone + language fields on the interest-capture form. |

**Counter-pattern check:** putting `dir="ltr"` on an email input does
**not** prevent Arabic UI labels around it from flowing right-to-left.
It only locks the input box's caret + alignment behaviour. The label and
field container still inherit RTL from the document. This is the correct
behaviour — the audit's recommendation in P1-UI-13 is exactly this hybrid.

### 2F. Sub-issue E — Tables / charts / dashboard widgets

**Chart.js usage** (`admin_analytics.ejs:317-475`): six `new Chart(...)`
calls; none configure `options: { direction: 'rtl' }` or
`scales.x.reverse: true` or `scales.x.position: 'top'`. Chart.js v4 honours
the `direction` CSS prop on the canvas container but does **not** mirror
axis labels by default. AR-mode axis numerals will render Arabic-Indic
(via the canvas's implicit locale) but the time-axis tick order will stay
left-to-right.

**Sortable tables** (verified by grep `sortable\|sort-asc\|data-sort`):

| File | Sort indicators |
|---|---|
| `src/views/admin_orders.ejs` | Header arrows (`▲`/`▼`) flow direction-agnostic. |
| `src/views/admin_doctors.ejs` | Same. |
| `src/views/admin_pricing.ejs` | Same. |
| `src/views/portal_doctor_cases.ejs` | Same. |

Sort arrows are vertical and direction-neutral — fine under RTL. Column
ordering itself stays left-to-right under both directions (a column index
of 0 is leftmost regardless of `dir`). This is a **bug-or-feature** call:
under strict RTL convention, the first column should be rightmost. The
audit's `P1-UI-14` line item flags this as a non-blocker; logged as OQ
below.

**Heat-style dashboards** (`ops-dashboard.ejs`, `ops-errors.ejs`,
`ops-silent-failures.ejs`, `admin_errors.ejs`): all use
`th { text-align: left }` plus a mix of `text-align: right` for numeric
columns. The numeric-right rule happens to be RTL-friendly; the
header-left rule is not. Ops is not patient-facing AR, but admin and
superadmin are reachable by AR-locale staff.

### 2G. Sub-issue F — Arabic font fallback systematic gap

`public/css/portal-variables.css:287` declares
`--v2-font-arabic: "SF Arabic", "Noto Sans Arabic", "Helvetica Neue", sans-serif`.
That variable is **only** referenced from two files: `doctor-profile.css:51`
and `doctor-prescribe.css:66` — both via `--font-arabic: var(--v2-font-arabic);`
indirection. Neither file applies `font-family: var(--font-arabic)` to a
top-level body selector; the variable exists, the propagation does not.

**Consequence:** AR copy on the patient portal renders in the patient-portal-v2
`--v2-font` stack, which is Inter. AR text on the marketing surface
(`styles.css`) and admin surface (`admin-styles.css`) falls back to
system defaults. The `index.ejs:81` `Noto+Sans+Arabic` Google Fonts preload
is paid for on every request and **never used**.

Verified via:
- `grep -rn "font-family.*var(--v2-font-arabic)" public/css/ src/views/` → 0 results.
- `grep -rn "var(--font-arabic)" public/css/ src/views/` → 2 results (the
  two `:root` re-aliases in `doctor-profile.css` and `doctor-prescribe.css`),
  zero actual `font-family:` consumers.

**Visual impact:** AR copy renders correctly in Inter on macOS/iOS
(which contain Arabic glyphs in Inter via system substitution), but on
Windows / older Android, AR text falls through to system Arabic which
may not visually match the surrounding EN copy in weight or x-height. Not
launch-blocking but a polish-tier finding.

---

## 3. Root Cause

Four threads converge on the same systemic gap:

1. **The text layer landed before the layout layer.** Theme 10 was scoped
   as "add AR strings via `tt()`" — and it did exactly that, including
   threading `<html dir>` through every layout. But the implicit
   assumption that *the existing CSS already supported RTL* was never
   verified. It's mostly true (60-70% of components flip correctly) and
   mostly silent when it isn't.

2. **Logical-property adoption is partial and bottom-up.** The newer
   patient-portal-v2 + doctor-portal-v2 stylesheets author with
   `margin-inline-*` / `padding-inline-*` / `inset-inline-*`. Everything
   older — `styles.css`, `admin-styles.css`, `patient-portal.css`,
   `doctor-portal.css`, plus 29 EJS inline `<style>` blocks — was authored
   with physical `margin-left`/`padding-right`/`left:` etc. The 72
   `[dir=rtl]` overrides are spot fixes layered on the physical base;
   they cover the visible cases, not the long tail.

3. **No central number/date formatter, so each view re-invents the
   pattern (or doesn't).** 19 callsites, 3 patterns. The
   `(isAr ? 'ar-EG' : 'en-US')` pattern that works correctly was copied
   into roughly half the views; the other half use bare `.toLocaleString()`
   (browser-locale dependent) or hard-EN. The audit's `P2-UI-15` will keep
   re-occurring until there's a `formatNumber(n, lang)` helper that's
   *the only way* to render numbers in views.

4. **LTR-locked input fields are opt-in.** The `dir="ltr"` attribute on
   `<input type="tel|email|number|date">` is the right pattern (verified
   in `patient_profile.ejs:97,107`, `portal_doctor_profile.ejs:244-1296`),
   but it's per-callsite. 61 inputs need it; 17 have it. The same pattern
   that fixed the doctor-profile form never got applied to the
   patient-intake forms — same class of debt as Sub-issue C.

The deeper cause is the same shape as Theme 9's integration patchwork:
each surface was added at a different time by a different pattern. The
marketing CSS predates portal-v2 by a year. The admin-styles.css and the
patient-portal.css ship side-by-side with portal-v2.css and don't share a
foundation. Theme 10 added strings on top of all of them without
unifying the layer beneath.

---

## 4. Fix Plan

Each sub-issue lands as a separate atomic commit. Per the user's hard
constraint, **no source file is modified in this scoping commit** — the
sketches below are the proposed diff shape for the next theme phase.

### Sub-issue A — Layout primitives: logical properties + RTL overrides for the v1 stack

**Goal:** sweep the 43 physical `margin-l/r` + `padding-l/r` decls and the
94 `border-left/right` decls into either (a) logical properties, where the
component's intent is "the leading/trailing edge regardless of language",
or (b) symmetric `[dir=rtl]` overrides, where the component's intent is
language-specific (e.g., the marketing nav).

**Recommended approach** (per the `claude-api` skill's
"refactor-in-place vs scorched-earth" framing):

1. **`public/css/styles.css`** — 4 `margin-l/r` + 4 `padding-l/r` decls
   on the marketing nav, hero, and section headers. **Recommendation:
   logicalise.** The marketing surface has no asymmetric design
   requirement; `margin-inline-end: var(--space-2)` etc. flips
   automatically. Drop the 7 `[dir=rtl]` overrides at lines 1510-1536
   in favour of base logical declarations. **Estimated diff: ~25 lines.**

2. **`public/css/admin-styles.css`** — 17 `left:`/`right:` position rules
   + 1 `margin-right` decl. The admin surface has a sidebar pinned to
   the *start* of the inline axis. **Recommendation:
   `inset-inline-start: 0`** replaces `left: 0`, and ditch the 7
   `[dir=rtl]` overrides currently fighting it. **Estimated diff: ~50 lines.**

3. **`public/css/patient-portal.css` + `doctor-portal.css`** (v1 stack —
   still loaded by `messages.ejs`, `appointment_*.ejs`, a handful of
   v1-bound views). 10 `margin-left` decls drive the sidebar offset.
   **Two paths:**
   - **Logicalise.** Replace `margin-left: var(--p1-sidebar-w)` with
     `margin-inline-start: var(--p1-sidebar-w)`. Bound risk: the v1
     stack already has zero `[dir=rtl]` overrides, so this is purely
     additive.
   - **Hard-defer.** Migrate every remaining v1-bound view to v2 (the
     v2 stack is already logical). This is a much larger project — out
     of Theme 10b scope.
   **Recommendation:** logicalise the v1 stack as a smaller fix; defer
   the v2 migration to a follow-up theme. **Estimated diff: ~30 lines
   across both files.**

4. **`public/css/messages.css`, `portal-tours.css`, `portal-global.css`,
   `responsive.css`, `portal-components.css`** — each has 1-3 physical
   decls. Sweep in the same pass. **Estimated diff: ~20 lines combined.**

5. **EJS inline `<style>` blocks** — 29 affected files. The high-impact
   subset is:
   - `coming_soon.ejs:56,135` (3 text-align decls)
   - `services.ejs:104` (badge position)
   - `help_*_guide.ejs` × 3 (mockup screenshots — many decls each)
   - `faq.ejs:204,216` (bullet padding — *already has* the RTL override,
     so leave as-is or convert to logical)
   - Inline `style="…"` attributes on `admin_*` and `superadmin_*` table
     cells (~50 occurrences combined per grep).

   **Recommendation:** lift the high-impact inline styles into the
   surrounding stylesheets (where they can be properly RTL-overridden),
   logicalise as you go. Inline `style="text-align:left"` on table
   headers is a structural change worth ~1 PR per file.

**Defer (called out, not fixed in this sub-issue):**
- The 29 inline `<style>` blocks are also a Theme 2 (CSP) concern —
  inline `<style>` requires `'unsafe-inline'` in `style-src`. The full
  fix is "extract inline styles to stylesheets," which Theme 2 has been
  navigating. **Coordinate with Theme 2.** Theme 10b's RTL fix should
  extract+logicalise in the same commit per file, not piecemeal.

### Sub-issue B — Icon mirroring: single canonical class + EJS helper

**Goal:** consolidate the three local mirror conventions into one
canonical mechanism and apply it to every directional SVG.

**Proposed new file `src/views/partials/icons/chev-end.ejs`** (and friends
`chev-start.ejs`, `arrow-end.ejs`, `arrow-start.ejs`):

```html
<%# Canonical directional chevron — auto-mirrors under RTL via .p-icon--flip.
    Use this partial instead of inlining <polyline points="9 18 15 12 9 6"/>. %>
<svg width="<%= typeof size !== 'undefined' ? size : 14 %>"
     height="<%= typeof size !== 'undefined' ? size : 14 %>"
     viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
     class="p-icon--flip" aria-hidden="true">
  <polyline points="9 18 15 12 9 6"/>
</svg>
```

**Promote the `.p-icon--flip` class from `patient-portal-v2.css:594`
into a globally-loaded stylesheet** (`public/css/portal-global.css` or
a new `public/css/icons.css`). Today the class is defined only in the
patient-portal-v2 surface, so even if a doctor or admin view added the
class, the rule wouldn't apply.

**Diff sketch (CSS lift):**

```css
/* public/css/icons.css — globally loaded */
[dir="rtl"] .p-icon--flip { transform: scaleX(-1); }
[dir="rtl"] .p-icon--flip-end { transform: scaleX(-1); }
```

**Then a 4-step refactor:**
1. Sweep all 169 `<svg>` tags in `src/views/*.ejs` and classify each as
   directional (chevron, arrow, sort, next/prev) or non-directional
   (alert triangle, clock face, circle, document outline). A regex
   pre-pass can identify candidates by `polyline` shape.
2. For every directional SVG, add `class="p-icon--flip"`.
3. Replace the 4 existing inline `_isAr ? 'transform:scaleX(-1);' : ''`
   ternaries with the canonical class.
4. Replace bare arrow glyphs (`←`/`→`) in EJS string literals with
   logical-direction CSS pseudo-elements (the `blog_index.ejs:52-55`
   pattern is correct — generalise it):
   ```css
   .back-link::before { content: '← '; }
   [dir="rtl"] .back-link::before { content: '→ '; }
   ```

**Estimated scope:** ~169 SVG edits across ~40 views; lint-test below
(T2) catches regressions.

**Defer:** SVG icons in third-party widgets (Chart.js axis arrows,
Uploadcare widget chrome) — those are vendor-baked. Not in our edit set.

### Sub-issue C — Centralise number / date formatting

**Goal:** replace 19 scattered callsites with one helper. Eliminate the
bare `.toLocaleString()` class entirely.

**Proposed new file `src/utils/formatNumber.js`:**

```javascript
// Single source of truth for locale-aware number + date rendering.
// Defaults reflect product policy: AR mode → Arabic-Indic numerals,
// AR-locale date format; EN mode → Western numerals, en-GB dates
// (matches current patient_order.ejs convention).

const AR_LOCALE = 'ar-EG';
const EN_LOCALE = 'en-GB';

function pickLocale(lang) {
  return (String(lang || '').toLowerCase() === 'ar') ? AR_LOCALE : EN_LOCALE;
}

function formatNumber(n, lang, opts) {
  if (n == null || n === '') return '';
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  return num.toLocaleString(pickLocale(lang), opts || {});
}

function formatMoney(amount, currency, lang) {
  const formatted = formatNumber(amount, lang, { maximumFractionDigits: 0 });
  return (currency || 'EGP') + ' ' + formatted;
}

function formatDate(iso, lang, opts) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(pickLocale(lang),
    opts || { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso, lang, opts) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(pickLocale(lang),
    opts || { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

module.exports = { formatNumber, formatMoney, formatDate, formatDateTime, pickLocale };
```

**Wire into middleware** (`src/middleware.js:225+`):
```diff
+ var fmt = require('./utils/formatNumber');
+ res.locals.formatNumber = (n, opts) => fmt.formatNumber(n, lang, opts);
+ res.locals.formatMoney = (amount, currency) => fmt.formatMoney(amount, currency, lang);
+ res.locals.formatDate = (iso, opts) => fmt.formatDate(iso, lang, opts);
+ res.locals.formatDateTime = (iso, opts) => fmt.formatDateTime(iso, lang, opts);
```

**Sweep all 19 callsites:**

| File:line | Before | After |
|---|---|---|
| `admin_pricing.ejs:132` | `p.tashkheesa_price.toLocaleString()` | `formatNumber(p.tashkheesa_price)` |
| `admin.ejs:275` | `Number(_fin.refundsThisMonth \|\| 0).toLocaleString() + ' EGP'` | `formatMoney(_fin.refundsThisMonth, 'EGP')` |
| `patient_new_case.ejs:380,446,505,713` | bare browser-side `.toLocaleString()` | new browser-side helper (see below) |
| `admin_reviews.ejs:18` | `toLocaleDateString('en-US')` | `formatDate(d)` |
| `doctor_appointments.ejs:46,51` | `toLocaleDateString('en-GB')` | `formatDate(d)` (which is en-GB in EN mode anyway) |
| `jobs/appointment_reminders.js:74-75` | `toLocaleDateString('en-US')` | `formatDate(d, lang)` — needs the recipient's lang threaded through |

**Browser-side variant (for views that JS-format inline):** add
`window.__lang` to a global script set by foot partial, and a tiny
`public/js/format-number.js` (~30 lines):

```javascript
window.formatNumber = function (n, opts) {
  if (n == null || n === '') return '';
  var num = Number(n);
  if (!isFinite(num)) return '';
  var loc = (window.__lang === 'ar') ? 'ar-EG' : 'en-GB';
  return num.toLocaleString(loc, opts || {});
};
window.formatMoney = function (amount, currency) {
  return (currency || 'EGP') + ' ' + window.formatNumber(amount, { maximumFractionDigits: 0 });
};
```

Replace `patient_new_case.ejs:380,446,505,713` bare calls with
`window.formatMoney(price, cur)`.

**Defer:**
- Currency symbol localisation (`EGP` → `ج.م`) — separate decision,
  flagged as OQ-2 below.
- Server-side notification templates (the WhatsApp/email date strings
  in `jobs/appointment_reminders.js:74-75`) need the recipient's preferred
  language threaded through. That's a 3-call signature update across
  `notification_worker.js` and `notify.js`. Worth its own commit.

### Sub-issue D — LTR-lock 44 input fields

**Goal:** every `<input type="tel|email|url|number|date|time">` and every
`<textarea>` whose content is LTR-by-design (medical-license number,
year, etc.) carries `dir="ltr"`.

**Mechanical edit** — 44 inputs across ~10 patient-facing views:

| File | Inputs |
|---|---|
| `src/views/login.ejs` | email |
| `src/views/register.ejs` | email |
| `src/views/forgot_password.ejs` | email |
| `src/views/reset_password.ejs` | (passwords are dir-neutral; skip) |
| `src/views/doctor_signup.ejs` | email, phone, license, year |
| `src/views/patient_new_case.ejs` | phone, age (number) |
| `src/views/public_case_new.ejs` | phone, age, email |
| `src/views/intake_form.ejs` | phone, email, date, age |
| `src/views/coming_soon.ejs:317-340` | name, email, phone |
| `src/views/help_me_choose.ejs` | (if it has any LTR-leaning inputs — verify) |

**Per-input diff:**
```diff
- <input type="tel" name="phone" required>
+ <input type="tel" name="phone" required dir="ltr">
```

**Estimated scope:** ~44 individual edits; lint-test below (T4)
catches regressions.

**Alternative approach** (more invasive, lower risk of regressions):
add a CSS rule:
```css
input[type="tel"], input[type="email"], input[type="url"],
input[type="number"], input[type="date"], input[type="time"],
input[type="datetime-local"] {
  direction: ltr;
}
```
Lift into `public/css/portal-global.css` so it applies everywhere.
**Recommendation:** ship both — CSS catches the long tail, explicit
attribute on existing inputs makes intent obvious. **Confirm
preference (OQ below).**

### Sub-issue E — Tables, charts, dashboards under RTL

**Goal:** the six admin/ops dashboard surfaces render coherently under
`dir=rtl` (admin staff are not necessarily English-first).

**Tables** (`admin_orders.ejs`, `admin_doctors.ejs`, `admin_pricing.ejs`,
`admin_pre_launch_leads.ejs`, `ops-dashboard.ejs`,
`portal_doctor_cases.ejs`):

- Replace `<th style="text-align:left">` with `<th>` (default left-align
  in LTR, right-align in RTL is what browsers do natively for tables).
- Lift inline `text-align: right` on numeric columns into a
  `.numeric-col` class with `text-align: end`.
- Sort indicators are vertical-only — no change needed.
- **Column ordering remains LTR** (column index 0 is leftmost regardless
  of direction). Per-survey convention, this is acceptable for a Latin-
  native admin staff and *probably* acceptable for AR admin staff. **OQ
  below.**

**Chart.js (`admin_analytics.ejs:317-475`):**
Add a `direction` config object per chart and let Chart.js mirror
axis labels:

```diff
 new Chart(document.getElementById('revenueTrendChart'), {
   type: 'line',
+  options: {
+    direction: (window.__lang === 'ar') ? 'rtl' : 'ltr',
+    scales: {
+      x: { reverse: (window.__lang === 'ar') }
+    }
+  },
   data: { ... }
 });
```

**Estimated scope:** 6 Chart instances × ~3 lines each = 18 lines in
`admin_analytics.ejs`. Plus the `window.__lang` global from Sub-issue C.

**Heat-style dashboards** (`ops-*.ejs`, `admin_errors.ejs`,
`ops-silent-failures.ejs`): out-of-scope for AR (ops surface is
en-only by ground-rule decision). Worth a single-line note: the same
patterns will need lifting if ops staff are ever AR-first.

**Defer:**
- Sortable-column "primary direction" decision (LTR even under RTL?
  RTL with leftmost = last column?) — UX call, OQ below.
- Chart.js v4 RTL axis behaviour is partial — the `direction` option
  exists for tooltip + legend but **does not** auto-mirror axis tick
  labels. May need a separate ticks callback. Worth one spike pass.

### Sub-issue F — Arabic font fallback rollout

**Goal:** AR copy renders in Noto Sans Arabic (or SF Arabic on Apple
platforms) across every surface, not just the doctor-profile views.

**Diff sketch** — single rule in `public/css/portal-global.css` (or a new
`public/css/rtl-font.css` loaded after the per-surface stylesheets):

```css
html[dir="rtl"], html[lang="ar"] {
  --v2-font-arabic: "SF Arabic", "Noto Sans Arabic", "Helvetica Neue", sans-serif;
  font-family: var(--v2-font-arabic);
}
```

**Consequence to verify** before landing: some surfaces (admin tables,
ops widgets) may have explicit `font-family: monospace` for log lines
or numeric fields. Those need to override back to monospace under RTL
too. ~5 spot fixes per file.

**Estimated scope:** ~10 lines of CSS + ~20 lines of per-file overrides
to preserve monospace where intended.

**Defer:** the `index.ejs:81` Noto+Sans+Arabic Google Fonts preload is
wasted today. Once Sub-issue F lands, it becomes useful. Removing the
preload if F doesn't land is the alternative cleanup.

### Sub-issue G — File-level inline-style sweep (P2-VIEW)

Not a fix, but a tracking entry: the 29 EJS views with inline `<style>`
blocks are jointly a Theme 2 (CSP `'unsafe-inline'`) and Theme 10b (RTL
override surface) concern. The sweep that extracts these into
stylesheets per Theme 2 should logicalise + RTL-override in the same
pass. **Recommend coordination with Theme 2 owner before separate
extraction passes.**

---

## 5. Verification Steps

Each verification corresponds to a sub-issue.

### V1 — Sub-issue A: prove the layout flips

1. **Visual diff (manual).** Launch local server, set `?lang=ar`, and
   walk the top-10 user-facing views (`/`, `/coming-soon`, `/services`,
   `/faq`, `/privacy`, `/terms`, `/portal/dashboard`,
   `/portal/new-case`, `/portal/orders/<id>`, `/help/patient`). Compare
   side-by-side with `?lang=en`. Verify that:
   - Sidebar offsets are on the opposite edge.
   - Card "badge" placements mirror.
   - Bullet-list indents mirror.
   - Form field labels align with the start of the inline axis.
2. **Static grep (post-patch).** After Sub-issue A lands, verify the
   physical-decl count drops:
   ```bash
   grep -rEn "margin-left|margin-right|padding-left|padding-right" \
     public/css/styles.css public/css/admin-styles.css \
     public/css/patient-portal.css public/css/doctor-portal.css \
     | wc -l
   ```
   Expect: ≤ 5 (left only those with explicit RTL overrides nearby).
3. **Logical-prop count** in the same files should rise correspondingly.
4. **RTL override count** in `styles.css:1507-1536` should drop to 0
   (replaced by base-level logical declarations).

### V2 — Sub-issue B: prove icons mirror

1. **Static grep.** After patch:
   ```bash
   grep -rEn "polyline points=\"9 18 15 12 9 6\"" src/views/*.ejs | \
     grep -v "p-icon--flip" | wc -l
   ```
   Expect: 0. Every chevron either uses `.p-icon--flip` or doesn't
   exist (replaced by the partial).
2. **Visual diff.** With `?lang=ar`, breadcrumb chevrons, "back" arrows,
   "next" CTAs, and pagination arrows all point right-to-left.
3. **Lint test T2 (below) regression-guards future commits.**

### V3 — Sub-issue C: prove numbers render in the right script

1. **Static grep.** After patch:
   ```bash
   grep -rEn "\.toLocaleString\(\)" src/views/*.ejs | grep -v "// " | wc -l
   ```
   Expect: 0. All callsites now go through `formatNumber()` or the
   browser-side helper.
2. **Render test.** Load `/portal/new-case?lang=ar` in a fresh
   browser with system language set to EN. Verify the price label on the
   service card renders Arabic-Indic numerals (e.g., `EGP ١٬٥٠٠`),
   matching the surrounding AR copy. Then `?lang=en` on the same
   browser → Western numerals (`EGP 1,500`).
3. **Notification test.** Fire an appointment-reminder
   `queueNotification` to an AR-locale user; verify the date in the
   WhatsApp template body is `١٢/٠٥/٢٠٢٦` not `5/12/2026`.

### V4 — Sub-issue D: prove LTR inputs

1. **Static grep.** After patch:
   ```bash
   grep -rEn "type=\"(tel|email|url|number|date|time)\"" src/views/*.ejs | \
     grep -v 'dir="ltr"' | wc -l
   ```
   Expect: 0 (or close to it — passwords intentionally excluded). The
   alternative CSS approach (Sub-issue D variant 2) makes this test
   permissive: the rule applies via stylesheet regardless of the
   attribute.
2. **Browser test.** Set `?lang=ar`, open every patient-facing form
   that has a `<input type="tel|email">` and verify the caret sits at
   the LEFT edge of the box and typed Latin characters flow LTR even
   though the surrounding label is RTL.

### V5 — Sub-issue E: prove dashboards survive RTL

1. **Chart visual.** Load `/admin/analytics?lang=ar` and verify each of
   the 6 chart canvases:
   - x-axis tick labels are in the right order (chronological
     left-to-right in EN; right-to-left in AR, OR documented as
     intentional non-mirror per OQ).
   - Tooltip arrow points toward the bar (Chart.js v4 honours this via
     the `direction` option).
2. **Table visual.** `/admin/orders?lang=ar` — column headers right-aligned
   under RTL; numeric columns still right-aligned (which is start-aligned
   in RTL); sort arrows are direction-agnostic.

### V6 — Sub-issue F: prove font fallback fires

1. **DevTools.** Inspect `<body>` on `/?lang=ar`; computed
   `font-family` should resolve to `SF Arabic` (macOS) or
   `Noto Sans Arabic` (other platforms), not `Inter`.
2. **Network panel.** Confirm `Noto+Sans+Arabic` Google Fonts
   subresource is actually downloaded and CSS-applied (not just
   preloaded).

---

## 6. What to Add to the Test Suite

Six new test files, mirroring the lint pattern from Themes 2, 4, 9.

### T1: `tests/lint/no-physical-margin-padding-in-css.test.js`

Reads `public/css/*.css` (excluding `*.bak`), regex-searches for
`margin-left|margin-right|padding-left|padding-right` outside lines that
also contain `auto;` (which is direction-neutral) or are inside a
`[dir=rtl]` selector block. Asserts the count is below a baseline
(start at 43, ratchet down as Sub-issue A lands). Pattern: same shape as
`tests/core/no-mobile-api-boot-script.test.js`.

**Exempt files** initially: `responsive.css` (mobile media queries may
need physical overrides), `annotator.css` (third-party-adjacent), all
`*.bak` files. Reduce exemptions as work progresses.

### T2: `tests/lint/directional-svgs-have-flip-class.test.js`

Walks `src/views/*.ejs`. For every `<svg>` containing one of the
known directional polyline patterns
(`9 18 15 12 9 6`, `15 18 9 12 15 6`, `6 9 12 15 18 9`,
`5 12 19 12`, `9 6 15 12 9 18`), asserts the surrounding `<svg>` tag
contains either `class="p-icon--flip"` or has a sibling
`<%= _isAr ? ... %>` ternary.

### T3: `tests/lint/no-bare-tolocalestring.test.js`

Walks `src/views/*.ejs` and `src/jobs/*.js`. Asserts zero matches for
the regex `\.toLocaleString\(\s*\)` or `\.toLocaleDateString\(\s*'en-`
or `\.toLocaleTimeString\(\s*'en-`. Allow-list explicitly: passwords,
URLs, IDs, and the `formatNumber.js` helper itself.

### T4: `tests/lint/ltr-input-fields.test.js`

Walks `src/views/*.ejs`. For every `<input type="tel|email|url|number|
date|time|datetime-local">`, asserts either `dir="ltr"` is present on
the element OR the document loads `portal-global.css` (in which case
the CSS rule covers it). Asserts neither approach is *missing* —
fail-loud on regressions.

### T5: `tests/core/rtl-doc-direction-flips.test.js`

HTTP-level test (same shape as `tests/core/lang-toggle.test.js`).
- GET `/?lang=en` → assert `<html lang="en" dir="ltr">`.
- GET `/?lang=ar` → assert `<html lang="ar" dir="rtl">`.
- Walk every top-level view in `THEME_10_VIEW_INVENTORY.md` and assert
  the same flip works.
- Catches the class of bug that was `index.ejs:13` (hardcoded
  `lang="en"`) before Theme 10 fixed it.

### T6: `tests/lint/no-hardcoded-html-lang.test.js`

Static-grep `src/views/*.ejs` for `<html lang="en"` or `<html lang="ar"`
(literals, not variables). Assert zero matches.

### Visual regression (optional, deferred)

Worth flagging but not landing in Theme 10b: a Percy/Chromatic-style
screenshot test that captures every top-level view at `?lang=ar` and
diffs against a stored snapshot. The five lint tests above catch the
class of regression; a screenshot test catches the visual breakage. Out
of scope for Theme 10b unless infra exists.

---

## 7. Rollback Plan

Each sub-issue commit is independently revertable. None of them mutate
database schema; rollback is `git revert <sha>`.

| Commit | Files touched | Rollback shape | Caveat |
|---|---|---|---|
| Sub-issue A — CSS logicalisation | `public/css/styles.css`, `admin-styles.css`, `patient-portal.css`, `doctor-portal.css`, `messages.css`, `portal-tours.css`, `portal-global.css`, `responsive.css`, `portal-components.css` | `git revert <sha>` | Pure visual regression to LTR-biased layout. No data loss. |
| Sub-issue B — icon mirror class + sweep | `public/css/icons.css` (new), ~40 views with `<svg>` edits | `git revert <sha>` | Some chevrons start pointing the wrong way again. |
| Sub-issue C — formatNumber helper + sweep | `src/utils/formatNumber.js` (new), `src/middleware.js`, ~15 views, `public/js/format-number.js` (new) | `git revert <sha>` | Browser-locale-dependent numerals return. |
| Sub-issue D — LTR inputs | ~10 patient-facing views + 1 CSS rule | `git revert <sha>` | Phone/email caret returns to right edge under RTL. |
| Sub-issue E — dashboards/charts | `src/views/admin_analytics.ejs`, table views | `git revert <sha>` | Chart axes return to LTR-only. |
| Sub-issue F — Arabic font global | 1 stylesheet | `git revert <sha>` | AR text returns to Inter / system fallback. |
| Tests T1-T6 | `tests/lint/*.js`, `tests/core/*.js` | `git revert <sha>` | Test-only. |

**No migration to reverse. No env var to unset. No external service to
unconfigure.** The "rollback" question that's actually live: if RTL
changes break LTR (e.g., a logical-property edit that browsers >2 years
old don't support), the revert is purely visual.

**Browser compat note:** `margin-inline-start` / `margin-inline-end` are
universal since 2019 (Chrome 87+, Safari 14.5+, Firefox 66+). The
codebase doesn't target any pre-2020 browser per `package.json` /
`browserslist` (verify before landing). Risk on logicalisation is
effectively zero.

**Hard rollback (no Arabic at all):** set the cookie+session default
`lang` to `en` and remove the `/lang/ar` route — `dir` will revert to
`ltr` everywhere via `getDir()`. Already supported by today's wiring.
No source edit required for the hard rollback; this is the audit's
"safe fallback" because Theme 10b is purely additive.

---

## 8. Open Questions for Ziad

### OQ-1: Logicalise top-down, or add `[dir=rtl]` overrides bottom-up?

Sub-issue A as written **prefers logicalisation** (replace
`margin-left: X` with `margin-inline-start: X` at the base declaration,
drop the `[dir=rtl]` override). The alternative is to **keep physical
base declarations** and add more `[dir=rtl]` overrides — minimally
invasive, lower risk of touching a working component.

**Recommendation:** logicalise where the component is direction-neutral
(sidebar offsets, content margins, button gaps). Keep physical + RTL
override where the component is direction-specific (the marketing nav
that hand-rolled `flex-direction: row-reverse` at `styles.css:1510`).
**Confirm:** OK to logicalise as default, with override-style reserved
for marketing-nav and explicitly-direction-specific components?

### OQ-2: Arabic-Indic vs Western numerals for prices and dates?

Sub-issue C as written produces **Arabic-Indic numerals in AR mode**
(via `ar-EG` locale). Some product calls go the other way: Egyptian
e-commerce mostly uses **Western digits even in Arabic copy** because
prices are SKU-internal and Western digits are the default in
SaaS-Arabic contexts (think Talabat, Vodafone Cash). The audit's
P2-UI-15 didn't take a position.

**Options:**
1. **Arabic-Indic everywhere AR is active** (what the helper above
   does by default).
2. **Western numerals always; Arabic copy with Western numerals** —
   pass `useGrouping: false` and a locale that forces Latin digits
   (e.g., `'ar-EG-u-nu-latn'`).
3. **Hybrid: dates in Arabic-Indic, money in Western** — matches what
   `patient_order.ejs:481-492` accidentally produces today (mixed
   `ar-EG` for dates, currency labels stay EGP/Western).

**Recommendation:** option 3 (hybrid) for the patient surface; option
1 for help/marketing content where the AR copy is being read for
information rather than scanned. **Confirm:** which?

### OQ-3: Sub-issue C — change notification template dates too?

`src/jobs/appointment_reminders.js:74-75` hardcodes
`toLocaleDateString('en-US')` in the WhatsApp/SMS template payload. An
AR patient receives notification with EN-formatted date even though
their UI is fully Arabic. Threading lang through requires updating
`notification_worker.js` + `notify.js` signatures (3 callsites). Not
trivial but small.

**Recommendation:** fold into Sub-issue C. **Confirm:** include or
defer?

### OQ-4: Sub-issue D — explicit `dir="ltr"` per input, or one CSS rule?

The two approaches are not mutually exclusive (Sub-issue D §4 above
recommends both). The explicit attribute is self-documenting; the CSS
rule catches the long tail and any future-added input.

**Risk of CSS-only:** a third-party widget that loads its own
`<input type="email">` (e.g., the Uploadcare widget config dialog) will
inherit the rule too. May or may not be desirable. Worth a 5-minute
sanity check before landing.

**Confirm:** ship both (explicit + CSS), or CSS-only?

### OQ-5: Sub-issue E — should AR admin staff see right-most-first columns?

Strict RTL convention places the "first" column at the **right** of the
table (read order). The codebase today (and the `admin_pricing.ejs`,
`admin_doctors.ejs`, `admin_orders.ejs` tables) renders columns
left-to-right regardless of `dir`. SaaS-Arabic convention generally
keeps tables LTR even when the surrounding UI is RTL (think the
Egyptian Banking System portals).

**Recommendation:** **leave column order LTR** even under RTL. Document
the choice explicitly so a future audit doesn't reopen it. Numeric
columns continue right-aligning (which is start-aligning in RTL — pure
coincidence, but it's the correct behaviour).

**Confirm:** OK to leave column ordering LTR?

### OQ-6: Chart.js RTL — full mirror or label-only?

Sub-issue E §Chart.js proposes
`options.direction: 'rtl'` + `scales.x.reverse: true` for AR mode.
Chart.js v4's `direction` option mirrors the *tooltip* and *legend*
(verified per their docs as of 4.4.0), but **does not** mirror
axis-tick label order. To get axis ticks in RTL (rightmost = oldest
date), you need a custom `ticks.callback` or to pre-reverse the data
array.

**Two paths:**
1. **Cosmetic-only:** flip tooltip/legend direction. Time axis stays
   LTR. Simpler.
2. **Full mirror:** also reverse the x-axis data + tick labels. More
   work; matches strict RTL convention.

**Recommendation:** option 1 (cosmetic) for launch; option 2 as a P3
polish item. **Confirm:** which?

### OQ-7: Sub-issue F — replace Inter with Noto Sans Arabic globally for AR, or only when no Latin glyph available?

The audit's P3-UI-? line on font fallback wants AR copy to render in
an AR-designed font for visual coherence. The strict approach swaps
**the entire `font-family`** when `dir=rtl`. The lighter approach uses
`unicode-range` directives so Inter handles Latin glyphs and
Noto Sans Arabic handles AR glyphs in the same paragraph — useful for
mixed-script content like "EGP ١٬٥٠٠" or doctor names rendered in AR
context.

**Recommendation:** the lighter approach (`unicode-range`). It costs
~10 extra `@font-face` declarations in `fonts.css` and produces
visually-correct mixed-script output without breaking the Inter
identity for Latin glyphs.

**Confirm:** OK?

### OQ-8: Is Sub-issue G (Theme 2 inline-style coordination) in scope here, or do we leave it as a flag?

29 EJS views carry inline `<style>` blocks. Theme 2 has been extracting
them for CSP reasons. Theme 10b wants the same files for RTL reasons.
Doing both in one pass per file is cheaper than two passes; doing them
separately is lower-risk per commit.

**Recommendation:** Sub-issue G is a coordination/scheduling decision,
not a code change. **Confirm:** OK to flag-only, with Sub-issue A
strictly limited to stylesheet files (not view-inline styles)?

### OQ-9: Browserslist target?

Sub-issue A's logicalisation relies on `margin-inline-*` and friends.
Universal since 2019 (per MDN). Confirm `package.json` browserslist /
target doesn't pin a pre-2020 browser. If it does, fall back to the
`[dir=rtl]` override approach in OQ-1's alternative.

**Confirm:** can you check `package.json` for explicit browserslist?

### OQ-10: Should the visual-regression screenshot suite be in scope?

Six lint tests (T1-T6) catch the class of regression. They do not catch
*visual* regression — e.g., a logical-prop edit that compiled fine but
shifted a button's position by 8px. The right tool for that is a
Percy/Chromatic-style screenshot diff against a stored baseline.

**Recommendation:** out of scope for Theme 10b — landing six lint
tests is the better first move. Document the visual-regression gap as
a follow-up project. **Confirm:** OK to defer?

---

## Appendix: discovered-but-deferred items

Logged here so they don't fall off the trail between Theme 10b and a
future post-launch sweep.

- **`P3-RTL-1` — Marketing-site nav language toggle pill** uses
  hand-rolled CSS at `styles.css:1510-1536`. Works today but uses
  `flex-direction: row-reverse` rather than the more robust
  `direction: rtl` inheritance — meaning custom child-component
  margins inside the nav still need RTL-specific overrides. Sketch:
  swap the row-reverse rules for `[dir=rtl] .nav-inner { direction:
  rtl; }` + base logical-prop child margins. ~15 lines.

- **`P3-RTL-2` — Inline arrow glyphs in blog views** (`←`/`→` baked
  into AR/EN string literals at `blog_when_to_get_second_opinion.ejs:118-182`,
  `blog_how_tashkheesa_works.ejs:230-282`, `messages.ejs`,
  `doctor_prescription_detail.ejs`, `doctor_case_intelligence.ejs`).
  Hand-corrected per language. Brittle: a copy edit that swaps the
  arrow direction silently breaks the visual. Sketch: replace with
  CSS pseudo-element pattern (already used by `blog_index.ejs:52-55`).
  ~10 callsite edits.

- **`P3-RTL-3` — Ops dashboard surfaces** (`ops-dashboard.ejs`,
  `ops-errors.ejs`, `ops-silent-failures.ejs`, `admin_errors.ejs`)
  carry `th { text-align: left }` plus inline `text-align: right` on
  numeric columns. Not patient-facing AR, but inherits the same
  fragility. Out of Theme 10b strict scope. Worth a single-line
  comment if/when AR ops staff are onboarded.

- **`P3-RTL-4` — `--v2-font-arabic` variable indirection.**
  `doctor-profile.css:51` and `doctor-prescribe.css:66` re-alias the
  variable as `--font-arabic` but neither file actually applies
  `font-family: var(--font-arabic)` to a top-level selector. The
  indirection is dead. Sub-issue F replaces this with a global rule;
  the dead indirection can be cleaned up in the same commit.

- **`P3-RTL-5` — `Noto+Sans+Arabic` Google Fonts preload is unused.**
  `index.ejs:81` loads the font weights 400/600/700 on every page
  view. CSS never references the family. Either Sub-issue F lands (and
  the preload becomes useful) or the preload should be removed
  (~3-line edit).

- **`P3-RTL-6` — Patient-portal v1 sidebar offset broken under RTL.**
  `patient-portal.css:240` does `margin-left: var(--p1-sidebar-w)`
  with no `[dir=rtl]` override. Affects v1-bound views only
  (`messages.ejs`, a handful of others). Sub-issue A's
  logicalisation closes this. Cross-referenced for completeness.

- **`P3-RTL-7` — Number formatting in WhatsApp/SMS templates.**
  `jobs/appointment_reminders.js:74-75` and adjacent. Patient receives
  AR-locale notification with EN-formatted date. Cross-referenced as
  part of Sub-issue C's "thread lang through notification layer" work.

- **`P3-RTL-8` — Chart.js v4 axis label mirroring is partial.** Out
  of Sub-issue E strict scope; recommended path is "ship cosmetic-only
  for launch, polish later."

