# Claude Code Brief — Doctor Profile Regressions

**Branch:** `feat/doctor-portal-v2-warm-clinical`
**Created:** April 28, 2026
**Last commit before this brief:** `75a5274` (commission split text fix)

---

## Context

Commit `fe5df9d` rebuilt `src/views/portal_doctor_profile.ejs` to match the
Claude Design standalone HTML. The visual is correct. The user reports two
regressions and one separate issue:

1. **Save changes does not persist** — clicking the "Save changes" button
   in the sticky save bar produces no visible result. The user types a
   change in the name field, clicks Save, and nothing happens (or the page
   does not reflect the saved value on reload).
2. **Photo upload does not work** — clicking "Upload photo" and selecting
   an image does not upload it. The avatar still shows initials, no error,
   no success.
3. *(already fixed in commit `75a5274` — commission text now reads 20%.)*

The form structure looks correct on inspection:
- `<form id="dpForm" method="POST" action="/portal/doctor/profile" autocomplete="off">` at line 104
- All input `name` attributes match the route handler at `src/routes/doctor.js:1884`
- Hidden JSON inputs for affiliations / certifications / sub_specialties / spoken_languages exist
- The submit handler at line 891 calls `syncAffils(); syncCerts();` to refresh hidden inputs before submit
- Photo form at line 129: `<form method="POST" action="/portal/doctor/profile/photo" enctype="multipart/form-data">` with `onchange="this.form.submit();"`

So this is **not a structural problem** — it's a JS or middleware regression
introduced by the redesign. Your job is to find it and fix it.

---

## Constraints (NON-NEGOTIABLE)

- **CSS + EJS edits only.** Do NOT modify `src/routes/doctor.js`, the
  middleware, `src/middleware/upload.js`, the schema, or any package
  configuration.
- The route handlers were working before the redesign. The bug is in
  the view layer.
- Do NOT delete or rewrite the existing JS in `portal_doctor_profile.ejs`
  wholesale. Find the specific bug, fix it precisely, leave everything
  else alone.
- Stay on branch `feat/doctor-portal-v2-warm-clinical`. Don't push.
- Don't delete any `.bak` files.
- Don't touch any other doctor view (alerts, cases, dashboard, messages,
  earnings) — those are working.
- Compile-check after every edit:
  ```
  node -e "require('ejs').compile(require('fs').readFileSync('src/views/portal_doctor_profile.ejs','utf8'),{filename:'src/views/portal_doctor_profile.ejs'})"
  ```

---

## Your investigation plan

### Step 1 — Reproduce in headless mode

Start the dev server fresh:
```
lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill -9 2>/dev/null
cd ~/tashkheesa-portal
npm run dev &
sleep 3
```

Hit the page through curl with a real session cookie if possible. If you
don't have a quick way to get a doctor session cookie, skip to Step 2.

### Step 2 — Static analysis of the form

Read these in full and look for obvious problems:
- `src/views/portal_doctor_profile.ejs` (the whole file, ~900 lines)
- `src/views/partials/doctor/topbar.ejs`
- `src/views/partials/header.ejs`
- `src/views/layouts/portal.ejs`

Things to check:

**A. Form nesting.** Is the outer `<form id="dpForm">` accidentally wrapping
the photo upload `<form>` (line 129)? HTML doesn't allow nested forms — if
the photo form ended up inside the outer form during the redesign, neither
will submit correctly. Check the indentation/structure carefully.

**B. JS errors blocking submit.** The submit handler at line 891 calls
`syncAffils()` and `syncCerts()`. Are those functions actually defined in
scope? Search for their definitions. If `syncAffils` throws (e.g. because
a DOM node it expects no longer exists), the form's default submit may
still happen, but if there's an `e.preventDefault()` anywhere or a thrown
error inside a click handler, the submit could be silently swallowed.

**C. Save button type.** The "Save changes" button — is it
`<button type="submit">` or just `<button>`? A `<button>` inside a form
defaults to type="submit", but if the redesign added `type="button"` it
won't trigger form submission. Check the markup around `id="dpSaveBtn"`.

**D. Save button outside the form.** Is the save bar (`<div class="save-bar">`)
inside the `<form id="dpForm">` or outside it? The original structure ended
the form at line 532 (`</form>`). If the save bar was placed AFTER `</form>`,
the button has no form to submit. The fix is either to move the save bar
inside the form, OR add `form="dpForm"` attribute to the save button so
it's associated with the form despite being outside it.

**E. Photo form regression.** Same family of bug — is the photo form
(line 129) accidentally inside the outer form now? Or did its onchange
handler get stripped during the redesign?

**F. CSP nonce.** The script tag at the bottom uses
`<script<% if (_nonce) { %> nonce="<%= _nonce %>"<% } %>>`. If the
helmet/CSP configuration provides a nonce locally but the script doesn't
get it, browsers will silently refuse to execute the script. Check
the rendered HTML in your browser by viewing source — does the
`<script>` tag have a `nonce` attribute? If yes, does it match the CSP
header? If the script is being blocked by CSP, that explains both
regressions in one shot (no JS = no submit handler running).

**G. The save bar's "Save changes" button does not have form="dpForm"**
even though it's now visually outside the section that's inside the form.
This is the most likely cause given how the redesign restructured things.

### Step 3 — Hypotheses ranked by likelihood

**Most likely (D / G):** The "Save changes" button is now outside
`<form id="dpForm">`. Fix: add `form="dpForm"` attribute to the button,
OR move the save bar inside the form before `</form>`.

**Second most likely (A):** The photo upload `<form>` got nested inside
the main `<form>` during the redesign. Fix: move the photo form outside
the main form, or pull it out of whatever block contained it.

**Third (B):** A JS error in `syncAffils` / `syncCerts` / chipset code
throws on submit, preventing form submission. Fix: wrap the sync calls
in try/catch so a single broken sync doesn't block the whole submit.

**Long shot (F):** CSP blocking the inline script. Fix: pass the nonce
correctly or move the script to an external file in `/public/js/`.

### Step 4 — Fix the bugs

Once you've identified the root cause, fix it precisely. Each bug gets
its own commit:

```
fix(doctor): repair Save changes button on profile (associate with dpForm)

<explanation>
```

```
fix(doctor): repair photo upload on profile (form was nested inside dpForm)

<explanation>
```

If the same fix resolves both bugs (e.g. CSP nonce), one commit is fine.

### Step 5 — Verify

After fixes, restart the dev server and:
```
curl -s -o /dev/null -w "%{http_code}  /portal/doctor/profile\n" "http://localhost:3000/portal/doctor/profile"
```
Expect 302 (redirect to login). Then ASK THE USER to log in as a doctor and
manually verify:
- Type something in name, click Save, see "Saving…" → "All changes saved"
  in the save bar, then reload the page and confirm the value persisted
- Click Upload photo, select an image, see the avatar update

Do not declare success until the user confirms manual verification works.

### Step 6 — Document

Append a "Profile regressions FIXED" section to
`CLAUDE_CODE_BRIEF_PROFILE_PRESCRIBE.md` listing the commit SHA(s),
root cause, and fix.

Stop and report back. Do NOT proceed to Task 2 (Prescribe Form) — the
user wants to confirm the regressions are fully resolved before moving on.

---

## Backup files for reference

If you need to compare to the working pre-redesign version:
- `src/views/portal_doctor_profile.ejs.bak` — the version BEFORE commit `fe5df9d`. Look at how the save bar and photo form were structured there. Don't copy it whole — just diff against the current version to find what changed in the form/button structure.

---

## What "fixed" means

When you're done:
- Doctor types in any field, clicks "Save changes", refreshes the page,
  the new value is shown in the field. (Save round-trip works end-to-end.)
- Doctor clicks "Upload photo", selects a JPG/PNG, the avatar updates
  with the uploaded image. (Photo round-trip works end-to-end.)
- The fee-info card still shows 20% (don't undo the prior commit `75a5274`).
- All other doctor pages still work (smoke-test them after).
- Compiles. No console errors in the browser when loading the page.

That's the bar. If you can't get there, write what you tried to
`CLAUDE_CODE_QUESTIONS.md` and report back without claiming success.
