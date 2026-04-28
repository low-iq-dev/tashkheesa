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

---

## 📝 Issues discovered during Phase 2 (log as we go)

*Add any bug, regression, or scope discovery here. Format:*

```
- [YYYY-MM-DD] Issue description. Severity. Resolution / commit SHA when fixed.
```

- [2026-04-28] **`portal_doctor_dashboard.ejs` IS the live "Today" page.** The Phase 2 Backlog (this file, `🔴 Legacy pages` table) said "Today replaces this in v2 IA; almost certainly hard-delete". That's wrong — `src/routes/doctor.js:127` aliases both `/portal/doctor/today` AND `/portal/doctor/dashboard` to the same handler, which renders `portal_doctor_dashboard.ejs`. The file is the current v2 Today surface, NOT a legacy artifact. KEEP-AS-IS, optional rename only. Severity: low (audit-time correction, no behavioural impact).
- [2026-04-28] **`partials/doctor_header.ejs` is a legacy nav partial still on disk.** Surfaces only the legacy `queue / completed / reviews / analytics / alerts` links, not the v2 sidebar IA. Currently includes hrefs to two surfaces that no longer have files (`/portal/doctor/queue` and `/portal/doctor/completed` resolve to `portal_doctor_cases` per `docs/audits/full-portal-chrome-state.md`). Not loaded by any v2 view. Candidate for deletion in a future cleanup pass — out of scope for Phase 2 audit (the audit covers `src/views/` only). Severity: low, cosmetic.

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

## ✅ Done (Phase 1 — for reference)

- Patient portal: all 11 surfaces migrated
- Doctor portal: profile, prescribe form, prescriptions list + detail, alerts, case detail with shortcuts
- Photo upload (R2-backed, signed URL)
- Commission split corrected to 20%/80%
- Sidebar IA (Today / Cases / Prescriptions / Messages / Earnings / Profile)
- All work shipped in PR merging `feat/doctor-portal-v2-warm-clinical` to `main` (52 commits)
