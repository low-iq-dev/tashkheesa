# Claude Code Brief — Phase 2: Signature + Autocomplete + Legacy Audit

**Branch:** create `feat/phase2-signature-autocomplete` from `main`
**Working file:** `PHASE_2_BACKLOG.md` at repo root — log every issue you find here

---

## Hard constraints

- Stay on the new branch. Don't push.
- Don't delete `.bak` files.
- CSS + EJS first; route changes only when functionally required.
- NO inline event-handler attributes anywhere (`onclick`, `onchange`, `onsubmit`). Use `addEventListener` inside a nonce'd `<script>`. CSP blocks inline handlers — see commit `e3ab91c` for the bug this caused on photo upload.
- Compile-check after every edit:
  ```
  node -e "require('ejs').compile(require('fs').readFileSync('PATH','utf8'),{filename:'PATH'})"
  ```
- Smoke-test after every commit (curl, expect 302 or 200).
- If you find yourself thinking "I bet it's X" before testing, stop and test.

---

## Task A — Doctor signature upload (functional gap, do FIRST)

**The bug:** prescribe form shows "no signature on file" warning but no upload UX exists. Doctors are blocked from finishing prescriptions with no path forward.

**Scope:**
1. Add a new section "09 — Signature" to `src/views/portal_doctor_profile.ejs` (after section 08 fee info, before the sticky save bar).
2. Section shows current signature image if `req.user.signature_url` is set, else a "missing" state (soft-pink, matches the no-signature panel in the prescribe form).
3. Upload button → file input (PNG/JPG, max 2MB, transparent PNG preferred).
4. Server side: new route `POST /portal/doctor/profile/signature`. Mirror the photo upload route at `src/routes/doctor.js:2131` exactly — same multer wrap, same R2 upload pattern, same signed-URL serve route. Folder: `doctor-signatures/<userId>`. Column: add `signature_url` to users table if it doesn't exist (check schema first; if missing, create migration `src/migrations/0XX_add_signature_url.sql` adding `signature_url TEXT`).
5. New route `GET /portal/doctor/profile/signature/:id` — serve via signed URL same pattern as `GET /portal/doctor/profile/photo/:id`.
6. Render the signature in the prescribe form's "before you sign" panel — replace the "no signature" warning with the actual signature image when present.
7. Bilingual EN/AR labels.
8. Commit per logical step (form section, route, prescribe-form integration). Three commits expected.

**Stop conditions — ASK USER before coding if:**
- The schema doesn't have `signature_url` and you're unsure whether to add a migration.
- You can't find a clear pattern from the photo upload to mirror.

---

## Task B — Profile autocomplete (well-scoped UX work)

**The asks:** typeahead/dropdown for sub-specialties, board certifications, languages on profile.

**Scope:**
1. Create `public/js/profile-autocomplete-data.js` with three data exports:
   - `LANGUAGES` — ~25 ISO 639-1 entries `{ code, en, ar }`. Common clinical languages.
   - `BOARD_CERTIFICATIONS` — ~50 common medical boards `{ en, ar, country }` (Egyptian Board of Radiology, FRCR, ABR, EFR, MRCP, etc.). Hand-curated.
   - `SUB_SPECIALTIES` — keyed by specialty name (NOT id, because the form's specialty `<select>` uses ids but the data is more readable by name). Map of `{ "Radiology": ["CT", "MRI", "Ultrasound", "Interventional", ...], "Cardiology": ["Echo", "Cath", "EP", ...], ... }`. Cover the 16 specialties already in the pricing doc. ~10–20 entries each.
2. Wire autocomplete into the existing chipset components in `portal_doctor_profile.ejs`:
   - Sub-specialties chipset (section 03): filter against the doctor's currently-selected specialty's sub-list. If specialty not yet picked, show empty/hint.
   - Languages chipset (section 07): filter against `LANGUAGES` showing English+Arabic name.
3. Board certifications: the cert repeater (section 05) currently has a free-text "Certification" input. Convert that single input to autocomplete-from-list, keep "Issuing body" and "Year" as free text.
4. Autocomplete UI: dropdown below the input, max 8 items, arrow keys + enter to select, click to select, fuzzy-match (substring is fine, no fancy scoring needed).
5. NO inline handlers. NO new dependencies. Vanilla JS in a nonce'd `<script>`.
6. One commit. Compile + smoke test.

**Stop conditions — ASK USER before coding if:**
- The chipset JS is too tangled to extend without rewriting it.
- You think you need a library (you don't — keep it vanilla).

---

## Task C — Legacy pages audit (DECISION work, NOT code)

**Don't redesign anything in this task. Audit only.**

For each file below, do the following and write findings to `PHASE_2_BACKLOG.md`:
1. Open the file. Read the locals it expects.
2. Grep for routes that render it (`grep -n "render.*<viewname>" src/routes/*.js`).
3. Grep for nav links that point at it.
4. Decide one of:
   - **REDESIGN** — file is reachable, surface is needed, must be migrated to v2.
   - **DELETE** — file has no nav links, route is unused or duplicates another, or surface is replaced by something already migrated.
   - **KEEP-AS-IS** — file is partial-v2 already and just needs polish (note what polish).

Files to audit:
- `src/views/doctor_analytics.ejs`
- `src/views/doctor_appointments.ejs`
- `src/views/doctor_case_intelligence.ejs`
- `src/views/doctor_reviews.ejs`
- `src/views/portal_doctor_dashboard.ejs`
- `src/views/portal_doctor_guide.ejs`
- `src/views/doctor_login_v2.ejs`
- `src/views/doctor_pending_approval.ejs`
- `src/views/doctor_signup.ejs`
- `src/views/doctor_signup_submitted.ejs`
- `src/views/portal_doctor_earnings.ejs`
- `src/views/portal_doctor_messages.ejs`

Update `PHASE_2_BACKLOG.md` with the audit findings under a new "## Audit results" section. Commit:
```
docs: Phase 2 audit — legacy pages decisioned (redesign / delete / keep)
```

DO NOT delete or redesign anything yet. Just produce the decision list. User reviews before next steps.

---

## Order

1. Task A (signature) — three commits, stop and report
2. Task B (autocomplete) — one commit, stop and report
3. Task C (audit) — one commit, stop and report

Stop and report after each task. Do not chain.

---

## Verification

Each task must end with the user manually verifying:
- **A:** upload a real PNG signature on profile, see it persist on reload, see it render in the prescribe form's pre-sign panel.
- **B:** start typing a sub-specialty / language / cert — see the dropdown appear, click an entry, see it land as a chip.
- **C:** read the audit findings, sanity-check the redesign-vs-delete calls.

Do not declare done until the user confirms.

---

## When all three are done

Append a "Phase 2 round 1 DONE" section to `PHASE_2_BACKLOG.md` with:
- Commit SHAs for each task
- One-line summary each
- Any issues discovered logged into the "Issues discovered during Phase 2" section
