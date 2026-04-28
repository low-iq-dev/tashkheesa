# Claude Code Brief — Doctor Prescribe Form Redesign (Task 2)

**Branch:** `feat/doctor-portal-v2-warm-clinical`
**Created:** April 28, 2026
**Last commit:** `90db713` (profile avatar render fix)
**Prior task done:** Task 1 (Profile redesign) — see commits `fe5df9d` →
`90db713` for the pattern. This task follows the SAME approach.

---

## Source of truth

Three files. Read them in this order before writing any code:

1. **`/Users/ziadelwahsh/Downloads/Tashkheesa Downloads/Doctor Prescribe Form/Prescription Form.html`**
   (87 KB, ~2200 lines — the JSX inside `<script type="text/babel">` is
   what you're translating to EJS. Read the `<style>` block first to
   understand the `.rx-*` namespace, then walk the rendered markup.)

2. **`/Users/ziadelwahsh/Downloads/Tashkheesa Downloads/Doctor Prescribe Form/Prescription Form (standalone).html`**
   (458 KB — same content, fully rendered. Use as a visual reference if
   the JSX file is unclear.)

3. **`/Users/ziadelwahsh/Downloads/Tashkheesa Downloads/Doctor Portal/Doctor Portal Style Guide (source for bundle).html`**
   (124 KB — the full design system. The `<style>` block at the top has
   every token + every primitive used across the whole portal. Read this
   for any class name from the prescribe standalone you don't recognise.)

---

## Files in play

- **View:** `src/views/doctor_prescribe.ejs` (820 lines, ~42 KB — the
  largest unmigrated EJS file)
- **Backup:** Make one before you start: `cp src/views/doctor_prescribe.ejs src/views/doctor_prescribe.ejs.bak`
- **Routes:** `src/routes/prescriptions.js`
  - `GET /portal/doctor/case/:caseId/prescribe` at line 47 — renders the form
  - `POST /portal/doctor/case/:caseId/prescribe` at line 67 — handles submission
- **Locals passed in:** `user, order, existingPrescriptionId, lang, isAr, pageTitle, error?`
  - `order` has all patient + service fields: `id, patient_name, patient_dob, patient_gender, service_name, status` etc.

---

## Behavioural contract — DO NOT BREAK

The POST handler reads these field names from req.body. If you change them, prescriptions stop saving:

- `med_name[]` — array of medication names
- `med_dosage[]` — array of dosages (e.g. "500 mg")
- `med_frequency[]` — array of frequencies (e.g. "twice daily")
- `med_duration[]` — array of durations (e.g. "10 days")
- `prescription_file` — optional uploaded file (PDF/image)
- Plus whatever CSRF/session machinery the existing form uses — preserve verbatim

The handler treats empty rows as skipped, so it's safe to render at
least one empty medication row by default.

After successful POST, the handler redirects to a confirmation page —
preserve the existing flow.

If the route is GET'd for a case that already has a prescription
(`existingPrescriptionId` set), the form should make this VISIBLE — the
standalone shows a "Prescription already submitted" state. The current
EJS may handle this differently; whatever it does today, don't break.

---

## What the standalone shows (and what to build)

### Page structure (top to bottom)

1. **Breadcrumb header** — `< Back to case` link, breadcrumb showing case ID
2. **Patient context strip** — patient initials avatar, name, DOB/age,
   gender, case ID, service name. This is the orienting "you are
   prescribing for X" surface.
3. **Language toggle** — EN / AR pill toggle for the language THIS
   prescription is written in (note: this is per-prescription language,
   independent of the doctor's UI language)
4. **Section 1 — Medications** (the meat of the page)
   - Numbered cards (`.rx-med`), one per medication, indexed `#1, #2, ...`
   - Each card has fields: name (with autocomplete), dosage, frequency,
     duration, route, refills, notes
   - Trash button (`.rx-med__trash`) on each card to remove it
   - "+ Add medication" button below all cards (`.rx-add-med`)
5. **Section 2 — Refills** — checkbox or chip-pickers for refill rules
   (e.g. "0 refills", "1 refill", "custom: ___ refills over ___ months")
6. **Section 3 — Signature** — shows the doctor's saved signature image
   (small thumbnail), OR if no signature on file, shows
   `.rx-signature__sig--missing` state with a link to upload one.
   Note: the actual signature upload flow happens elsewhere — this
   section just SHOWS the current state and gates submission on having
   a signature.
7. **Bottom action bar** (`.rx-actions`) — sticky at the bottom of the page
   - **Left side:** "Save draft" (ghost), autosave indicator dot
   - **Right side:** "Cancel" (ghost), "Send Prescription" (brass primary)
8. **Sign confirmation modal** — opens when "Send Prescription" is clicked
   - Shows summary: patient name, case ID, medication count
   - Shows the doctor's signature
   - Checkbox "I confirm this prescription is medically appropriate"
   - "Confirm & Send" (primary) + "Back" (ghost)

### Empty state

If `existingPrescriptionId` is set, render a different surface:
- "Prescription already issued for this case"
- Show a summary card with the existing prescription's basic info
- Link to view the existing prescription

---

## Approach — same as Task 1 (Profile)

**Token aliasing pattern (option (b) from the prior brief):**

1. Create `public/css/doctor-prescribe.css` containing the CSS from the
   standalone, scoped under `body.doctor-theme.portal-v2 .doctor-prescribe-page`.
2. At the top of that CSS file, alias unprefixed token names to v2:
   ```css
   body.doctor-theme.portal-v2 .doctor-prescribe-page {
     --primary: var(--v2-brand);
     --accent: var(--v2-accent);
     --ink: var(--v2-ink);
     --muted: var(--v2-muted);
     --bg: var(--v2-bg);
     --surface: var(--v2-surface);
     --rule: var(--v2-rule);
     --danger: var(--v2-danger);
     --warn: var(--v2-warn);
     --success: var(--v2-success);
   }
   ```
3. The `.rx-*` class names from the standalone stay as-is — they're
   already namespaced.
4. The view wraps everything in `<div class="doctor-prescribe-page">`.

**Use existing partials:**
- `<%- include('partials/header', { layout: 'portal', ... }) %>` for the
  page chrome (sidebar + topbar)
- `<%- include('partials/doctor/topbar', { ... }) %>` for the page
  header — same pattern Profile uses
- `<%- include('partials/footer') %>` at the end

---

## CRITICAL: Split into 4 sequential commits

This is the biggest single file in the codebase. **Do NOT do it as one
giant edit.** Split into 4 commits, each compiling and smoke-testing
green before moving to the next. Each commit is independently
reviewable, and if any commit breaks something we can bisect easily.

### Commit 1: Chrome + patient context strip

Scope:
- Backup the existing view
- Create `public/css/doctor-prescribe.css` with the chrome-level styles
  (`.rx-page`, `.rx-header`, `.rx-context`, `.rx-breadcrumb`, `.rx-lang`)
- Replace the top of `doctor_prescribe.ejs` (header + breadcrumb +
  patient context strip + language toggle) with the v2 versions
- Keep the rest of the page (sections 1-3 + action bar) UNCHANGED
  for now — leave the existing legacy markup in place below your new
  chrome
- Compile-check + smoke-test the route returns 200 (or 302 if not auth'd)
- Commit message:
  ```
  feat(doctor): port prescribe header + patient context to v2 (1/4)
  ```

### Commit 2: Medications repeater

Scope:
- Add `.rx-med`, `.rx-med__head`, `.rx-med__grid`, `.rx-med__trash`,
  `.rx-add-med`, `.rx-field`, `.rx-input`, `.rx-autocomplete*` styles
  to `doctor-prescribe.css`
- Replace the existing medications section with the v2 repeater
- Each card renders with the existing field names (`med_name[]`,
  `med_dosage[]`, `med_frequency[]`, `med_duration[]`)
- Add a basic JS chunk inside a nonce'd `<script>` block to:
  - Add a new card on "+ Add medication" click
  - Remove a card on trash icon click
  - Renumber `#1, #2, ...` after add/remove
- Autocomplete: the standalone shows a fancy dropdown — implement a
  simple version: a static list of common medications hard-coded as a
  JS array (~30-50 entries). When the user types, filter matching
  entries and show a dropdown. On click, fill the name field. If you
  can't get autocomplete working in 30 minutes, skip it — the field is
  still a regular text input, the form still works, and we can build
  proper autocomplete later. **DO NOT spend more than 30 minutes on
  autocomplete in this commit.**
- Compile-check + smoke test
- Commit:
  ```
  feat(doctor): port prescribe medications repeater to v2 (2/4)
  ```

### Commit 3: Refills + signature panel

Scope:
- Add `.rx-refills`, `.rx-refill-custom`, `.rx-signature*` styles
- Replace the existing refills + signature section
- Signature: render a small `<img>` showing the doctor's saved signature
  if `req.user.signature_url` (or equivalent) is set; otherwise render
  the missing-signature state with a link to wherever signatures are
  uploaded (check the existing EJS to see how this is wired today)
- Compile-check + smoke test
- Commit:
  ```
  feat(doctor): port prescribe refills + signature to v2 (3/4)
  ```

### Commit 4: Action bar + sign modal

Scope:
- Add `.rx-actions`, `.rx-modal*` styles
- Sticky bottom action bar with Save Draft / Autosave / Cancel / Send Prescription
- Sign confirmation modal (hidden by default, opened by Send Prescription click)
- Modal contains summary + signature + confirmation checkbox + Confirm & Send button
- Wire up modal open/close in the same nonce'd script block
- Verify no inline event handlers anywhere — CSP blocks them (this bit
  us hard on Profile, see commit `e3ab91c`)
- Compile-check + smoke test
- Commit:
  ```
  feat(doctor): port prescribe action bar + sign modal to v2 (4/4)
  ```

---

## Hard constraints

- **CSS + EJS only.** Do NOT modify `src/routes/prescriptions.js`,
  `src/middleware/upload.js`, the schema, or any package.
- The route handlers were working before any redesign. Don't touch them.
- Stay on branch `feat/doctor-portal-v2-warm-clinical`. Don't push.
- Don't delete `.bak` files.
- Don't touch any other view (alerts, profile, cases, dashboard).
- **NO inline event handler attributes anywhere.** This means no
  `onclick="..."`, no `onchange="..."`, no `onsubmit="..."`. Use
  `addEventListener` inside a nonce'd `<script>` block. Inline handlers
  are blocked by the project's CSP. (We learned this the hard way on
  Profile photo upload — see commit `e3ab91c`.)
- Compile-check after every edit:
  ```
  node -e "require('ejs').compile(require('fs').readFileSync('src/views/doctor_prescribe.ejs','utf8'),{filename:'src/views/doctor_prescribe.ejs'})"
  ```
- Smoke-test after every commit:
  ```
  curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/portal/doctor/case/<some-real-case-id>/prescribe"
  ```
  (You'll need a real case ID for this — pull one from the orders
  table, or just check the route with no caseId and confirm it doesn't
  500.)

---

## Verification at the end of all 4 commits

After commit 4 lands, restart the dev server and ask the user to:

1. Open a real case from /portal/doctor/cases (one that doesn't already
   have a prescription)
2. Click the "Write prescription" button on the case detail page
3. Add a medication (e.g. Paracetamol 500mg, twice daily, 5 days)
4. Click "Send Prescription"
5. In the confirmation modal, tick the checkbox and click "Confirm & Send"
6. Verify the prescription was created (DB row in `prescriptions` table,
   plus whatever success page the existing handler redirects to)

Do not declare success until the user manually confirms this round-trip
works end-to-end.

---

## After all 4 commits

1. Append a "Prescribe DONE" section to
   `CLAUDE_CODE_BRIEF_PROFILE_PRESCRIBE.md` listing each commit SHA and
   a one-line summary
2. Stop and report back. Do NOT proceed to any other doctor pages — the
   user wants to ship Profile + Prescribe, eyeball them in production
   on a Render preview deploy, and tackle the remaining low-priority
   pages (analytics, case_intelligence, appointments, prescriptions_list,
   reviews, guide) in a future session.

---

## Notes

- The "Send Prescription" button is the most important interaction on
  this page. It's a clinical action with real consequences. Test it
  carefully — the confirmation modal exists for a reason. Don't
  shortcut the modal.
- Autocomplete is nice-to-have for medications; **don't burn the budget
  on it**. A plain text input with a hard-coded suggestions list (or
  even no autocomplete) is fine for this round. The user has flagged
  autocomplete polish as a separate request to handle after Prescribe
  ships.
- If you find the standalone uses behaviours that aren't in the current
  EJS (e.g. autosave to /api/draft/...), don't try to wire them up —
  those would need new route handlers. Stub them visually if helpful
  (a fake autosave dot that turns green on edit and back to grey after
  2 seconds), but don't pretend they actually save.

---

## Why this brief is so detailed

The Profile redesign in commit `fe5df9d` shipped the visual correctly
but introduced two regressions (save broken, photo upload broken) that
took 4 rounds to fully fix. That cost real user trust. This brief is
heavier because Prescribe is bigger AND the cost of breaking it is
higher (it's a clinical workflow, not a vanity page). Take the time.
Split into 4 commits. Smoke test between each one. The user can
absorb a slower-but-correct pass; they cannot absorb another
multi-round regression saga on a clinical surface.
