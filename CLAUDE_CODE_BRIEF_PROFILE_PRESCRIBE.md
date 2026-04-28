# Claude Code Brief — Doctor Profile + Prescribe Form Redesign

**Branch:** `feat/doctor-portal-v2-warm-clinical`
**Created:** April 28, 2026
**Last commit before this brief:** `9603e9a` (doctor alerts rebuild)

---

## Source of truth

The user has exported full Claude Design standalone HTMLs that are the design
target. Read them BEFORE editing any code:

- **`/Users/ziadelwahsh/Downloads/Tashkheesa Downloads/Doctor Profile Page/Doctor Profile Page.html`**
  (38 KB, ~750 lines — JSX inside `<script type="text/babel">`. Read the
  `<style>` block first, then the rendered markup, then the JSX components.)

- **`/Users/ziadelwahsh/Downloads/Tashkheesa Downloads/Doctor Prescribe Form/Prescription Form.html`**
  (87 KB, ~2200 lines — same structure.)

- **`/Users/ziadelwahsh/Downloads/Tashkheesa Downloads/Doctor Portal/Doctor Portal Style Guide (source for bundle).html`**
  (124 KB — complete design system. The `<style>` block at the top has every
  token + every primitive. Read it first as your reference vocabulary.)

These are React + babel inline. You are translating them to EJS. The visual
output should match. The data wiring stays as-is — read the existing route
handlers to understand what locals are passed and preserve every behaviour.

---

## Task 1 — Doctor Profile Page

**Files in play:**
- View: `src/views/portal_doctor_profile.ejs` (currently 14 KB, ~430 lines —
  it's a working v2 page already, but doesn't match the standalone visually)
- Route: `src/routes/doctor.js:1864` and `:2022` (`res.render('portal_doctor_profile', ...)`)
- Existing CSS: scattered across `doctor-portal-v2.css` + maybe a per-page CSS

**What the standalone shows:**
A single-column profile editor with sections (`.psec`):
1. **Avatar block** — round avatar + change/remove buttons
2. **Name** — English + Arabic side by side (`.field` × 2)
3. **Contact** — email (readonly), phone (with country code), DOB
4. **Practice** — specialty, license #, license country, years experience
5. **Education** — medical school, graduation year
6. **Affiliations** — repeater list (`.rptr`) of name + role + delete
7. **Credentials** — repeater list of name + body + year
8. **Bio** — bilingual rich-ish editor with EN/AR tabs and a small toolbar
9. **Fee info card** — `.fee-info` panel showing the doctor their per-case
   fee with brass numeral
10. **Save bar** — sticky bottom bar with cancel + primary save button,
    showing save state ("Saving..." / "Saved 3s ago")

**Sidebar verification panel** is on the RIGHT in the current EJS, but the
standalone uses a SINGLE COLUMN layout. **Per the design system Redesign
brief, profile is single-column.** Move the verification info into a section
within the main flow (e.g. as a `.psec` showing license + photo upload
status with brass-warning chips for missing items).

**Approach:**

1. Backup: `cp src/views/portal_doctor_profile.ejs src/views/portal_doctor_profile.ejs.bak`
2. Read the standalone's `<style>` block. The design uses scoped class names
   `.psec*`, `.field*`, `.btn`, `.rptr*`, `.fee-info*`, `.save-bar*`,
   `.bio-tabs*`. **DO NOT** prefix them with `v2-` — the standalone is
   already its own namespace (`.app .profile .psec`). Keep the names,
   nest them under `body.doctor-theme.portal-v2` to scope them.
3. Create a new stylesheet at `public/css/doctor-profile.css` containing
   the styles from the standalone, scoped under `body.doctor-theme.portal-v2`.
4. Add `<link rel="stylesheet" href="/css/doctor-profile.css" />` near the top
   of `portal_doctor_profile.ejs` (right after the include).
5. Rebuild the EJS view to mirror the standalone's structure: header
   (greeting + sub), section by section. Keep the existing locals contract
   intact — preserve every `<%= %>` binding from the current EJS so saving
   still works.
6. The save bar stays sticky at the bottom. Wire it to the same form action
   the current view uses.
7. The bio editor in the standalone is a textarea with a fake toolbar above
   it. Don't build a real rich-text editor — render the toolbar as decorative
   buttons that don't do anything (`disabled`), and let the textarea below
   work normally. The brief is "luxury feel," not "Google Docs."
8. The fee-info card pulls from the route's existing data — find what the
   handler passes and bind the brass numeral to that.
9. Keep all hidden CSRF inputs and form actions intact.
10. Smoke test: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/portal/doctor/profile"` should return 302.
11. Compile check: `node -e "require('ejs').compile(require('fs').readFileSync('src/views/portal_doctor_profile.ejs','utf8'),{filename:'src/views/portal_doctor_profile.ejs'})"`

**Per-section specs from the standalone:**

| Section | Standalone selector | Notes |
|---|---|---|
| Page intro | `.profile__intro` + `.profile__intro-sub` | "Profile" + "Public specialist profile shown to patients" |
| Section header | `.psec__head` containing `.psec__kicker` (brass micro-label), `.psec__title` (16px serif), `.psec__desc` (12px muted) | Each section gets one |
| Field | `.field` containing `.field__labelrow > .field__label + .field__req`, then `.field__input` | The `*` for required is in `.field__req` (small brass) |
| Required | `.field__req` is a small brass dot or `*` | Use brass token |
| Repeater | `.rptr` row with delete X button on the right | Remove via JS — keep behaviour |
| Add-button | `.add-btn` — outlined ghost button below repeaters | "+ Add affiliation" |
| Save bar | `.save-bar` (sticky bottom), `.save-bar__status` (left), `.btn--ghost` cancel + `.btn--primary` save (right) | Mirror the standalone exactly |
| Fee info | `.fee-info` card with brass border-inline-start, `.fee-info__num` brass numeral, `.fee-info__title` + `.fee-info__body` text | This is the "you earn 80% of EGP X per case" surface |

Commit message:
```
feat(doctor): redesign profile page to match Claude Design standalone

<3-5 lines summary>
```

---

## Task 2 — Doctor Prescribe Form

**Files in play:**
- View: `src/views/doctor_prescribe.ejs` (currently 42 KB — biggest unmigrated
  file in the codebase)
- Route: `src/routes/prescriptions.js` and possibly `src/routes/doctor.js`
  (search for `res.render('doctor_prescribe'`)

**What the standalone shows:**
A focused prescription writing flow, NOT a sidebar layout. Header bar with:
- Breadcrumb back to case
- Patient context strip showing patient name + case ID + service
- Bilingual EN/AR toggle (per-prescription language)

Body:
- **Section 1 — Medications** repeater (`.rx-med__*`). Each medication is a
  card with: drug name (autocomplete `.rx-autocomplete`), dose, frequency,
  duration, route, refills, notes. Numbered (#1, #2, ...). Trash icon to
  remove.
- **Section 2 — Refills** with custom days/quantity option
- **Section 3 — Signature** showing the doctor's saved signature image, or
  a "missing — upload" prompt if not yet uploaded
- **Bottom bar** with Save Draft (ghost) + Cancel (ghost) + Send Prescription
  (primary) — autosave dot indicator

**Approach:**

1. Backup: `cp src/views/doctor_prescribe.ejs src/views/doctor_prescribe.ejs.bak`
2. Same as Task 1 step 2-4 but for the `.rx-*` namespace. Create
   `public/css/doctor-prescribe.css`.
3. Because this is the biggest single file, work in chunks:
   - **Chunk A:** chrome (header, breadcrumb, patient context strip, language toggle)
   - **Chunk B:** medications repeater (a single med card, then JS to add/remove)
   - **Chunk C:** refills + signature section
   - **Chunk D:** bottom action bar + autosave + sign modal
4. Keep all existing form state, autocomplete data, and submit logic. The
   prescription submission flow is critical — DO NOT change the data model
   or any POST endpoint.
5. The "Send Prescription" button opens a confirmation modal in the
   standalone (`.rx-modal-backdrop`, `.rx-modal`). The current EJS may
   already have this — preserve it, just restyle.
6. The "missing signature" state is important: if the doctor doesn't have
   a saved signature image yet, show the `.rx-signature__sig--missing`
   variant with a link to upload one. Wire this to the existing
   `req.user.signature_url` or equivalent local that the route exposes.
7. Compile check + smoke test.
8. Commit as a single commit OR split into 3-4 sequential commits if the
   chunks are large.

**This task is significantly bigger than the Profile task.** Allocate
proportionally. If a chunk takes more than 45 minutes, STOP, commit what's
done, and write a TODO. Don't burn time refactoring autocomplete logic.

Commit message format:
```
feat(doctor): redesign prescribe form chrome to match standalone

<details>
```

Or if split:
```
feat(doctor): port prescribe header + patient context to v2 (1/4)
feat(doctor): port prescribe medications repeater to v2 (2/4)
feat(doctor): port prescribe refills + signature to v2 (3/4)
feat(doctor): port prescribe action bar + sign modal to v2 (4/4)
```

---

## Task 3 — Verification

After both tasks:

1. **Restart dev server** (kill nodemon, `npm run dev`)
2. **Smoke test all doctor routes:**
   ```bash
   for r in /portal/doctor /portal/doctor/today /portal/doctor/dashboard \
            /portal/doctor/cases /portal/doctor/messages /portal/doctor/earnings \
            /portal/doctor/profile /portal/doctor/alerts /portal/doctor/prescriptions; do
     code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$r")
     echo "$code  $r"
   done
   ```
   All 302 expected. Any 500 = stop and fix.
3. **Append a "Profile + Prescribe DONE" section to CLAUDE_CODE_BRIEF.md**
   listing each commit SHA and a one-line summary.
4. **Stop and report back.** The user will eyeball the screens and decide
   whether to push.

---

## Constraints (unchanged from prior briefs)

- CSS + EJS only. No route handler changes. No schema changes. No new packages.
- Stay on branch `feat/doctor-portal-v2-warm-clinical`. Don't push.
- Don't rename any `--v2-*` token or break existing v2 classes.
- Don't touch admin/superadmin/ops views.
- Don't delete any `.bak` files yet.
- Compile-check every EJS file before committing it.
- If you encounter a behaviour you can't preserve cleanly, write your
  question to `CLAUDE_CODE_QUESTIONS.md` and continue with the next task.

---

## Why this brief exists

The user explicitly asked for "every page to look like the Claude Design
standalone HTMLs." The Doctor Alerts page was rebuilt in chat (commit
9603e9a) using existing v2 primitives. Profile and Prescribe Form are too
big to do in chat — they each pull a full bespoke CSS namespace from the
standalones. That's why these two are batched here for Claude Code to grind
through. The patient portal is already done. After Profile and Prescribe,
the remaining mixed-body doctor pages (analytics, case_intelligence,
appointments, prescriptions_list, reviews, guide) are all cut from the
sidebar nav and are low-priority — defer to a future session.

---

## Reference: design tokens already in your repo

All `--v2-*` tokens are defined in `public/css/portal-variables.css`. The
standalones use unprefixed names (`--primary`, `--accent`, etc.). When
porting, either:
  (a) translate unprefixed → `--v2-*` directly, or
  (b) add a single root rule at the top of your new per-page CSS that
      aliases them (cleaner, less search/replace):
      ```
      body.doctor-theme.portal-v2 .your-page-root {
        --primary: var(--v2-brand);
        --accent: var(--v2-accent);
        --ink: var(--v2-ink);
        ...etc...
      }
      ```
Option (b) is recommended — lets you copy CSS from the standalone almost
verbatim.
