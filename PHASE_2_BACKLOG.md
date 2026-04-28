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

*(none yet — this section grows as we work)*

---

## ✅ Done (Phase 1 — for reference)

- Patient portal: all 11 surfaces migrated
- Doctor portal: profile, prescribe form, prescriptions list + detail, alerts, case detail with shortcuts
- Photo upload (R2-backed, signed URL)
- Commission split corrected to 20%/80%
- Sidebar IA (Today / Cases / Prescriptions / Messages / Earnings / Profile)
- All work shipped in PR merging `feat/doctor-portal-v2-warm-clinical` to `main` (52 commits)
