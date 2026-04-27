# Claude Code Brief — Patient + Doctor Portal Migration (Phase 4)

**Created:** April 27, 2026
**Branch:** `feat/doctor-portal-v2-warm-clinical`
**Last commit before this brief:** `688cc98` (orphan deletes)

---

## Context (read this first)

You are continuing a portal-style-cleanup project. Previous Claude session (in claude.ai) already did:

1. **Token additions** (`portal-variables.css`) — added missing `--v2-*` type/spacing/lh/tracking tokens. Commit `d77607e`.
2. **Layout cleanup** (`portal.ejs`) — `admin-styles.css` and `owner-styles.css` now load only for admin/superadmin frames. Commit `d77607e`.
3. **Palette override** (`doctor-portal-v2.css`) — appended a body-class-scoped block that rebinds legacy `--medical-blue`, `--deep-blue`, `--admin-blue` to v2 teal under `body.doctor-theme` and `body.patient-theme`. Commit `d77607e`.
4. **Pattern proven** — `patient_alerts.ejs` migrated to v2 chrome as the reference implementation. Commit `d1fc48f`.
5. **Orphans deleted** — `doctor_profile.ejs`, `portal_doctor_completed.ejs`, `portal_doctor_queue.ejs` removed. Commit `688cc98`.

Backups live alongside the originals as `.bak` files. Do not delete them; they'll be removed in a final cleanup commit after deployment.

**Repo audit reference:** `docs/audits/full-portal-chrome-state.md` is the source of truth for which view goes with which route.

**User goal:** every page on both portals matches the same warm-clinical style; no legacy-blue chrome leaks; all features visible and easy to access; pipelines work; routes wired correctly. The user is non-technical and reviews via screenshots, not by reading diffs.

---

## Your scope (what to do, in order)

### Task 1 — Migrate the remaining 7 legacy patient views to v2 chrome

Apply the same transformation that was used on `patient_alerts.ejs` (commit `d1fc48f` is the reference) to these 7 files:

| File | Route | Sidebar `active` key |
|---|---|---|
| `src/views/patient_records.ejs` | `/portal/patient/records` | `records` |
| `src/views/patient_referrals.ejs` | `/portal/patient/referrals` | `referrals` |
| `src/views/patient_reviews.ejs` | `/portal/patient/reviews` | `reviews` |
| `src/views/patient_review_form.ejs` | `/portal/patient/case/:id/review` | `reviews` |
| `src/views/patient_prescriptions.ejs` | `/portal/patient/prescriptions` | `prescriptions` |
| `src/views/patient_prescription_detail.ejs` | `/portal/patient/prescription/:id` | `prescriptions` |
| `src/views/patient_appointments_list.ejs` | `/portal/video/appointments` | `appointments` |

**Migration recipe:**

1. Backup first: `cp src/views/X.ejs src/views/X.ejs.bak`
2. Replace the opening `include('partials/header', { layout: 'portal', ... })` with:
   ```ejs
   <%- include('partials/patient/head', {
     active: '<KEY>',
     title: L('English title', 'العنوان العربي'),
     user: (typeof user !== 'undefined' ? user : {}),
     lang: __lang,
     bodyClass: 'p-page-<KEY>'
   }) %>

   <%- include('partials/patient/topbar', {
     title: L('English title', 'العنوان العربي'),
     sub:   L('English subtitle.', 'العنوان الفرعي.'),
     serif: false,
     isAr:  __isAr,
     hideBell: <true if this surface IS the alerts page; false everywhere else>
   }) %>
   ```
3. **Delete** the entire `<div class="portal-shell"> ... <main class="portal-content">` wrapper. The `head.ejs` partial already opens `<main class="p-main">`. Just place the page content directly.
4. **Delete** the `include('partials/patient_sidebar', ...)` line — `head.ejs` includes `partials/patient/sidebar` itself.
5. **Delete** the legacy `<div class="portal-hero">` block — the topbar partial replaces it. If the page had hero action buttons (e.g. "+ Add Record"), pass them to topbar via the `actions` local (pre-rendered HTML string).
6. Replace the closing `<%- include('partials/footer', ...) %>` with `<%- include('partials/patient/foot', { active: '<KEY>', isAr: __isAr }) %>`.
7. Token replacements throughout the body:
   - `var(--p1-primary)` → `var(--primary)`
   - `var(--p1-primary-dark)` → `var(--primary-dark)`
   - `var(--p1-primary-light)` → `var(--primary-light)`
   - `var(--p1-accent)` → `var(--accent)`
   - `var(--p1-accent-light)` → `var(--accent-light)`
   - `var(--p1-text)` → `var(--ink)`
   - `var(--p1-text2)` → `var(--ink-2)`
   - `var(--p1-text3)` → `var(--muted)`
   - `var(--p1-warn)` → `var(--warn)`
   - `var(--p1-warn-light)` → `var(--warn-bg)`
   - `var(--p1-danger)` → `var(--danger)`
   - `var(--p1-border)` → `var(--rule)`
   - `var(--p1-surface)` → `var(--surface)`
   - `var(--p1-r)` → `var(--r-lg)`
   - `var(--p1-rs)` → `var(--r-sm)`
   - `var(--p1-shadow-hover)` → `var(--shadow-3)`
8. Class replacements:
   - `.flow-card` → `.p-card` (and add `padding:18px;` inline if the original used custom padding)
   - `.section-head` → keep as is or replace with `.p-card__header` if simple; use judgment
   - `.section-title` → keep as is for now (it's defined in `patient-portal.css` which still loads)
   - `.status-badge.status-submitted` → `.p-chip.p-chip--info`
   - `.status-badge.status-completed` → `.p-chip.p-chip--teal`
   - `.status-badge.status-pending` → `.p-chip.p-chip--brass`
   - `.p-btn.p-btn-primary` → `.p-btn.p-btn--primary`  (note the double-dash BEM)
   - `.p-btn.p-btn-secondary` → `.p-btn.p-btn--secondary`
   - `.p-btn.p-btn-ghost` → `.p-btn.p-btn--ghost`
   - `.p-btn.p-btn-sm` → `.p-btn.p-btn--sm`
   - `.p-btn.p-btn-lg` → `.p-btn.p-btn--lg`
9. **Preserve all behaviour:** form actions, fetch URLs, CSRF tokens, locals contracts, modal logic, scripts. Don't refactor JavaScript.
10. **Preserve emoji icons in records/referrals** for now — they were in the original. The brand brief says "no emoji" but switching to Lucide icons is a separate task; preserving the existing emoji keeps this PR focused on chrome.

**Per-file gotchas:**

- **`patient_records.ejs`** — has a modal (`.modal-overlay`, `.modal-box`). Keep the modal styles in the `<style>` block but update its CSS variables (e.g. `--p1-surface` → `--surface`). Has emoji record-type icons; keep them. Has a `<table>` — leave it alone (legacy table styles still apply for now).
- **`patient_referrals.ejs`** — has a stat-card grid (`.portal-stats`). Keep it; legacy stat-card styles still load.
- **`patient_reviews.ejs`** — has nested cards (pending + submitted sections). Map each `.flow-card` to `.p-card`.
- **`patient_review_form.ejs`** — uses `.portal-page` and `.portal-page-header` and `.admin-breadcrumb`. Keep these wrappers; they're rendered by legacy CSS that still loads. Replace only the inner `.flow-card`.
- **`patient_prescriptions.ejs`** + **`patient_prescription_detail.ejs`** — read them carefully; some routes go through `/portal/patient/...` and others may have unusual locals.
- **`patient_appointments_list.ejs`** — this is the one rendered by `src/routes/video.js:1218` after a 302 from `/portal/patient/appointments`. The `active` sidebar key should be `appointments`. Verify the sidebar has an `appointments` entry; if not, fall back to `dashboard`.

**Commit each migration as its own commit** with message format:
```
feat(patient): migrate <view_name> to v2 chrome

<3-5 lines summarising what changed and what was preserved>
```

After each commit, **restart the dev server** (`npm run dev`) and **curl the route** to confirm it returns 302 (auth redirect) not 500.

If you encounter a view where the migration isn't mechanical (e.g. heavy custom UI that doesn't map cleanly onto `.p-card`), STOP, write what you found into a TODO section in this brief, and move to the next file. Don't guess.

---

### Task 2 — Doctor portal "mixed" pages — body migration to v2

These 8 doctor pages have v2 chrome (sidebar/topbar from `partials/doctor/`) but legacy bodies. Your goal: bring the bodies in line with `portal_doctor_dashboard.ejs` (which is the reference v2 doctor body).

| File | Route | Priority |
|---|---|---|
| `src/views/doctor_alerts.ejs` | `/portal/doctor/alerts` | **High** (linked in sidebar) |
| `src/views/portal_doctor_messages.ejs` | `/portal/doctor/messages` | Already a stub — just verify it's clean |
| `src/views/portal_doctor_earnings.ejs` | `/portal/doctor/earnings` | Already a stub — just verify it's clean |
| `src/views/doctor_prescribe.ejs` | `/portal/doctor/case/:id/prescribe` | Medium (in main flow but cut from sidebar) |
| `src/views/doctor_prescriptions_list.ejs` | `/portal/doctor/prescriptions` | Low (cut from sidebar) |
| `src/views/doctor_appointments.ejs` | `/portal/doctor/appointments` | Low (cut from sidebar) |
| `src/views/doctor_analytics.ejs` | `/portal/doctor/analytics` | Low (cut from sidebar) |
| `src/views/doctor_case_intelligence.ejs` | `/doctor/cases/:id/intelligence` | Low (cut from sidebar) |
| `src/views/doctor_reviews.ejs` | `/portal/doctor/:id/reviews` (public) | Low (public-facing) |
| `src/views/portal_doctor_guide.ejs` | `/portal/doctor/guide` | Low (cut from sidebar) |

**Reference for v2 doctor body styling:** read `src/views/portal_doctor_dashboard.ejs` and `src/views/portal_doctor_profile.ejs` (both are v2). Doctor-side classes are namespaced under `body.doctor-theme.portal-v2` in `doctor-portal-v2.css`. Common classes:
- `.v2-shell`, `.v2-card`, `.v2-card__head`, `.v2-card__body`
- `.v2-btn`, `.v2-btn--primary`, `.v2-btn--ghost`
- `.v2-stat-tile`, `.v2-numeral`
- `.v2-chip`, `.v2-chip--brass`, `.v2-chip--teal`

**Approach:** For each file, the chrome (sidebar/topbar) is already correct because it comes from the layout. The body content is what needs warm-clinical treatment. The palette-override block (commit `d77607e`) already rebinds legacy blue tokens, so even an unmodified legacy body should look mostly OK — the issue is specifically the layout primitives (cards, buttons, forms) that visually differ from the v2 design language.

**Order of operations for each:**
1. Visit the route in the running dev server (you have terminal access).
2. Take a screenshot or note what looks off versus the dashboard.
3. Apply the most surgical fix possible — usually just swapping `.flow-card` → `.v2-card` and updating button classes. Don't rewrite layouts.
4. Restart server, verify route returns 302.
5. Commit individually.

**For `portal_doctor_messages.ejs` and `portal_doctor_earnings.ejs`:** these are stub views with "Coming soon" empty states. They probably look fine already. Just open them, confirm visually, no commit needed unless you find an issue.

**Skip if heavy:** `doctor_analytics.ejs` and `doctor_case_intelligence.ejs` are content-heavy data dashboards. If migrating them properly takes more than 30 minutes each, skip them and add a TODO line in this brief. They're cut from the main sidebar nav anyway and rarely visited.

---

### Task 3 — Final cleanup and verification

After Tasks 1 and 2:

1. **Restart dev server** one more time.
2. **Run smoke test on all routes:**
   ```bash
   for route in / /login /doctor/login /doctor/signup /services /about \
                /portal/patient/alerts /portal/patient/records /portal/patient/referrals \
                /portal/patient/reviews /portal/patient/prescriptions \
                /portal/doctor /portal/doctor/today /portal/doctor/dashboard \
                /portal/doctor/cases /portal/doctor/messages /portal/doctor/earnings \
                /portal/doctor/profile /portal/doctor/alerts; do
     code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$route")
     echo "$code  $route"
   done
   ```
   Expected: all `200` for unauthenticated public routes, all `302` for portal routes. No `500`s.
3. **Delete .bak files** in a single commit:
   ```bash
   git rm public/css/portal-variables.css.bak \
          public/css/doctor-portal-v2.css.bak \
          src/views/layouts/portal.ejs.bak \
          src/views/patient_alerts.ejs.bak \
          <any others created during this brief>
   git commit -m "chore: remove migration backups now that migration is verified"
   ```
4. **Push to origin** for Render auto-deploy:
   ```bash
   git push origin feat/doctor-portal-v2-warm-clinical
   ```
   The user will review the live preview deploy and merge if good.
5. **Append to this brief** a "DONE" section listing every commit you made, in order, with the SHA and one-line summary. The user will use this to walk through the changes.

---

## Constraints — what NOT to do

- **Do not** rename anything in `--v2-*` namespace. The architectural decision is documented in `portal-variables.css` lines 200-218.
- **Do not** modify `admin-*`, `superadmin_*`, `ops*`, or any view starting with `admin_`. Admin/superadmin/ops portals are out of scope.
- **Do not** modify schema, migrations, route handlers (`src/routes/*.js`), or any business logic. CSS and EJS only.
- **Do not** delete the `.bak` files until Task 3.
- **Do not** install new packages. Use only what's already in `package.json`.
- **Do not** commit the `node_modules` folder (already gitignored, but worth saying).
- **Do not** push to `main`. Stay on `feat/doctor-portal-v2-warm-clinical`.

If you find something genuinely ambiguous, write it as a question in `CLAUDE_CODE_QUESTIONS.md` at the repo root and continue with the next task.

---

## Useful commands

```bash
# Restart dev server (frees port 3000 if busy)
npm run dev

# Verify a single EJS file compiles
node -e "require('ejs').compile(require('fs').readFileSync('src/views/X.ejs','utf8'),{filename:'src/views/X.ejs'})"

# Check git status
git status -s

# See the previous Claude session's commits
git log --oneline d1fc48f^..HEAD

# Read the route audit
less docs/audits/full-portal-chrome-state.md
```

---

## End state

When you are done:
- All 19 patient surfaces use v2 chrome (currently 11 of 19; need to add the 7 from Task 1, plus `patient_alerts` already done)
- All doctor surfaces have v2 bodies aligned with the warm-clinical design system (or skipped with a clear TODO)
- All routes return non-500 on smoke test
- No `.bak` files remain
- Commits are atomic, well-titled, and easy to review one-by-one
- This brief has a "DONE" section the user can read to follow what happened

---

## Task 1 DONE — 2026-04-27

All 7 legacy patient views migrated to v2 chrome on branch
`feat/doctor-portal-v2-warm-clinical`. Per-file commits, each with the
recipe-matching token / class swaps applied and a `.bak` of the original
left in place (per brief, removed in Task 3). Each route was smoke-tested
against a running dev server and returned `302` (auth redirect) — no `500`s.

| # | Commit  | View migrated                          | Route smoke-tested                                                |
|---|---------|----------------------------------------|-------------------------------------------------------------------|
| 1 | 88b6fab | `patient_records.ejs`                  | `GET /portal/patient/records` → 302                              |
| 2 | 125cdcc | `patient_referrals.ejs`                | `GET /portal/patient/referrals` → 302                            |
| 3 | d56b1ee | `patient_reviews.ejs`                  | `GET /portal/patient/reviews` → 302                              |
| 4 | e5e005c | `patient_review_form.ejs`              | `GET /portal/patient/case/:id/review` → 302                      |
| 5 | 71278bc | `patient_prescriptions.ejs`            | `GET /portal/patient/prescriptions` → 302                        |
| 6 | 22e70a2 | `patient_prescription_detail.ejs`      | `GET /portal/patient/prescription/:id` → 302                     |
| 7 | 05505c4 | `patient_appointments_list.ejs`        | `GET /portal/video/appointments` → 302                           |

**Per-commit summaries** (one line each):

- `88b6fab` — records: head/topbar/foot swap, modal tokens rebound to v2,
  `+ Add Record` moved to topbar `actions`, emoji record-type icons kept.
- `125cdcc` — referrals: head/topbar/foot swap, `.portal-stats` stat-card
  grid kept per brief, copy-code + WhatsApp share preserved.
- `d56b1ee` — reviews: head/topbar/foot swap, nested pending+submitted
  cards both mapped to `.p-card`, star helper now reads `--warn` / `--rule`.
- `e5e005c` — review form: keeps `.portal-page` / `.portal-page-header` /
  `.admin-breadcrumb` per brief; only inner `.flow-card` → `.p-card` and
  button BEM rename. Star JS now resolves token colors at runtime.
- `71278bc` — prescriptions list: head/topbar/foot swap, status chips
  remapped (`active` → teal, `expired` → red).
- `22e70a2` — prescription detail: head/topbar/foot swap, dropped the
  per-page `<style media="print">` block (global v2 print rules cover it).
- `05505c4` — appointments list: head/topbar/foot swap, status chips
  remapped (confirmed/completed → teal, pending → brass, cancelled/no_show
  → red), patient tour script preserved verbatim.

**Open questions captured in `CLAUDE_CODE_QUESTIONS.md`:**

- Q1 — `.p-chip--info` is referenced by the brief recipe but is not
  defined in `patient-portal-v2.css`. Files affected: `patient_records.ejs`,
  `patient_appointments_list.ejs`. Awaiting confirmation: should it become
  `.p-chip--neutral`, or should `.p-chip--info` be added to the stylesheet?
- Q2 — Mapping for `status-breached` (prescription expired) and
  `status-cancelled` / `no_show` (appointments) → currently both
  `.p-chip--red`. Confirm or relax to `.p-chip--neutral`.
- Q3 — Removed per-page `<style media="print">` from
  `patient_prescription_detail.ejs`; global rules cover the same ground.
  Confirm OK after a real print preview.
- Q4 — Modal in `patient_records.ejs` is still bespoke (only tokens were
  rebound). Future intent for a shared `.p-modal` set?

**.bak files created in Task 1 (kept per brief, to be removed in Task 3):**

- `src/views/patient_records.ejs.bak`
- `src/views/patient_referrals.ejs.bak`
- `src/views/patient_reviews.ejs.bak`
- `src/views/patient_review_form.ejs.bak`
- `src/views/patient_prescriptions.ejs.bak`
- `src/views/patient_prescription_detail.ejs.bak`
- `src/views/patient_appointments_list.ejs.bak`

**Constraints respected:** CSS + EJS only. No route handler / schema
changes. Stayed on `feat/doctor-portal-v2-warm-clinical`. Did not push.
No `--v2-*` tokens renamed. No admin / superadmin / ops views touched.
No `.bak` files deleted.

**Next step:** STOP per brief — Task 2 (doctor body migration) is judgment
work and was explicitly excluded from this autonomous run.

---

## Deferred items

Non-blocking follow-ups deliberately not addressed in this branch.

- **Shared `.p-modal` / `.p-modal__box` component.** Extract from
  `src/views/patient_records.ejs` (Add Record modal) so future patient
  surfaces don't have to redefine modal CSS in their own `<style>` block.
  Not blocking — the bespoke modal works fine; it just lives in one
  view. Cite `patient_records.ejs:39-45` when you pick this up.

---

## Visual fixes DONE — 2026-04-27

Six follow-up issues spotted during visual review of the migrated patient
pages were fixed and committed individually. After all fixes the dev
server was killed + restarted via `npm run dev` and a full 6-route smoke
pass returned `302` for every route (no `500`s).

| # | Commit  | Fix                                                                           |
|---|---------|-------------------------------------------------------------------------------|
| 1 | 81d7e23 | `fix(patient): stop leaking notification queue debug JSON to patient alerts` — `normalizePatientNotification` in `src/routes/patient.js:328` no longer surfaces the `response` column (queue worker debug JSON like `{"ok":true}` / `{"error":"…"}`); message returns `''` so the view renders title-only. |
| 2 | dde035a | `fix(patient): restyle records filter tabs as v2 chips` — replaced unstyled `.filter-tabs` with a flex row of `.p-chip--teal` (active) / `.p-chip--neutral` (others) anchors; same hrefs preserved. |
| 3 | 942792e | `fix(patient): apply v2 input + button BEM in records page` — added `.p-field__input` to the search input; audited all `.p-btn` usages — no leftover single-dash variants found. |
| 4 | 295a7fd | `fix(patient): rebuild referrals stat tiles as v2 cards` — `.portal-stats` / `.stat-card` replaced with three `.p-card` tiles (`--primary` / `--accent` / `--muted` border-inline-start, brass numerals for business metrics, ink for the routine count). |
| 5 | e8411bc | `fix(patient): repair empty-state icon on prescriptions` — replaced the broken two-arc SVG with the standard Lucide pill (capsule + centre divider); stroke = `var(--muted)`. |
| 6 | 91aa4dc | `fix(patient): normalise appointment status codes for label + chip` — added `normalizeStatus()` helper that strips `_patient` / `_doctor` suffix; applied in `statusChipClass()`, `statusLabel()`, and the inline "Join Call" gate. Patients no longer see raw `NO_SHOW_PATIENT` etc. |

**Smoke pass after all six fixes:**

```
302  /portal/patient/alerts
302  /portal/patient/records
302  /portal/patient/referrals
302  /portal/patient/reviews
302  /portal/patient/prescriptions
302  /portal/video/appointments
```

**Constraints respected:** CSS + EJS, plus a single targeted change to one
route handler (Issue 1 — required to stop the data leak; ~6-line
docstring + 1 logic line). Did not push. No `.bak` files deleted.
