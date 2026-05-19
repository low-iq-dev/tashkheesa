# Phase 2 Backlog — Doctor Portal v2 Migration

**Status:** Active. Phase 1 shipped on commit `c9cd0b3` (PR merged from `feat/doctor-portal-v2-warm-clinical`).

**Working agreement:**
- This file is the single source of truth for what's left.
- Any new issue, regression, or scope discovery gets logged here as it surfaces — never solved silently.
- Items are picked off in priority order unless explicitly re-prioritised.
- When an item ships, move it to the bottom under `## Done` with the commit SHA.

---

## 🔴 Legacy pages — full v2 redesign needed

| File | Surface | Notes |
|------|---------|-------|
| `src/views/doctor_analytics.ejs` | Performance stats — turnaround, ratings, earnings | Currently no nav link; either redesign or hard-delete |
| `src/views/doctor_appointments.ejs` | Video appointment scheduling | Tied to the video-call feature; check if feature is shipped before redesign |
| `src/views/doctor_case_intelligence.ejs` | AI assistance / pattern recognition | Feature is BETA; case detail page already shows a "Case intelligence" card stub |
| `src/views/doctor_reviews.ejs` | Patient review history | Reviews already render in profile; this standalone may be redundant — decide before redesigning |
| `src/views/portal_doctor_dashboard.ejs` | Older dashboard | "Today" replaces this in v2 IA; almost certainly hard-delete |
| `src/views/portal_doctor_guide.ejs` | Onboarding / help | Low priority |

---

## 🟡 Partial v2 — needs polish/audit

| File | Surface | Notes |
|------|---------|-------|
| `src/views/doctor_login_v2.ejs` | Login screen | Already has v2 markers; audit for token usage |
| `src/views/doctor_pending_approval.ejs` | Post-signup waiting state | Low traffic but visible to every new doctor |
| `src/views/doctor_signup.ejs` | Doctor self-service signup | First impression for prospective doctors |
| `src/views/doctor_signup_submitted.ejs` | Post-submit confirmation | Pairs with doctor_signup.ejs |
| `src/views/portal_doctor_earnings.ejs` | Earnings page | Sidebar shows SOON — decide: ship full feature or keep SOON |
| `src/views/portal_doctor_messages.ejs` | Messages page | Sidebar shows SOON — decide: ship full feature or keep SOON |

---

## 🔵 Functionality gaps (not just visual)

- **Doctor signature upload UX** — the prescribe form references it (shows "no signature on file" warning) but the upload flow itself doesn't exist as a clear surface. Either build it or remove the warning. ~1-2 hrs.
- **Autocomplete on Profile** — sub-specialties (specialty-aware), board certifications, languages. Per Ziad's earlier ask. ~2-3 hrs.
- **Topbar bell dropdown to replace doctor alerts page** — Phase 2 architectural decision logged in commit `9603e9a`. The current alerts page works but is a full surface for what should be a notification dropdown.

---

## 🧹 Cleanup (after Phase 2 verification)

- `git rm` the 7 `.bak` files preserved during Phase 1 once nothing needs rolling back:
  - `src/views/portal_doctor_profile.ejs.bak`
  - `src/views/doctor_prescribe.ejs.bak`
  - `src/views/doctor_alerts.ejs.bak`
  - `src/views/doctor_prescriptions_list.ejs.bak`
  - `src/views/patient_alerts.ejs.bak` + 7 more patient backups
  - `public/css/portal-variables.css.bak`, `public/css/doctor-portal-v2.css.bak`, `public/css/doctor-profile.css.bak`
  - `src/views/layouts/portal.ejs.bak`
- Decide fate of pages cut from sidebar nav (analytics, appointments, etc.) — redesign vs hard-delete

---

## 🚫 Out of scope (logged so we don't accidentally pull them in)

- **Admin / superadmin views** — separate workstream
- **Hospital ops** (Shifa hospital workflows) — separate product surface
- **Paymob payment onboarding** — flagged as the remaining blocker from the late-March audit, separate workstream
- **Hospital call-centre AI integration** — Ziad's top-of-mind project, separate workstream
- **`patient_onboarding.ejs`** — runs after signup before portal entry. Part of the auth-flow workstream (login/signup/reset/onboarding). Skip during portal v2 migration; revisit when the auth workstream is touched. [decided 2026-04-28]
- **`patient_walkthrough.ejs`** — 859-line interactive tutorial under `/help/patient-walkthrough`. Help-content semantics, not patient-portal proper. Skip during portal v2 migration. [decided 2026-04-28]
- **`doctor-prescribe.css` hybrid (--v2-* + --dr-* coexisting)** — file's own header documents the aliasing as intentional design. Visually v2 already; re-tokenizing for audit purity creates regression risk on a working clinical surface. Leave as-is. [decided 2026-04-28]

---

## 📝 Issues discovered during Phase 2 (log as we go)

*Add any bug, regression, or scope discovery here. Format:*

```
- [YYYY-MM-DD] Issue description. Severity. Resolution / commit SHA when fixed.
```

- [2026-04-28] **`portal_doctor_dashboard.ejs` IS the live "Today" page.** The Phase 2 Backlog (this file, `🔴 Legacy pages` table) said "Today replaces this in v2 IA; almost certainly hard-delete". That's wrong — `src/routes/doctor.js:127` aliases both `/portal/doctor/today` AND `/portal/doctor/dashboard` to the same handler, which renders `portal_doctor_dashboard.ejs`. The file is the current v2 Today surface, NOT a legacy artifact. KEEP-AS-IS, optional rename only. Severity: low (audit-time correction, no behavioural impact).
- [2026-04-28] **`partials/doctor_header.ejs` is a legacy nav partial still on disk.** Surfaces only the legacy `queue / completed / reviews / analytics / alerts` links, not the v2 sidebar IA. Currently includes hrefs to two surfaces that no longer have files (`/portal/doctor/queue` and `/portal/doctor/completed` resolve to `portal_doctor_cases` per `docs/audits/full-portal-chrome-state.md`). Not loaded by any v2 view. Candidate for deletion in a future cleanup pass — out of scope for Phase 2 audit (the audit covers `src/views/` only). Severity: low, cosmetic.
- [2026-04-28] **Round 2 brief was stale on the signup pair (Task J).** `CLAUDE_CODE_BRIEF_PHASE2_ROUND2.md` Task J said `doctor_signup.ejs` (claimed 171 lines) and `doctor_signup_submitted.ejs` (claimed 55 lines) were "currently partial-v2 per the audit" and required a full v2 redesign. Both files are already standalone v2-auth pages: `doctor_signup.ejs` is now 97 lines using the v2-auth hero + form-wrap shell with full `--v2-*` token discipline + bilingual `_t()` labels; `doctor_signup_submitted.ejs` is 31 lines on the `.v2-pending-wrap` / `.v2-pending-card` chrome (same shell as `doctor_pending_approval.ejs`). `docs/audits/full-portal-chrome-state.md:69-70` records both as **v2** and notes "View body rewritten in commit `026da09` (standalone v2-auth page)". The audit decision table at line 426-427 of this backlog also marks them REDESIGN-out-of-scope. Conclusion: **Task J skipped (no commits) — the redesign already shipped before the round 2 brief was drafted.** Both pages pass the same token / inline-handler / bilingual audit Task I ran clean against `doctor_login_v2.ejs` + `doctor_pending_approval.ejs`. Severity: low, brief-staleness (no code drift). Resolution: this log entry; no follow-up work.

---

## Audit results — 2026-04-28

Decision-only audit per `CLAUDE_CODE_BRIEF_PHASE2.md` Task C. For each
file: rendered-by route, nav linkage in v2 sidebar / topbar / legacy
partial, and a verdict — REDESIGN, DELETE, or KEEP-AS-IS. **No code
changed in this pass; the user reviews the redesign-vs-delete calls
before any follow-up work.**

Live-nav reference (the v2 chrome the user sees post-Phase-1):

  - `src/views/partials/doctor/sidebar.ejs` —
    `today / cases / prescriptions / messages / earnings / profile`
  - `src/views/partials/doctor/topbar.ejs` —
    bell→`/portal/doctor/alerts`, help→`/portal/doctor/guide`

Legacy nav still on disk (no longer included by any v2 view):

  - `src/views/partials/doctor_header.ejs` —
    `queue / completed / prescriptions / reviews / analytics / alerts`

| File | Lines | Rendered by | v2 link | Legacy link | **Verdict** |
|---|---:|---|---|---|---|
| `doctor_analytics.ejs`        | 204 | `analytics.js:324` | — | header (analytics) | **DELETE** |
| `doctor_appointments.ejs`     | 357 | `video.js:1422`    | — | — | **DELETE** |
| `doctor_case_intelligence.ejs`| 525 | `doctor.js:1393`   | reached via case-detail "Case intelligence" button | — | **KEEP-AS-IS** |
| `doctor_reviews.ejs`          | 102 | `reviews.js:194`   | — | header (reviews) | **DELETE** |
| `portal_doctor_dashboard.ejs` | 468 | `doctor.js:429` (`/today` + `/dashboard`) | sidebar (today) | — | **KEEP-AS-IS** |
| `portal_doctor_guide.ejs`     | 173 | `doctor.js:1778`   | topbar (help icon) | — | **REDESIGN** |
| `doctor_login_v2.ejs`         |  78 | `auth.js:638`      | n/a (auth) | n/a | **KEEP-AS-IS** |
| `doctor_pending_approval.ejs` |  58 | `doctor.js:117`    | n/a (auth post-signup) | n/a | **KEEP-AS-IS** |
| `doctor_signup.ejs`           |  97 | `auth.js:662` (+3 re-render paths on validation error) | n/a (public) | n/a | **REDESIGN** |
| `doctor_signup_submitted.ejs` |  31 | `auth.js:750`      | n/a (post-signup) | n/a | **REDESIGN** |
| `portal_doctor_earnings.ejs`  |  34 | `doctor.js:636`    | sidebar (earnings) | — | **KEEP-AS-IS** |
| `portal_doctor_messages.ejs`  |  35 | `doctor.js:619`    | sidebar (messages) | — | **KEEP-AS-IS** |

### Detailed reasoning

**DELETE — `doctor_analytics.ejs`**
Reached only via the legacy `partials/doctor_header.ejs` nav (the v2 sidebar
omits analytics by design — "cut from sidebar nav and rarely visited", per
the prior backlog note). The route at `analytics.js:324` is the only entry
point and has no inbound link from any v2 view. KPI dashboards are not on
the Phase 2 critical path; the doctor's earning/case stats already surface
on Today + Earnings + Profile reviews block. Recommend hard-delete the view
+ unwire the route in a follow-up commit.

**DELETE — `doctor_appointments.ejs`**
Doctor-side video appointments page. The patient-side
`patient_appointments_list.ejs` (already migrated to v2 in Phase 1) is the
production surface for appointment listings; the doctor side is unreferenced
from anywhere in the v2 chrome and has no nav link in either the v2 sidebar
or the legacy header. Route at `video.js:1422` is the only entry. The video
consultation feature itself is functional (ELEVATE/JOIN call routes exist
elsewhere) — only this listing surface is dead. Hard-delete.

**KEEP-AS-IS — `doctor_case_intelligence.ejs`**
Reached from the case-detail page's "Case intelligence" card button (BETA
feature, AI-assisted pattern recognition). Not in any nav; entry is
intent-driven from inside a case. Per the Phase 2 Backlog this is a BETA
surface that still needs product validation — redesigning before the
feature stabilises is wasted work. Polish later if/when BETA promotes;
note the file currently uses the legacy `partials/header` chrome with
`portalActive: 'queue'`, which works visually but should be re-evaluated
post-promotion.

**DELETE — `doctor_reviews.ejs`**
Phase 1 IA folded the doctor's review history into the Profile page (the
`profileReviews + profileReviewStats` locals + the "Patient reviews" block
at the bottom of `portal_doctor_profile.ejs`). The standalone reviews page
duplicates that surface and is reachable only from the legacy
`doctor_header.ejs`. Route at `reviews.js:194` (`GET /portal/doctor/reviews`)
should redirect to `/portal/doctor/profile#reviews-block` or be unwired
entirely. Hard-delete the view; route can stay as a 302 to profile if any
external bookmarks need preservation.

**KEEP-AS-IS — `portal_doctor_dashboard.ejs`**
**Audit correction:** the Phase 2 Backlog's prior assumption ("Today
replaces this in v2 IA; almost certainly hard-delete") is wrong.
`src/routes/doctor.js:127` aliases both `/portal/doctor/today` AND
`/portal/doctor/dashboard` to the same handler that renders this file —
i.e. this file IS the live Today surface, not a legacy dashboard. The
file head sets `portalActive: 'today'` and uses the v2 chrome. Sidebar's
"today" item links here. Optional follow-up: rename the file to
`portal_doctor_today.ejs` for clarity, then update the single render call
in `doctor.js:429`. No visual work needed.

**REDESIGN — `portal_doctor_guide.ejs`**
Linked from the topbar help icon (`partials/doctor/topbar.ejs:47`) — i.e.
every doctor page has a 1-click path here. Currently uses the legacy
`partials/header` chrome with `portalActive: 'guide'` and 173 lines of
content. This is reachable v2 chrome but not yet in the warm-clinical
language. Priority: medium — the help icon is in every page so the surface
is visible, but it's not on the daily-use critical path.

**KEEP-AS-IS — `doctor_login_v2.ejs`**
File name carries the `_v2` marker; the route at `auth.js:638` is the only
entry. Standalone auth screen, no portal frame. Polish task: audit `--v2-*`
token usage to confirm it matches the warm-clinical palette already
shipped on the patient login. Low priority — the login screen is rarely
re-visited by repeat doctors.

**KEEP-AS-IS — `doctor_pending_approval.ejs`**
Post-signup waiting state, 58 lines, standalone HTML (no portal frame).
Render at `doctor.js:117` triggers from the login flow when
`user.pending_approval = true`. Polish: token-audit pass to confirm
warm-clinical consistency with the other auth screens. Low traffic but
visible to every new doctor.

**REDESIGN — `doctor_signup.ejs`**
First impression for prospective doctors — public surface at
`/doctor/signup`. Currently a 97-line standalone with bilingual copy and
a basic specialty `<select>`. Three re-render paths in the route handler
on validation errors. Priority: medium-high — every prospective doctor
sees this. Migration target: warm-clinical auth screen pattern (left-side
brass-gradient hero + right-side form, same shape as the patient
auth surfaces).

**REDESIGN — `doctor_signup_submitted.ejs`**
31-line confirmation screen post-signup-submit. Pairs with
`doctor_signup.ejs` — should ship redesigned together so the signup →
submitted journey reads as one cohesive sequence.

**KEEP-AS-IS — `portal_doctor_earnings.ejs`**
34-line stub. Already loads v2 chrome (`partials/header` with
`portalFrame: true` + `partials/doctor/topbar`), sidebar links here.
Per the existing backlog row: decide whether to ship a real earnings
feature or keep the SOON state. The view itself doesn't need redesign —
it's the *content* that's the question, which is product/feature scope,
not visual migration.

**KEEP-AS-IS — `portal_doctor_messages.ejs`**
35-line stub, identical pattern to earnings. Sidebar links here. Same
"ship feature vs keep SOON" call as earnings; visual is already v2.

### Recommended deletion list (HARD-DELETE in a follow-up commit)

  1. `src/views/doctor_analytics.ejs`        + the `analytics.js:324`-area route handler
  2. `src/views/doctor_appointments.ejs`     + the `video.js:1422`-area route handler
  3. `src/views/doctor_reviews.ejs`          + the `reviews.js:194`-area route handler (replace with 302→profile if external links matter)
  4. `src/views/partials/doctor_header.ejs`  (legacy nav partial; not in this audit's 12-file scope but flagged in Issues above)

Plus a deferred follow-up that's out of Phase 2 audit scope:

  - Stale-link audit on the legacy `doctor_header.ejs`: `/portal/doctor/queue` and `/portal/doctor/completed` resolve through `portal_doctor_cases.ejs` per `docs/audits/full-portal-chrome-state.md`, but the URLs themselves still work. If we hard-delete `doctor_header.ejs` those resolve points stay reachable via the v2 sidebar's `cases` item.

### Recommended REDESIGN list (priority order)

  1. `doctor_signup.ejs` + `doctor_signup_submitted.ejs` (ship together — first-impression public surface)
  2. `portal_doctor_guide.ejs` (topbar help icon — visible on every doctor page)

### Recommended KEEP-AS-IS / polish list

  1. `portal_doctor_dashboard.ejs` — optional rename to `portal_doctor_today.ejs` for clarity (1-line route change)
  2. `doctor_login_v2.ejs` + `doctor_pending_approval.ejs` — token-audit pass to confirm warm-clinical consistency
  3. `doctor_case_intelligence.ejs` — re-evaluate post-BETA promotion
  4. `portal_doctor_earnings.ejs` + `portal_doctor_messages.ejs` — product call (ship feature vs keep SOON), no visual work

---

## Legacy style audit — 2026-04-28

Audit per `CLAUDE_CODE_BRIEF_LEGACY_AUDIT.md`. Read-only — no code
changed; every classification has explicit token / class / chrome
evidence. Scope: doctor + patient portal views and partials. Out of
scope: admin/superadmin/ops/order_flow/public marketing/login/signup/
reset-password.

Buckets per brief:

  - **V2** — uses `--v2-*` tokens, OR loads `doctor-portal-v2.css` /
    `patient-portal-v2.css`, OR wraps under `body.doctor-theme.portal-v2`
    or `body.p-portal`, OR uses `.v2-*` / `.p-*` BEM consistently.
  - **Partial-v2** — has SOME v2 markers AND legacy chrome (e.g. v2
    chrome from layout but body styled by a CSS file that uses legacy
    `--dr-*` tokens).
  - **Legacy** — zero v2 markers; raw hex throughout, legacy class
    names (`.portal-shell`, `--medical-*`, `--primary-blue`).

Verdicts:

  - **OK** — already v2, no work needed.
  - **POLISH** — partial-v2; close the token / BEM gap.
  - **REDESIGN** — full legacy and reachable.
  - **DELETE** — legacy AND no route renders it AND no view links to
    it (orphaned).

**Scope reminder:** every doctor view goes through `partials/header
{ portalRole: 'doctor' }` → `layouts/portal.ejs`, which adds
`body.doctor-theme.portal-v2` and loads `doctor-portal-v2.css`.
Therefore every doctor view inherits **v2 chrome** at runtime; the
question is whether the **body** also uses v2 tokens / BEM. Where a
view's body CSS uses legacy `--dr-*` tokens (defined in the legacy
`doctor-portal.css`), the file is **Partial-v2** (chrome v2, body
legacy).

### Summary table

| Path | Lines | Bucket | Verdict | Reachable | Notes |
|---|---:|---|---|---|---|
| `src/views/doctor_alerts.ejs`             |  162 | V2         | OK       | `doctor.js:1019` (fallback chain) | 4× `--v2-*`, 16× `.v2-` BEM (`v2-alert-row`); 0 hex. |
| `src/views/doctor_analytics.ejs`          |  204 | Partial-v2 | POLISH   | `analytics.js:324` | Body uses `.dan-*` BEM styled by `doctor-analytics.css` (18× `--dr-*` legacy tokens, 0× `--v2-*`; remaining vars are legacy palette tokens like `--accent-teal`, `--text-6xl`). Linked from v2 sidebar (commit `719db25`). |
| `src/views/doctor_appointments.ejs`       |  357 | Partial-v2 | POLISH   | `video.js:1309/1422` | `.dap-*` BEM via `doctor-appointments.css` (29× `--dr-*`, 0× `--v2-*`; rest are legacy palette tokens). Linked from v2 sidebar (commit `2456de0`, SOON badge). |
| `src/views/doctor_case_intelligence.ejs`  |  525 | Partial-v2 | POLISH   | `doctor.js:1393` | `.ci-*` BEM with **inline** `--dr-*` token use (≥35 refs) and 60 raw hex from medical-blue palette. Reached from case-detail "Case intelligence" card. BETA. |
| `src/views/doctor_prescribe.ejs`          |  988 | Partial-v2 | POLISH (low priority — hybrid by design) | `prescriptions.js:23+` | `.dpx-*` BEM styled by `doctor-prescribe.css`, which is **explicitly hybrid** (44× `--v2-*` AND 41× `--dr-*`). The CSS file's own header documents this: `--dr-*` tokens are kept on legacy rule blocks while new `.dpx-*` rules use `--v2-*` aliases. Visual result is warm-clinical because the aliases resolve to v2 values. Polish would be a mechanical re-token of the legacy half; user may prefer to leave the hybrid alone since runtime appearance is correct. |
| `src/views/doctor_prescription_detail.ejs`|  176 | V2         | OK       | `prescriptions.js` | 22× `--v2-*`, 52× `.v2-*` BEM. |
| `src/views/doctor_prescriptions_list.ejs` |  129 | V2         | OK       | `prescriptions.js:388` | 17× `--v2-*`, 44× `.v2-*` BEM. Linked from v2 sidebar. |
| `src/views/doctor_reviews.ejs`            |  102 | Partial-v2 | POLISH   | `reviews.js:161` (public reviewer page) | `.dr-*` BEM via `doctor-reviews.css` (14× `--dr-*`, 0× `--v2-*`; rest are legacy palette tokens). NOT in v2 sidebar (own reviews folded into Profile). |
| `src/views/portal_doctor_case.ejs`        |  478 | V2         | OK       | `doctor.js:1255` | 14× `--v2-*`, 210× `.v2-*` BEM. Linked from cases list. |
| `src/views/portal_doctor_cases.ejs`       |  195 | V2         | OK       | `doctor.js:455+` (`/queue`, `/completed`, `/cases`) | 3× `--v2-*`, 42× `.v2-*` BEM. Linked from v2 sidebar. |
| `src/views/portal_doctor_dashboard.ejs`   |  468 | V2         | OK       | `doctor.js:124` (`/today` + `/dashboard` aliases) | `.dd-*` BEM via `doctor-dashboard.css` (95× `--v2-*`, 0× `--dr-*`); body class adds `page-doctor-dashboard`. |
| `src/views/portal_doctor_earnings.ejs`    |   34 | V2         | OK       | `doctor.js:636` | Stub. 12× `.v2-*` BEM (card / coming-soon / btn). Sidebar SOON badge removed (commit `218d87a`). |
| `src/views/portal_doctor_guide.ejs`       |  173 | Partial-v2 | POLISH   | `doctor.js:1772` | `.dg-*` BEM via `doctor-guide.css` (8× `--dr-*`, 0× `--v2-*`; rest are legacy palette tokens). Linked from v2 topbar help icon. |
| `src/views/portal_doctor_messages.ejs`    |   35 | V2         | OK       | `doctor.js:619` | Stub. 14× `.v2-*` BEM. SOON badge removed (commit `218d87a`). |
| `src/views/portal_doctor_profile.ejs`     | 1293 | V2         | OK       | `doctor.js:1792+` | `.psec` / `.banner` / `.avatar-*` BEM via `doctor-profile.css` (31× `--v2-*`); body uses warm-clinical tokens (`var(--danger)`, `var(--rule)`, `var(--success)`, `var(--font-display)`). 3 hex are warm-clinical brand values (`#0B6B5F`, `#B38B3E`, `#F2E4C7`). |
| `src/views/patient_404.ejs`               |   41 | V2         | OK       | global 404 handler | 4× `partials/patient/*`, 9× `.p-*`. |
| `src/views/patient_500.ejs`               |   56 | V2         | OK       | global 500 handler | 4× `partials/patient/*`, 10× `.p-*`. |
| `src/views/patient_alerts.ejs`            |  163 | V2         | OK       | `patient.js:404` | 3× `partials/patient/*`, 5× `.p-*`. Migrated since `docs/audits/full-portal-chrome-state.md`. |
| `src/views/patient_appointments_list.ejs` |  135 | V2         | OK       | `video.js:1254` (302 from `/portal/patient/appointments`) | 3× `partials/patient/*`, 12× `.p-*`. Migrated in commit `05505c4` since chrome-state.md audit. |
| `src/views/patient_case_report.ejs`       |  355 | V2         | OK       | `reports.js:49` | 8× `partials/patient/*`, 47× `.p-*`. |
| `src/views/patient_dashboard.ejs`         |  434 | V2         | OK       | `patient.js` (`/dashboard`) | 17× `partials/patient/*`, 45× `.p-*`. 14 hex are all warm-clinical token values (`#F8F5EF`, `#0B6B5F`, `#B38B3E`). |
| `src/views/patient_new_case.ejs`         |   866 | V2         | OK       | `patient.js:1336+` (5-step wizard) | 27× `partials/patient/*`, 124× `.p-*`. Hex are warm-clinical (`#B9DDC8`, `#E6C7A8`, `#F2C7C7`, `#FBF9F4`). |
| `src/views/patient_onboarding.ejs`        |  380 | Legacy     | REDESIGN | `onboarding.js:28` | Uses `partials/header { layout: 'portal' }` AND `partials/patient_sidebar.ejs` (legacy patient nav). 0× `.p-*`, 43 hex from medical-blue palette, 4× `--medical-*`. **Borderline auth-adjacent** — runs after signup before portal. Flag for user confirmation if it falls under the "signup" workstream exclusion. |
| `src/views/patient_order.ejs`            |   856 | V2         | OK       | `patient.js` (`/portal/patient/orders/:id`) | 25× `partials/patient/*`, 88× `.p-*`. |
| `src/views/patient_order_upload.ejs`      |  320 | V2         | OK       | `patient.js` | 9× `partials/patient/*`, 29× `.p-*`. |
| `src/views/patient_payment_required.ejs`  |  398 | V2         | OK       | `patient.js` (`/portal/patient/pay/:id`) | 5× `partials/patient/*`, 67× `.p-*`. |
| `src/views/patient_payment_success.ejs`   |  188 | V2         | OK       | `patient.js` | 8× `partials/patient/*`, 16× `.p-*`. |
| `src/views/patient_prescription_detail.ejs`| 111 | V2         | OK       | `prescriptions.js:234` | 3× `partials/patient/*`, 13× `.p-*`. Migrated since chrome-state.md. |
| `src/views/patient_prescriptions.ejs`     |  101 | V2         | OK       | `prescriptions.js:193` | 3× `partials/patient/*`, 12× `.p-*`. Migrated since chrome-state.md. |
| `src/views/patient_profile.ejs`           |  202 | V2         | OK       | `patient.js` (`/patient/profile`) | 5× `partials/patient/*`, 50× `.p-*`. |
| `src/views/patient_records.ejs`           |  268 | V2         | OK       | `medical_records.js:17/111` | 3× `partials/patient/*`, 34× `.p-*`. Migrated since chrome-state.md. |
| `src/views/patient_referrals.ejs`         |  143 | V2         | OK       | `referrals.js:48` | 3× `partials/patient/*`, 12× `.p-*`. Migrated since chrome-state.md. |
| `src/views/patient_review_form.ejs`       |  175 | Partial-v2 | POLISH   | `reviews.js:21` | **Mixed by design**: file header explicitly says "Per brief: keep `.portal-page` / `.portal-page-header` / `.admin-breadcrumb`; only swap inner `.flow-card` → `.p-card`". 5 legacy class hits, 8 hex from legacy semantic palette (`#fee2e2`, `#991b1b`, `#f59e0b`). User decision needed: finish v2 migration or accept hybrid as final state. |
| `src/views/patient_reviews.ejs`           |  120 | V2         | OK       | `reviews.js:293` | 3× `partials/patient/*`, 11× `.p-*`. Migrated since chrome-state.md. |
| `src/views/patient_walkthrough.ejs`       |  859 | Legacy     | REDESIGN | `help.js:25/30` (`/help/patient-walkthrough`) | Uses `partials/header { layout: 'public' }`. 0× `.p-*`, 0× `partials/patient/*`, 151 hex from medical-blue palette (`#2563eb`, `#3b82f6`, `#0f172a`). **Borderline help-content surface** — interactive tutorial, not in patient sidebar; user may consider it more public-marketing-adjacent than portal-adjacent. |
| `src/views/partials/doctor/sidebar.ejs`   |  144 | V2         | OK       | layout-included for doctor frame | 34 v2-marker hits. THIS IS the v2 doctor chrome. Links: today, cases, prescriptions, appointments, analytics, messages, earnings, profile. |
| `src/views/partials/doctor/topbar.ejs`    |   55 | V2         | OK       | every doctor view | 10 v2-marker hits. Bell→alerts, help→guide. |
| `src/views/partials/patient/head.ejs`     |   81 | V2         | OK       | every patient v2 view | 4× `.p-*`. Loads `patient-tokens.css` + `patient-portal-v2.css`. |
| `src/views/partials/patient/foot.ejs`     |  281 | V2         | OK       | every patient v2 view | 25× `.p-*`. |
| `src/views/partials/patient/sidebar.ejs`  |  119 | V2         | OK       | included by `head.ejs` | 16× `.p-*`. THIS IS the v2 patient chrome. |
| `src/views/partials/patient/topbar.ejs`   |   40 | V2         | OK       | included by `head.ejs` | 9× `.p-*`. |
| `src/views/partials/patient/mobile-tabbar.ejs`     |  51 | V2 | OK | mobile patient frame | 4× `.p-*`. |
| `src/views/partials/patient/mobile-more-sheet.ejs` |  71 | V2 | OK | mobile patient frame | 11× `.p-*`. |
| `src/views/partials/patient/notifications-dropdown.ejs` | 41 | V2 | OK | patient topbar | 10× `.p-*`. |
| `src/views/partials/patient/loading-skeleton.ejs`  |  41 | V2 | OK | reusable component | 15× `.p-*`. |
| `src/views/partials/patient/error-state.ejs`       |  39 | V2 | OK | reusable component | 9× `.p-*`. |
| `src/views/partials/patient/network-error.ejs`     |  28 | V2 | OK | reusable component | 2× `.p-*`. |
| `src/views/partials/patient/icon.ejs`              |  49 | V2 | OK | reusable component | 1× `.p-*`. |
| `src/views/partials/patient/file-tile.ejs`         |  28 | V2 | OK | reusable component | 1× `.p-*`. |
| `src/views/partials/patient/doctor-card.ejs`       |  39 | V2 | OK | reusable component | 1× `.p-*`. |
| `src/views/partials/patient/whats-happening-card.ejs`|26 | V2 | OK | reusable component | 1× `.p-*`. |
| `src/views/partials/patient/need-help-card.ejs`    |  21 | V2 | OK | reusable component | 4× `.p-*`. |
| `src/views/partials/patient/reassure-card.ejs`     |  17 | V2 | OK | reusable component | 0× `.p-*` but only 17 lines of helper markup; uses warm-clinical tokens. |
| `src/views/partials/patient/timeline.ejs`          |  17 | V2 | OK | reusable component | 0× `.p-*` but tiny helper. |
| `src/views/partials/patient/progress-track.ejs`    |  28 | V2 | OK | reusable component | 2× `.p-*`. |
| `src/views/partials/header.ejs`           |   10 | n/a (dispatcher) | OK | universal | 10-line layout dispatcher: `public` / `portal` / `auth`. Not a chrome itself. |
| `src/views/partials/footer.ejs`           |  209 | Partial-v2 | POLISH (low priority) | every doctor + many patient views | Universal close-tags + `<footer class="site-footer">` marketing footer (legacy class names, raw hex). Used in portal contexts (closes `</main></div></div>`) AND public pages. Body content visible at the bottom of every doctor portal page. |
| `src/views/partials/doctor_header.ejs`    |   97 | Legacy     | DELETE   | **NONE** (no active loader) | Pre-Phase-1 doctor nav. Replaced by `partials/doctor/sidebar.ejs`. Round-1 audit also flagged for deletion. Confirmed orphaned. |
| `src/views/partials/patient_sidebar.ejs`  |  106 | Legacy     | (DELETE after onboarding migration) | only `patient_onboarding.ejs` (in scope) + several `.bak` files | Legacy patient nav. Cannot delete until `patient_onboarding.ejs` is either migrated or deleted. |
| `src/views/partials/user_menu.ejs`        |   45 | Legacy     | DELETE   | **NONE** (no active loader in non-`.bak` files) | Pre-portal user-menu pill. Orphaned. |

### By bucket

#### V2 (46)

Doctor views (9): `doctor_alerts`,
`doctor_prescription_detail`, `doctor_prescriptions_list`,
`portal_doctor_case`, `portal_doctor_cases`,
`portal_doctor_dashboard`, `portal_doctor_earnings`,
`portal_doctor_messages`, `portal_doctor_profile`.

Patient views (17): `patient_404`, `patient_500`, `patient_alerts`,
`patient_appointments_list`, `patient_case_report`,
`patient_dashboard`, `patient_new_case`, `patient_order`,
`patient_order_upload`, `patient_payment_required`,
`patient_payment_success`, `patient_prescription_detail`,
`patient_prescriptions`, `patient_profile`, `patient_records`,
`patient_referrals`, `patient_reviews`.

Partials (20): `partials/doctor/sidebar`, `partials/doctor/topbar`,
plus all 18 `partials/patient/*.ejs` (chrome: head / foot / sidebar
/ topbar / mobile-tabbar / mobile-more-sheet / notifications-dropdown;
reusable components: loading-skeleton, error-state, network-error,
icon, file-tile, doctor-card, whats-happening-card, need-help-card,
reassure-card, timeline, progress-track). All use `.p-*` BEM and
load via the patient v2 chrome chain.

#### Partial-v2 (8)

| File | What's mixed | Polish needed |
|---|---|---|
| `doctor_analytics.ejs` | v2 chrome, body via `doctor-analytics.css` uses 18× `--dr-*` legacy tokens (rest are legacy palette names). | Re-token `doctor-analytics.css` from `--dr-*` to `--v2-*`; no markup changes. |
| `doctor_appointments.ejs` | `doctor-appointments.css` is 29× `--dr-*` plus legacy palette tokens. | Re-token `doctor-appointments.css`. |
| `doctor_case_intelligence.ejs` | `.ci-*` BEM with **inline** `<style>` block using `--dr-*` + raw hex. | Lift styles into a `doctor-case-intelligence.css`, re-token to `--v2-*`. BETA — confirm scope first. |
| `doctor_prescribe.ejs` | `doctor-prescribe.css` is **explicitly hybrid**: 44× `--v2-*` AND 41× `--dr-*` (CSS file header documents this — `--dr-*` retained on legacy rule blocks; new `.dpx-*` rules use `--v2-*` aliases). | **Low priority**: the page renders correctly because aliases resolve to v2 values. User decision: re-token the legacy half OR leave the hybrid as documented and intentional. |
| `doctor_reviews.ejs` | `doctor-reviews.css` uses 14× `--dr-*` plus legacy palette tokens. | Re-token. Note: this is the public-facing per-doctor reviews page (`/portal/doctor/:doctorId/reviews`); the in-app "my reviews" surface is folded into Profile. |
| `portal_doctor_guide.ejs` | `doctor-guide.css` uses 8× `--dr-*` plus legacy palette tokens. | Re-token. |
| `patient_review_form.ejs` | Hybrid by prior brief: keeps `.portal-page` / `.portal-page-header` / `.admin-breadcrumb` legacy wrappers; inner cards swapped to `.p-*`. | User decision: finish migration (drop legacy wrappers) or accept hybrid as final. |
| `partials/footer.ejs` | Universal close-tags partial; `<footer class="site-footer">` uses legacy class names + raw hex; visible on every doctor portal page bottom. | Tokenize the marketing footer **OR** suppress it in portal contexts (`renderFooter=false` when `usePortalFrame=true`). Low-priority cosmetic. |

#### Legacy (5)

| File | Reachable? | Verdict | Reason |
|---|---|---|---|
| `patient_onboarding.ejs` | yes (`onboarding.js:28`) | REDESIGN (or scope-flag) | Uses legacy chrome + legacy patient sidebar; 43 hex from medical-blue palette. Borderline auth-adjacent (post-signup profile completion). User: confirm whether this falls under the brief's "signup" exclusion. |
| `patient_walkthrough.ejs` | yes (`help.js:25/30`) | REDESIGN (or scope-flag) | 859-line interactive tutorial under `/help/patient-walkthrough`; entirely medical-blue palette (151 hex). Borderline help-content surface. User: confirm whether this is in-portal scope vs help/marketing scope. |
| `partials/doctor_header.ejs` | **no** | DELETE | Replaced by `partials/doctor/sidebar.ejs`; no active loader. |
| `partials/patient_sidebar.ejs` | yes — only by `patient_onboarding.ejs` | DELETE (after onboarding migration) | Legacy patient nav. Co-removable with onboarding's redesign or deletion. |
| `partials/user_menu.ejs` | **no** | DELETE | No active loader in non-`.bak` files. |

### Orphan list (verified — DELETE candidates)

These files are in the in-scope tree, classified Legacy, AND have
**zero active loaders / route renders**:

  1. `src/views/partials/doctor_header.ejs` — pre-Phase-1 doctor nav.
  2. `src/views/partials/user_menu.ejs` — pre-portal user-menu pill.

Conditional orphan (will become a hard orphan after `patient_onboarding`
is redesigned or deleted):

  - `src/views/partials/patient_sidebar.ejs`

### Cross-reference with prior audits

#### vs. Round 1 Task C audit (above, "Audit results — 2026-04-28")

Round 1 used different verdict labels (REDESIGN / DELETE / KEEP-AS-IS)
and only covered 12 doctor files. Mapping its verdicts onto this
audit's bucket / verdict scheme:

| File | Round 1 verdict | This audit | Disagreement? |
|---|---|---|---|
| `doctor_analytics`        | DELETE     | Partial-v2 / POLISH | **YES.** Round 1 said no v2 nav link existed; since then, `/portal/doctor/analytics` has been wired into the v2 sidebar (commit `719db25`). User direction in `CLAUDE_CODE_BRIEF_PHASE2_ROUND2.md` ("rewrite … keep + wire up Analytics/Appointments/Case-Intelligence per user direction") confirms keep. |
| `doctor_appointments`     | DELETE     | Partial-v2 / POLISH | **YES.** Wired into v2 sidebar with SOON badge in commit `2456de0`. Same user direction as above. |
| `doctor_case_intelligence`| KEEP-AS-IS | Partial-v2 / POLISH | Compatible — round 1 said "polish later post-BETA promotion"; this audit's POLISH = same outcome but classified by chrome+body evidence, not BETA status. |
| `doctor_reviews`          | DELETE     | Partial-v2 / POLISH | **YES.** Round 1 noted reviews fold into Profile, but the route at `reviews.js:161` is the **public** per-doctor reviews page (`/portal/doctor/:doctorId/reviews`), which is a public-facing surface, not the in-app "my reviews" page. Different surface than round 1 considered. The other reviews route (`reviews.js:345`) IS a 302 to profile. |
| `portal_doctor_dashboard` | KEEP-AS-IS | V2 / OK | Compatible. |
| `portal_doctor_guide`     | REDESIGN   | Partial-v2 / POLISH | Compatible (mostly): chrome already v2; only token remap on `doctor-guide.css` is needed, not a full redesign. |
| `doctor_login_v2`         | KEEP-AS-IS | (out of scope here — login excluded) | Round 1 covered it; brief excludes auth from this audit. |
| `doctor_pending_approval` | KEEP-AS-IS | (out of scope — auth-adjacent) | Same. |
| `doctor_signup`           | REDESIGN   | (out of scope — signup excluded) | Same. |
| `doctor_signup_submitted` | REDESIGN   | (out of scope — signup excluded) | Same. |
| `portal_doctor_earnings`  | KEEP-AS-IS | V2 / OK | Compatible. |
| `portal_doctor_messages`  | KEEP-AS-IS | V2 / OK | Compatible. |

**Bottom line:** the three round-1 DELETE calls (analytics, appointments, doctor_reviews) are stale. User direction has since been to keep + wire-up Analytics and Appointments, and `doctor_reviews` is the public-facing surface, not the deletable in-app duplicate. **This audit's POLISH calls supersede them.**

#### vs. `docs/audits/full-portal-chrome-state.md` (untracked, in-progress)

That audit (~131 lines, untracked working file) classified the
patient portal as 10/19 v2 + 9 legacy. Eight of its "legacy" patient
files have since been migrated to v2 chrome:

  - `patient_appointments_list`  — migrated in commit `05505c4`
  - `patient_prescriptions`       — migrated since
  - `patient_prescription_detail` — migrated since
  - `patient_records`             — migrated since
  - `patient_referrals`           — migrated since
  - `patient_reviews`             — migrated since
  - `patient_review_form`         — partially migrated (now Partial-v2 by intent)
  - `patient_alerts`              — migrated since

After those migrations land, only **2** patient views remain Legacy
(`patient_onboarding`, `patient_walkthrough`), both reachable but
borderline-scope. Doctor-side findings in chrome-state.md ("0 fully
legacy, 8 mixed") track this audit's "0 Legacy / 6 Partial-v2", same
shape, different labels.

### What this audit answers in 30 seconds

  - **Doctor views still Legacy (chrome OR body):** 0 fully legacy. 6 are Partial-v2 (chrome v2, body / page CSS uses `--dr-*`).
  - **Patient views still Legacy:** 2 (`patient_onboarding`, `patient_walkthrough`). Both reachable. Both borderline-scope.
  - **Orphaned files safe to delete now:** 2 partials (`partials/doctor_header.ejs`, `partials/user_menu.ejs`). 1 conditional (`partials/patient_sidebar.ejs` after onboarding handled).
  - **Reachable Legacy needing redesign (priority order):**
    1. `patient_onboarding.ejs` — confirm scope first (auth-adjacent?), then either redesign onto patient v2 or remove if signup workstream replaces it.
    2. `patient_walkthrough.ejs` — confirm scope first (help-content vs portal?), then either redesign or move to public layout treatment.
  - **Partial-v2 needing token POLISH (6 doctor + 1 patient + 1 partial):** mechanical `--dr-*` → `--v2-*` re-token in 4 page CSS files (`doctor-analytics.css`, `doctor-appointments.css`, `doctor-reviews.css`, `doctor-guide.css`); inline-style lift for `doctor_case_intelligence.ejs`; **low-priority** hybrid cleanup on `doctor-prescribe.css` (44× v2 + 41× dr by design — visually correct via aliases); user decision on `patient_review_form.ejs` and `partials/footer.ejs`.

---

## ✅ Phase 2 round 2 DONE — 2026-04-28

Branch `feat/phase2-round2-cleanup` off `doctor-dashboard-ux`. Brief at
`CLAUDE_CODE_BRIEF_PHASE2_ROUND2.md`. Tasks executed in order D → F →
G → H → I → J → K → L (Task E skipped — see Issues below).

| Task | Commit | One-line summary |
|------|--------|------------------|
| D    | `218d87a` | Remove SOON badges from sidebar Messages + Earnings — both are live features (only Video Consultation is genuinely SOON). |
| F.1  | `719db25` | Wire Analytics into v2 sidebar — adds nav entry + alias map under Work section. |
| F.2  | `d44d2c2` | Redesign Analytics view to v2 chrome — adds topbar partial + `.doctor-analytics-page` wrapper + `_t()` helper. |
| F.3  | `66e301a` | Polish Analytics page — drop redundant in-page title now that the topbar carries it. |
| G.1  | `2456de0` | Wire Appointments into v2 sidebar with SOON badge — adds nav entry under Work, alias map. |
| G.2  | `d54a4ff` | Redesign Appointments view to v2 chrome — topbar + `.doctor-appointments-page` wrapper + `_t()`. |
| G.3  | `0b683fa` | Polish Appointments — drop duplicate in-page title; rehome "Set Availability" CTA via `topbarActions`. |
| H.1  | `be72680` | Wire case-detail Intelligence card to the existing `/doctor/cases/<id>/intelligence` route (no route changes — see Issues). |
| H.2  | `d560f08` | Redesign Intelligence chrome — v2 topbar + `.doctor-case-intelligence-page` wrapper + `_t()` + "Back to case" topbar action. |
| H.3  | `591dbac` | Retint Intelligence content area to v2 tokens — embedded `<style>` rewritten under page-scope; all `.ci-*` class names + JS bindings preserved. |
| H.4  | `720ac02` | Polish Intelligence — drop duplicate in-page title; keep the case-meta strip (Case ID / Patient / Primary Concern / Files / Submitted / Status badge). |
| I    | _no commits_ | `doctor_login_v2.ejs` and `doctor_pending_approval.ejs` already pass the token / inline-handler / bilingual audit clean. Brief criteria: "Skip if file is already clean." |
| J    | `b5cadc7` (doc-only) | `doctor_signup.ejs` + `doctor_signup_submitted.ejs` already shipped as standalone v2-auth pages in commit `026da09` before the round 2 brief was drafted. Logged the staleness; no view changes. |
| K    | `02bcd54` | Redesign Guide page (`portal_doctor_guide.ejs`) to full v2 chrome — topbar + `.doctor-guide-page` wrapper + embedded retint `<style>` overriding `/css/doctor-guide.css` via specificity. |
| L    | `1ece22f` | Add v2-iconbtn alerts (with unseen dot) + help icons to Today's custom hero, before "View Queue". Pattern lifted verbatim from `partials/doctor/topbar.ejs`. |

Plus three audit / bookkeeping commits that landed alongside the work
above:

| Commit | What |
|--------|------|
| `4a9d652` | docs: legacy style audit — doctor + patient portal views (this file's `## Legacy style audit — 2026-04-28` section). |
| `a1ae708` | docs: legacy audit corrections — accurate `--dr-*` counts + reclassify prescribe. |
| `68d8998` | docs: log 3 audit skip decisions in Phase 2 backlog out-of-scope section. |

### Issues discovered during round 2 (logged inline above; recapped here)

- **Task E was not executed in round 2.** Brief asked to delete
  `doctor_reviews.ejs` and 302-redirect any route at
  `/portal/doctor/reviews` to the profile (since profile shows reviews
  inline). User's resume instruction at session start was "Continue
  with G.2, G.3, then H, I, J, K" — E was already skipped in the 5
  commits made before this session and was not picked back up. As of
  this commit: `src/views/doctor_reviews.ejs` still on disk;
  `src/routes/reviews.js` still mounts a route. **Action:** carry E
  forward into round 3 or whatever follow-up branch handles it.
- **Task H route-pattern mismatch.** Brief expected the destination at
  `/portal/doctor/case/<id>/intelligence` but the actual handler at
  `src/routes/doctor.js:1345` is mounted at
  `/doctor/cases/<id>/intelligence` (no `/portal/` prefix; plural
  `cases`). User confirmed: wire to the existing URL, no route
  changes. The case-detail card link in `portal_doctor_case.ejs`
  reflects this resolved URL.
- **Task J brief was stale.** Brief said `doctor_signup.ejs` (171
  lines) + `doctor_signup_submitted.ejs` (55 lines) needed full v2
  redesign. Actual files are 97 / 31 lines and already standalone
  v2-auth pages — same chrome as `doctor_login_v2.ejs` (which Task I
  audited clean). The portal-wide chrome audit at
  `docs/audits/full-portal-chrome-state.md:69-70` already records
  both as **v2** with the rewrite traced to commit `026da09`. Logged
  in `b5cadc7` so a future audit pass does not re-investigate this.
- **Task L scope discovery (NEW task added during round 2).** The
  Today page (`portal_doctor_dashboard.ejs`) uses a custom
  `.dd-header` greeting hero rather than the `partials/doctor/topbar`
  partial, so it never inherited the topbar's standard bell + help
  iconbtns. Doctors had no reachable path to `/portal/doctor/guide`
  from Today. User direction: keep the custom hero (its "X cases
  need your attention today" copy is genuinely different from what
  the topbar partial supports), just add the missing icons inline.
  Resolved in commit `1ece22f`.

### Round 2 verification status

All commits passed EJS compile-check. All routes returned 302 to
`/login` on curl smoke (auth guard intact). Browser end-to-end
verification of the warm-clinical visual treatment is the user's
responsibility per the brief — call out anything that lands wrong on
review and a polish commit can target it.

---

## ✅ Cleanup pass — 2026-04-28

Branch `feat/cleanup-orphan-and-comment` off `main` (which now carries
all of round 1 + round 2). Two findings from a portal-wide v2/legacy
audit that the round 2 work did not touch.

| Task | Commit | One-line summary |
|------|--------|------------------|
| T1   | `35ae4a6` | chore(patient): remove orphaned patient_order_new.ejs + dead render helper. The 203-line legacy view and its 6-line `renderPatientOrderNew()` helper at `src/routes/patient.js:75` had zero call sites (canonical surface is now `patient_new_case.ejs`). 2 files changed, 208 deletions, no insertions. |
| T2   | `39e4d12` | chore(doctor): fix stale `--medical-blue` reference in analytics legend comment. The Chart.js color legend at `src/views/doctor_analytics.ejs:158` still claimed the COLORS array entries were "resolved equivalents" of pre-v2 tokens (`--medical-blue`, `--accent-teal`, etc.) — misleading after the v2 migration. Replaced with an explicit note that the hexes are intentional chart-only literals, NOT bound to `--v2-*` tokens. Comment-only edit; the COLORS array literal is byte-for-byte identical, zero visual diff. |

Both commits passed EJS compile / `node --check` / require-time load
and 302 curl smoke (auth guard intact). No route changes, no schema
changes — strictly dead-code removal + comment correction.

---

## ✅ Done (Phase 1 — for reference)

- Patient portal: all 11 surfaces migrated
- Doctor portal: profile, prescribe form, prescriptions list + detail, alerts, case detail with shortcuts
- Photo upload (R2-backed, signed URL)
- Commission split corrected to 20%/80%
- Sidebar IA (Today / Cases / Prescriptions / Messages / Earnings / Profile)
- All work shipped in PR merging `feat/doctor-portal-v2-warm-clinical` to `main` (52 commits)

## 🔍 Visual audit findings — 2026-04-28 (post-merge screenshot review)

After merging the sidebar Alerts + CSS retint PR, Ziad sent screenshots of every doctor-facing surface for a final visual sweep. Issues caught, in priority order. Tackle these AFTER the bell dropdown ships.

### High priority

1. **Analytics charts are bright blue (`#2563eb` family)** — every other doctor surface is warm-clinical, but the bar chart (Monthly Revenue) and donut chart (Cases by Specialty) on `/portal/doctor/analytics` are still bright blue. Chart.js or whichever library renders them isn't reading the v2 tokens. Highest priority — only doctor surface that breaks the design system. Effort: 1–2 hrs (fix chart color config to use `--v2-brand` / `--v2-accent` / `--v2-warn` etc.).

2. **Status pills use blue for `assigned` and `reassigned`** — Recent Cases table on Analytics page shows status pills in blue (assigned, reassigned), amber (expired_unpaid), red (breached), green (completed). The blue pills clash with the warm-clinical palette. Should be brand-tinted (teal) or neutral. Effort: 30 min.

3. **Frequency dropdown is free text + Duration field has no unit** — Write Prescription form: Frequency input accepts free text ("Once daily") instead of being a structured select (Once daily / Twice daily / TID / QID / PRN / etc.). Duration field accepts a number (e.g. "3") with no unit specified — days? weeks? months? Clinical safety risk: prescriptions could end up inconsistent across doctors. Effort: 1 hr (add structured select for frequency, add unit dropdown next to duration).

### Medium priority

4. **`&rarr;` HTML entity rendering as literal text** — "View all &rarr;" appears on Today page (New Assignments, In Review, Completed, Recent Alerts sections). The EJS template has the literal string `&rarr;` which gets escaped by EJS's `<%=` instead of rendered as the arrow. Fix: use `<%-` or replace with `→` literal. Effort: 10 min.

5. **Cases row: triple urgency signaling** — One overdue case shows: red left border bar + pink avatar + red dot + OVERDUE pill + "overdue 2424h" text. Five urgency signals on a single row. Pick one or two; visual noise otherwise. Effort: 30 min.

6. **Case detail page: 36-char UUID as page heading** — `Case #724e92bd-40cf-42c0-ab44-1c6d5e6ca832` is the page H1. Ugly and unscannable. Truncate to `Case #724E92BD…` with the full ID accessible via tooltip or "Copy ID" button. Effort: 15 min.

7. **"Active case" subtitle on case detail is blue** — sticks out as the only blue element on the page. Should be brand-tinted or neutral. Effort: 5 min.

8. **Sub-specialty chips are lowercase** — Profile page shows `ear and throat` as a chip, lowercased. The autocomplete data file (`profile-autocomplete-data.js`) supplies title-case values — something is normalizing on save. Check the chip-add JS or the server-side persist path. Effort: 30 min.

9. **"Custom" refills selected but no input visible** — Write Prescription form, Refills section, "Custom" is selected and shows "Patient may refill this prescription 4 times" — but the input field for the "4" is missing from the UI (or hidden). Either the input should be visible when Custom is selected, or the "4" came from somewhere unexpected. Effort: 15 min.

10. **"Saved at 20:08" needs success state** — autosave indicator on Write Prescription is in muted gray, easy to miss. Should be brand-green when saved (success state). Same on Profile's "All up to date" indicator. Effort: 5 min.

### Low priority (cosmetic)

11. **"1 cases" pluralization** — Cases page subtitle: `1 cases · sorted by SLA urgency` should be `1 case`. Fix EJS conditional. Effort: 5 min.

12. **"Patient" as a name** — Case detail page shows the patient name as literally "Patient" (a placeholder). Should show the real name from patient record, or "Anonymous patient" if redacted by privacy settings. Likely a demo-data artefact. Effort: 15 min (verify, then fix).

13. **Demo data: "Shifa Hopsital" typo** — Profile → Hospital affiliations → "Shifa Hopsital" (should be "Shifa Hospital"). Demo seed data only; real users won't hit this. Effort: 5 min if you want to fix the seed.

14. **Native file input on prescription signature attach** — `<input type="file">` styled by the browser, looks crude next to the rest of the v2 form. Should be a styled drop-zone matching the signature upload pattern in Profile. Effort: 30 min.

15. **AR tab red dot on Bio field** — good UX (signals incomplete translation) but the dot is small and unlabelled. Add tooltip or short label "needs translation". Effort: 10 min.

16. **"Preview as patient →" button visual weight** — on Profile, this is the most useful action (lets doctor see what patients see) but rendered as a hollow ghost button next to "Save changes" (filled green). Should be heavier visually. Effort: 5 min.

### Total estimate

Roughly 5–7 hours of focused work to clear all 16 items. Tackle in priority groups: high (items 1–3, ~3 hrs), medium (items 4–10, ~2 hrs), low (items 11–16, ~1.5 hrs). Each group is its own focused session.

Logged for after the bell dropdown task.

---

## Alerts surface — IA decision (2026-04-28)

Logged on completion of `feat/alerts-bell-dropdown` (Tasks A–D). The
"Functionality gaps" item at line 43 ("Topbar bell dropdown to replace
doctor alerts page") originally framed the dropdown as a **replacement**
for the standalone alerts page. After building the dropdown the
architectural decision is **two complementary surfaces, not a
replacement**:

- **Bell dropdown (`partials/doctor/bell.ejs`, opened from the topbar
  bell on every doctor portal page)** — primary alerts surface for
  recent / unseen activity. Top 8 most recent rows; dot + count badge
  on the bell; "Mark all as read" + "View all alerts →" footer.
  Polled for count every 60s while the tab is visible. This is the
  notification UX, intended for in-flow glance + dismiss.

- **Standalone `/portal/doctor/alerts` (`src/views/doctor_alerts.ejs`)** —
  history / archive surface. Full list (50 most recent), denser layout,
  full case + timestamp metadata per row, marks all-as-read on view.
  Linked from two places:
    1. The dropdown's "View all alerts →" footer.
    2. The sidebar **Alerts** item (added during Round 2, kept on
       purpose — it's the deeper-dive entry, complementary to the bell).
  Intended for "what happened recently?" / triage / catch-up reading.

**Both surfaces stay. They serve different jobs.** The bell is for
notification UX (glance, act, dismiss); the standalone page is for
review UX (scan history, find a specific alert, audit).

Implementation note: the dropdown's friendly title + body mapping is
client-side in `bell.ejs` (mirrors `doctor_alerts.ejs`'s `humanTitle()`
EN+AR strings). Both surfaces should keep that mapping in lockstep —
when a new notification template ships, add it to **both** files.
Logged here so it's not forgotten.

The Functionality-gaps line "Topbar bell dropdown to replace doctor
alerts page" is now resolved — verbiage was inaccurate ("replace");
the actual outcome is "complement". Marked done in the Phase 2 round 3
delivery log when round 3 closes.

---

## Medication learning loop — 2026-04-29

Logged on completion of `fix/prescription-form-bugs` Bug 2. Documents
why the prescription form's medication name field is intentionally a
free-text input instead of an autocomplete-backed picker, and how the
data we collect from real prescriptions becomes the foundation for a
future ML-driven medication recommendation feature.

### The decision: free text, not autocomplete

We considered shipping a curated ~150-entry medication dictionary
(Egyptian-market-aligned, generics + brand names + strengths) and
wiring a typeahead like the profile-page sub-specialty autocomplete.
Rejected for three reasons:

1. **List accuracy is unverifiable without doctor review of every
   entry.** Brand names rotate (rebrands, generics expiring, regional
   availability), strengths vary per manufacturer, Egyptian-market
   specifics aren't reliably knowable from training data. A list with
   even a 10% error rate undermines doctor trust on the
   highest-stakes form in the product.

2. **A short list creates negative UX.** The earlier inline
   `__DPX_MED_SUGGESTIONS__` carried 25 cardiology-only entries.
   Doctors prescribing outside cardiology — or even within
   cardiology but using Egyptian brand names like Concor, Pantoloc,
   Co-Tareg — typed something the list didn't have and saw "No match
   — you can type a custom name." The autocomplete *looked* broken
   even though it was working as designed. Removed in commit 40ed5f3.

3. **Real prescriptions are a richer signal than a curated list.**
   Doctors prescribing for real patients generate the most valuable
   training data possible: the literal medication string they trust
   for a specific diagnosis in a specific specialty. That data
   compounds — every signed prescription strengthens the model.

### The log table — `prescribed_medications_log`

Created in migration `025_prescribed_medications_log.sql` (commit
daa69b7). Append-only, one row per medication entry per signed
prescription. Schema fields (TEXT primary keys to match the existing
`prescriptions`/`users` convention, `TIMESTAMP DEFAULT NOW()` for
created_at):

| Column                | Purpose                                       |
|-----------------------|-----------------------------------------------|
| `id`                  | UUID, generated by route via `randomUUID()`   |
| `prescription_id`     | FK to `prescriptions.id` (ON DELETE CASCADE)  |
| `doctor_id`           | TEXT FK to `users.id` (no DB constraint)      |
| `case_id`             | The order/case this prescription is on        |
| `diagnosis_text`      | Free-text diagnosis the doctor entered        |
| `specialty`           | Denormalized at write — doctor's specialty   |
| `medication_name_raw` | Literal string the doctor typed — no normalization |
| `dosage`              | Free text (e.g. "500mg")                      |
| `frequency`           | Selected option (e.g. "Twice daily / BID")    |
| `duration`            | Combined value+unit string (e.g. "7 days")    |
| `instructions`        | Per-medication instructions, if entered       |
| `created_at`          | TIMESTAMP DEFAULT NOW()                       |

Indexes target the three most likely analytical filter axes:
`specialty` (per-specialty pattern mining), `doctor_id` (per-doctor
prescribing profile), `created_at` (time-windowed cohorts).

The insert is wired in the prescription submit handler at
`src/routes/prescriptions.js` POST
`/portal/doctor/case/:caseId/prescribe`, after the prescriptions
INSERT, wrapped in try/catch so a logging failure never blocks the
user-visible prescription path. The same defensive pattern as the
existing medical_records auto-import.

**No write-time normalization.** The literal string the doctor typed
is stored verbatim. Brand-vs-generic deduping, fuzzy matching
("Augmentin" → Amoxicillin-Clavulanate), strength parsing, dictionary
alignment — all happen at *read* time when the data feeds the ML
pipeline. This keeps the write path cheap and preserves the original
signal in case our normalization heuristics are wrong.

### Future use cases

The data this table accumulates underpins several product features:

1. **Medication recommendations by diagnosis.** Given a diagnosis
   `D` in specialty `S`, surface the top medications other doctors
   in `S` prescribed for similar `D`. Surfaces as inline hints on the
   prescribe form ("doctors in Cardiology most commonly prescribe X
   for this kind of presentation"). Foundation for a doctor-assist
   feature, never a doctor-replace feature.

2. **Brand-vs-generic preference patterns.** Egyptian-market doctors
   prescribe differently from textbook generics (e.g. Concor vs
   bisoprolol). Patterns by specialty / region / hospital affiliation
   inform formulary partnerships and pricing.

3. **Per-specialty prescribing norms.** What does a "typical"
   cardiology prescription look like vs a typical pediatrics
   prescription? Foundation for QA dashboards and onboarding /
   education materials.

4. **Off-protocol anomaly detection.** Flag prescriptions that look
   unusual relative to the specialty/diagnosis cohort — wrong drug
   for indication, dose outside typical range, frequency unusual.
   Surfaces to a clinical-review queue (not auto-rejected; doctor
   override possible). Improves clinical safety without paternalism.

5. **Doctor-level prescribing profile.** For a given doctor, what's
   their prescribing footprint? Drives the verification pass during
   doctor onboarding and surfaces to the doctor's own analytics page
   ("you prescribe X 30% more than the specialty median — here's
   why that might be").

### Privacy and access

- **Internal-only.** This table is never read or filtered from any
  patient-facing or doctor-facing view. Not exposed via any API
  endpoint. Used exclusively for product/ML offline analysis.
- **No patient identifiers in the log itself** beyond `case_id`
  (which only resolves to the patient via the orders table, accessible
  only to internal staff). The doctor's own prescriptions are
  obviously linked to them via `doctor_id` — that's intentional, and
  visible to the doctor when surfaced in their own prescribing
  profile (use case 5 above) or aggregated with peers (use cases
  1-4).
- **Forward-only.** Rows are written from the next prescription
  signed after the migration runs. Existing prescriptions are not
  backfilled — the data we collect is only data produced under the
  new logging path, with full context.
- **Retention.** No deletion policy in this commit. ON DELETE CASCADE
  on `prescription_id` means deleting a prescription removes its log
  rows — that's the only purge path. A formal retention policy
  (e.g. K-anonymized aggregate after N years, raw rows pruned) is a
  follow-up product call once the volume justifies it.

### Implementation references

- Migration: `src/migrations/025_prescribed_medications_log.sql`
- Insert: `src/routes/prescriptions.js` POST handler at
  `/portal/doctor/case/:caseId/prescribe` — search for the comment
  "Future ML feed".
- Free-text input: `src/views/doctor_prescribe.ejs` — the autocomplete
  wiring was removed in commit 40ed5f3.
- Frequency / duration structured values: shipped in commit 93ac343
  (visual audit Item 3) — the structured form values feed the log's
  `frequency` and `duration` columns directly.

---

## ✅ Visual audit fixes DONE — 2026-04-29

Items 4-16 of the post-merge screenshot review (Group 2 medium-priority
+ Group 3 low-priority). Items 1-3 shipped earlier on the same branch
(d54ba12, 499f09e, 93ac343). Bugs 1, 3, and 2 (3 steps) shipped on
`fix/prescription-form-bugs` and merged to main between rounds.

| Item | Commit  | Summary |
|------|---------|---------|
|  4   | `6699ad9` | Replace `&rarr;` / `&larr;` HTML entities with literal `→` / `←` chars across `portal_doctor_dashboard.ejs` (5 broken sites inside `<%=`), `patient_prescription_detail.ejs`, `patient_onboarding.ejs`, `messages.ejs`. |
|  5   | `072619c` | Cases row triple urgency — kept red left border + "overdue Xh" copy; dropped rose avatar bg, red SLA dot, and OVERDUE chip on urgent rows. Non-urgent dots / chips still render. |
|  6   | `972c81d` | Case-detail H1 / topbar title truncated to short 8-char UUID + ellipsis. Full UUID exposed via a 14px clipboard iconbtn on the meta strip. Copy via `navigator.clipboard.writeText` with `execCommand` fallback; brief "Copied!" toast (1.4s, EN/AR). |
|  7   | `8f3ef32` | Investigation found no blue rule on `.v2-topbar__sub` or `.v2-case-header__sub` — both already `var(--v2-muted)`. Defensive `!important` lock added so any future rule that re-tints the subtitle is blocked. |
|  8   | `f60cf1b` | Sub-specialty chips: save / commit / render path verified to preserve case as stored. Defensive `text-transform: none` lock added on `.chipset__item` so future stylesheets can't lowercase / uppercase chips. Existing DB rows untouched per brief. |
|  9   | `1e6f048` | Empty audit-trail commit — Custom refills input visibility was already fixed in `b403e08` on the prescription-form-bugs branch (now merged to main). No new code change. |
| 10   | `3c01ca3` | Autosave indicator success-tint when saved. Profile sticky save bar uses `:has(.save-bar__dot.saved)` to color the parent status copy `--success`. Prescribe form gets a v2-scoped override that retoks the `.dpx-autosave.is-saved` colors to `--v2-success` / `--v2-success-bg`. |
| 11   | `4e1b629` | Cases topbar subtitle pluralization — `1 case` vs `2 cases`. AR forks to `حالة` for 1, `حالات` otherwise. TODO comment flags the simplified Arabic plural rule for the eventual i18n helper. |
| 12   | `92570f5` | Case detail patient-name fallback. When `_order.patient_name` is missing or matches the literal "Patient" / "مريض" demo placeholder, the helper returns "Anonymous patient" / "مريض مجهول الهوية". Render-side fix; no schema change. |
| 13   | `c0d859a` | Empty audit-trail commit — `scripts/seed_demo_doctor.js` already spells "Shifa Hospital El Tagamoa" correctly. The "Hopsital" the reporter saw must live in stored DB rows from an earlier seed run. Per brief, no migration; demo data wiped at launch. |
| 14   | `5e3f821` | Native file input on prescription signature attach replaced with a v2 drop-zone. Native input visually hidden via sr-only positioning (still focusable + form-attached); `<label for>` wraps an upload-icon SVG + EN/AR label + hint + "Choose file" CTA pill. Hover transitions to `--medical-blue` / `--surface-blue`. JS shows the picked filename below the zone after change. |
| 15   | `15533af` | Bio AR tab indicator dot relabelled "Translation needed" / "ترجمة مطلوبة" via `title` + `aria-label` + `role="img"`. EN tab dot stays "Not filled" — source language, not a translation gap. |
| 16   | `38a59d2` | "Preview as patient → " bumped from `btn--ghost` to `btn--brass`. Now reads as a peer action of equal weight to the brand-teal Save button — brass distinguishes "different action class" (verify) from "commit changes" (save). Discard stays text-only. |

### What's NOT in this round

- **Inline override removal** for `doctor_analytics.ejs` /
  `doctor_appointments.ejs` / `doctor_case_intelligence.ejs` /
  `portal_doctor_guide.ejs` — the brief explicitly said to leave the
  embedded `<style>` blocks in place for one round of visual
  verification after the legacy CSS retints land. Separate follow-up
  branch should remove them once the user signs off on visuals.

- **Sub-specialty / Hopsital DB cleanup** — items 8 and 13 surfaced
  stale demo-data rows that don't matter for production (data is
  wiped at launch). No migrations written.

### Round 2 verification status

All 13 commits passed EJS compile-check and curl smoke (302 to
`/login` from every changed page). Browser end-to-end verification of
the warm-clinical visual treatment is the user's responsibility per
the brief — call out anything that lands wrong on review and a polish
commit can target it.

---

## 📌 Phase 6 follow-up — pre-7am broadcast for waited-Urgent cases

Filed 2026-04-29 during the payout & urgency policy implementation
(branch `feat/payout-policy-fix`).

When a patient submits an Urgent case outside the 7am-7pm Cairo
window and picks **"Wait & treat as Urgent"** on the urgency-conflict
page, the order is stamped with the next-7am-Cairo deadline-anchor
but the doctor broadcast still fires immediately on payment
confirmation (per `src/notify/broadcast.js`'s
`broadcastOrderToSpecialty`). That means doctors get the WhatsApp
push at, say, 2am, see an Urgent case sitting in their queue, and
can accept it well before the patient's 7am clock starts.

That's not strictly wrong — the doctor has more lead time, the
patient still gets their 4-hour SLA from 7am — but it does mean
the "we won't bother doctors until 7am" UX promise on the
conflict page is implicit, not enforced.

**If patient feedback indicates they expect strict 7am-or-later
doctor engagement**, gate the broadcast: `urgency_tier='urgent' AND
acceptance_deadline_at` set to a future-morning timestamp ⇒ defer
the broadcast call to a one-shot job that fires at next-7am-Cairo
instead of immediately. Re-uses the existing `case_sla_worker` /
queue-notification infrastructure; no schema change.

Out of scope for the current PR — track here as a Phase 6
optimisation pending real-world signal.

---

## #96 RESOLVED-PARTIAL — Theme 14 Phase 5 manual queue (2026-05-19)

Phase 5 Commit 1 (`d821d82`) shipped the queue infrastructure +
list surface:

- `routes/patient.js` writes `orders.assignment_status='manual_queue'`
  when the Step-2 classifier returns confidence below the live
  `minimum` threshold (default 0.55, tunable via
  `/superadmin/settings`). Closes Gap 5 — Phases 1-4 logged
  predictions but never wrote the assignment_status, leaving the
  queue effectively unreachable in production.
- `auto_assign.js` and `notify/broadcast.js` short-circuit on
  `manual_queue` so the un-triaged state can't be silently
  overwritten by post-payment auto-routing or doctor broadcast.
- `GET /superadmin/manual-queue` list page (FIFO sort, LATERAL
  join to latest `specialty_classifications` row) + sidebar link
  in Cases group + dashboard attention item. Bilingual EN/AR.
- Migration 065: additive partial index on
  `orders(assignment_status) WHERE assignment_status='manual_queue'`
  to keep the list query index-only as volume grows.

### Still pending under #96

- **Commit 2 (next)**: detail page at
  `/superadmin/manual-queue/:id` with cascade-filtered
  specialty + service pickers, optional doctor-picker toggle,
  `POST /approve` + `POST /mark-unsuitable` (latter triggers
  existing refund flow), `case_routing_updated` bilingual
  notification template wired into all 4 registries, audit
  writes to `specialty_classification_overrides` +
  `order_events` + admin audit log.
- **Commit 3**: seed script
  (`scripts/seed-manual-queue.js --i-really-mean-it`, `is_demo=true`)
  for QA test data.
- **Phase 5b (separate session)**: SLA tracking on
  manual_queue state, tier-aware breach detection, email +
  WhatsApp alerting for stale-queue cases.
