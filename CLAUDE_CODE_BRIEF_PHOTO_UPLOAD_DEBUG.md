# Claude Code Brief — Doctor profile photo upload still broken

**Branch:** `feat/doctor-portal-v2-warm-clinical`
**Created:** April 28, 2026
**Last commit:** `5cc5863` (which was supposed to fix the photo upload but didn't)

---

## Status

The user has now reported photo upload broken **twice** after we thought
we'd fixed it:

- `fec70a5` — first fix attempt: de-nested the photo `<form>` tags out of
  `#dpForm`. Reasoning: nested forms close the outer form on `</form>`.
  This DID restore the main "Save changes" button. Did NOT fix photo upload.
- `5cc5863` — second fix attempt: moved the file input inside
  `#dpPhotoForm` (it had been outside, linked via `form="..."`, but
  programmatic `.submit()` doesn't enumerate cross-form children).
  Reasoning was sound. User reports it still doesn't work.

**Two failed guesses is enough — stop hypothesising and start measuring.**

---

## Hard constraints

- **CSS + EJS only.** Do NOT modify `src/routes/doctor.js`, the multer
  middleware (`src/middleware/upload.js`), the schema, or any package.
- The photo upload handler at `src/routes/doctor.js:2131`
  (`router.post('/portal/doctor/profile/photo', ...)`) was working
  before the redesign. The bug is in the view layer.
- Stay on branch `feat/doctor-portal-v2-warm-clinical`. Don't push.
- Don't delete `.bak` files.
- Don't touch anything other than `src/views/portal_doctor_profile.ejs`
  unless you have a strong, evidenced reason.

---

## Step 1 — REPRODUCE WITH EVIDENCE (mandatory before any code change)

You MUST gather concrete data before guessing again. The user has been
patient and we've burned two attempts on plausible-sounding guesses.

### 1a. Boot the server cleanly
```
lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill -9 2>/dev/null
cd ~/tashkheesa-portal
nohup npm run dev > /tmp/tashkheesa-dev.log 2>&1 &
sleep 3
tail -20 /tmp/tashkheesa-dev.log
```

Confirm the dev server is up and watch the log file for activity. Leave
this terminal/tail running while you test.

### 1b. Get a doctor session cookie

There's a demo doctor account; check `seed.js`, `seeds/`, or
`scripts/seed*.js` for credentials, or look at how other portal smoke
tests authenticate. If you find a doctor with `email = 'dr.radiology@tashkheesa.com'`
or similar, use that. If you can't authenticate via curl, ask the user
to copy their session cookie from DevTools → Application → Cookies and
paste it. Don't guess at cookies.

### 1c. Hit the upload endpoint with a real multipart payload

With a valid session cookie, run:

```bash
# Create a tiny valid JPEG (a 1x1 pixel image is enough to verify the
# pipe; the route's dimension check will reject it but multer will
# definitely have processed the upload, which is what we're testing).
# Or use any real JPG you have on disk.

FIXTURE=/tmp/test_doctor_photo.jpg
# Make a 500x500 white JPEG using ImageMagick if available, else download:
if command -v magick >/dev/null 2>&1; then
  magick -size 500x500 xc:white "$FIXTURE"
elif command -v convert >/dev/null 2>&1; then
  convert -size 500x500 xc:white "$FIXTURE"
else
  echo "No ImageMagick — please ask user for a real test photo"
  exit 1
fi

# Get CSRF token from the GET page first (the form embeds one via csrfField())
CSRF=$(curl -s --cookie /tmp/doctor.cookies "http://localhost:3000/portal/doctor/profile" \
  | grep -oE 'name="_csrf"[^>]*value="[^"]+"' | head -1 \
  | sed -E 's/.*value="([^"]+)".*/\1/')
echo "CSRF token: $CSRF"

# Now POST the photo
curl -v --cookie /tmp/doctor.cookies \
     -F "_csrf=$CSRF" \
     -F "photo=@$FIXTURE;type=image/jpeg" \
     "http://localhost:3000/portal/doctor/profile/photo" 2>&1 | tee /tmp/upload-result.txt
```

**Capture the response status code and Location header, AND watch
`/tmp/tashkheesa-dev.log` in another window for what the server logs.**

### 1d. Decide what's actually broken

Based on the curl result, classify the bug:

| Curl result | Server log | What it means |
|---|---|---|
| 302 → `/portal/doctor/profile?photoError=...` | shows `[doctor-profile-photo] multer error...` | **Multer rejected the file** — read the message, it tells you why (no file, wrong MIME, too large, dimension fail) |
| 302 → `/portal/doctor/profile?photoError=no_file` | "No file selected" | **Multer ran but received no file** — the form is wrong, the field name is wrong, or enctype is wrong |
| 302 → `/portal/doctor/profile` (no error qs) | success log | **Upload succeeded server-side** — bug is purely client-side (avatar not refreshing on the page) |
| 403 / 419 | nothing or "csrf" | **CSRF token mismatch** — likely cause: the photo form's CSRF field doesn't match the session because the page was rendered with a different session, or `csrfField()` returned empty |
| 400 / 500 | full stack trace | **Different problem entirely** — read the trace, fix what it says |

**Do not skip this step. Do not move on until you have one of those
rows next to a real curl response. The user has already reported broken
twice; we need to KNOW, not guess.**

---

## Step 2 — Likely root causes ranked by what curl will tell you

After you have the curl evidence, here are the candidates ranked by
prior probability:

### Candidate A: CSRF middleware rejecting the request

If your project uses `csurf` or similar, check `src/middleware/` and
the app bootstrap (`src/app.js` / `src/server.js`). Look for:
- Is CSRF protection mounted globally or per-route?
- Does `/portal/doctor/profile/photo` need a CSRF token?
- Does `csrfField()` actually output a hidden input, or does it return
  empty in this context?

The current photo form embeds `<%- (typeof csrfField === 'function')
? csrfField() : '' %>`. If `csrfField` is undefined, that returns
`''` and the POST has no CSRF token. The multer middleware runs, sees
no file (or the CSRF middleware rejects before multer), and returns.

**To verify:** view-source on the rendered page, find `<form id="dpPhotoForm">`,
check if there's a `<input type="hidden" name="_csrf" ...>` inside it.
If not, that's the bug.

**Fix if so:** ensure the photo form gets a CSRF token. Compare to how
the main `#dpForm` does it — both use the same pattern, so if dpForm
works for save, dpPhotoForm should too. But check if there's a
content-type issue: csurf may be configured to skip CSRF validation
when content-type is `multipart/form-data` (some setups do this), or
it may require the token in a specific field name.

### Candidate B: Multer rejecting the file

If curl shows a `photoError=` redirect, read the error message. Common
causes:
- File MIME type rejected (the `fileFilter` in `src/middleware/upload.js`
  rejects `image/jpeg` if it doesn't match the allowed list — but it
  IS allowed, so this shouldn't be it)
- File extension allowlist mismatch — but `.jpg` is in `ALLOWED_EXTS`
- Browser is sending the file with an unexpected MIME type — unlikely
  in our case since curl explicitly sets `type=image/jpeg`

### Candidate C: Photo form's `<input>` somehow still not enumerated

Even after my last fix that put the input inside the form, there might
be:
- A second hidden form (`dpPhotoRemoveForm`) interfering — it's
  rendered with `style="display:none"` but still has its own controls
- The whole `<form id="dpPhotoForm">` has `style="display:none"
  aria-hidden="true"` — does that affect form submission? It SHOULDN'T
  per the HTML spec, but Chrome has been weird about hidden form
  submission in the past. **Test by removing the `display:none` and
  `aria-hidden` from `<form id="dpPhotoForm">` and seeing if the
  upload then works.** If it does, find a different way to hide it
  (visibility:hidden, or position:absolute;left:-9999px).

### Candidate D: nodemon didn't pick up the EJS change

Long-shot but worth checking. Verify the running server's compiled
view matches the file on disk:
- Look at the rendered HTML at `/portal/doctor/profile` (curl it with
  the cookie)
- Search for `id="dpPhotoFile"` — confirm it's inside `<form id="dpPhotoForm">`
  (if it's not, the user's nodemon never reloaded after commit `5cc5863`)
- If the file input is in the wrong place in the rendered HTML, the
  fix is "user needs to restart the dev server" — tell them so, don't
  write more code.

---

## Step 3 — Write the targeted fix

Once you know from curl evidence what's wrong, write the smallest
possible fix. NOT a rewrite of the photo upload UX. NOT a full refactor.

Commit message format:
```
fix(doctor): photo upload — <root cause in 5-8 words>

<paragraph: what curl showed, what the actual cause was, why prior
attempts failed, what the fix does, what stays the same>
```

---

## Step 4 — Verify with the SAME curl test

After your fix, re-run the curl from Step 1c. Confirm:
- HTTP 302 with no `photoError=` query string in the Location header
- Server log shows the upload succeeded
- The DB row for the doctor has `profile_photo_url` populated (query it
  with `psql` if you have access; otherwise check the user via the GET
  page after the upload)

**Then** ask the user to refresh their browser page and confirm the
avatar shows the uploaded image. Don't claim done until they confirm.

---

## Step 5 — Document

Append a "Photo upload FIXED (round 3)" section to
`CLAUDE_CODE_BRIEF_PROFILE_PRESCRIBE.md`:
- Commit SHA
- The actual root cause (with curl evidence quoted)
- Why the previous two attempts didn't catch it
- One-line description of the fix

Stop and report back. Do NOT proceed to Task 2 (Prescribe Form).

---

## What "fixed" means

- Doctor clicks "Upload photo", picks a real JPG, sees their avatar
  update. Reload the page — avatar persists.
- The fee-info card still shows 20% (don't undo prior commits).
- All other doctor pages still work.
- Compiles. No console errors. No 500s.

---

## A note on debugging discipline

The user has been generous with their patience. We've now burned three
rounds on this single bug:
- Round 1: nested forms theory (correct cause for save bug, half-correct for photo)
- Round 2: cross-form input theory (correct in principle, didn't fix it)
- Round 3 (you): must be evidence-driven

If you find yourself thinking "I bet it's X" before running curl,
stop and run curl. The cost of one curl test is 30 seconds. The cost
of another wrong guess is the user's trust in this entire workstream.
