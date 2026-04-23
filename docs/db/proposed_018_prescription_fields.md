# Proposed migration: 018_prescription_fields.sql

Status: **PROPOSED — NOT YET CREATED IN `src/migrations/`.**
Required to fully back the redesigned prescription form at
`/portal/doctor/case/:caseId/prescribe` (redesigned in
`feature/doctor-prescribe-redesign`).

Until this lands, the view renders the corresponding inputs but they are
either (a) not submitted, (b) submitted but ignored by the handler, or
(c) stored client-side only (localStorage draft). Each unbacked input is
marked `<!-- TODO(...) -->` in `src/views/doctor_prescribe.ejs` and each
ignored field is also noted in the POST handler in
`src/routes/prescriptions.js`.

## UI-only fields flagged in the view

| Field (form name)  | Section | Why it's unbacked                                  |
|--------------------|---------|----------------------------------------------------|
| `diagnosis_ar`     | 01      | `prescriptions` has only `diagnosis TEXT`          |
| `instructions_ar`  | 03      | `prescriptions.notes` is a single column (EN only) |
| `med_notes[]`      | 02      | Handler hardcodes each med row's `instructions: ''` instead of persisting `med_notes[]` — no schema change needed, just handler wiring |
| `refills`          | 04      | `prescriptions` has no `refills` column            |
| signature preview  | 05      | `users` has no `signature_url` / `signature_blob` column; UI shows "No signature on file" permanently |
| `Save as draft`    | 05      | No draft endpoint; button re-triggers the same client-side autosave |
| Autosave pill      | header  | No `POST /.../prescribe/draft` endpoint; state lives in `localStorage[dpx_draft_<caseId>_v1]` |

## Proposed SQL

```sql
-- 018: Prescription form extended fields
--
-- Backs the redesigned /portal/doctor/case/:caseId/prescribe view. Adds
-- columns for fields the new UI surfaces but which weren't tracked in
-- the prescriptions schema before:
--   - Arabic diagnosis (for bilingual PDFs)
--   - Arabic patient instructions (for bilingual PDFs)
--   - refills (SMALLINT 0..12, clamped in the handler)
-- Also adds a signature column on users so the PDF stamping flow has
-- something to blit onto the signed document.
--
-- Per-med instructions DO NOT need a column — the medications JSON on
-- the prescriptions row already has an `instructions` slot on each item
-- which the current handler just hardcodes to ''. The new handler needs
-- to read `med_notes[]` from the form and assign it into that slot.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prescriptions' AND column_name='diagnosis_ar') THEN
    ALTER TABLE prescriptions ADD COLUMN diagnosis_ar TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prescriptions' AND column_name='instructions_ar') THEN
    ALTER TABLE prescriptions ADD COLUMN instructions_ar TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prescriptions' AND column_name='refills') THEN
    ALTER TABLE prescriptions ADD COLUMN refills SMALLINT DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='signature_url') THEN
    ALTER TABLE users ADD COLUMN signature_url TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='signature_updated_at') THEN
    ALTER TABLE users ADD COLUMN signature_updated_at TIMESTAMP;
  END IF;
END $$;
```

## Handler changes required once the migration lands

In `src/routes/prescriptions.js`, the POST handler at
`POST /portal/doctor/case/:caseId/prescribe`:

1. **Wire the three new prescription fields into `INSERT`**. Sketch:
   ```js
   var diagnosis_ar = sanitizeHtml(sanitizeString(req.body.diagnosis_ar || '', 5000));
   var instructions_ar = sanitizeHtml(sanitizeString(req.body.instructions_ar || '', 5000));
   var refills = Math.max(0, Math.min(12, parseInt(req.body.refills, 10) || 0));
   // extend the INSERT column list + VALUES with diagnosis_ar, instructions_ar, refills
   ```

2. **Read `med_notes[]` into the medications JSON**. No schema change —
   just replace the current hardcoded empty string:
   ```js
   var medNotes = [].concat(req.body.med_notes || []);
   // inside the for-loop:
   medications.push({
     name, dosage, frequency, duration,
     instructions: sanitizeString(medNotes[i] || '', 500)
   });
   ```

3. **Stamp the signature on the PDF**. Out of scope for migration 018 —
   depends on the PDF-generation path and a signature-upload flow on the
   profile page. File upload (`prescription_file`) continues to work as
   the current fallback until the PDF stamping lands.

4. **Draft endpoint (optional)**. A `POST /portal/doctor/case/:id/prescribe/draft`
   that writes to a `prescription_drafts` table (or a `prescriptions`
   row with `is_active=false`) would let the autosave pill become server-
   backed. Not required to ship the form — the client-side localStorage
   path covers the solo-browser case.

The corresponding GET handler should pass the persisted fields into the
view so doctors returning to a draft (once that's server-backed) see
pre-filled values:
```js
res.render('doctor_prescribe', {
  ...,
  draft: existingDraft ? {
    diagnosis: existingDraft.diagnosis,
    diagnosis_ar: existingDraft.diagnosis_ar,
    notes: existingDraft.notes,
    instructions_ar: existingDraft.instructions_ar,
    refills: existingDraft.refills,
    medications: JSON.parse(existingDraft.medications || '[]')
  } : null
});
```
The view would then pre-fill via the same `restore()` path that today
reads from `localStorage`.

## Medication suggestion source

The new view ships with a temporary hardcoded list of 25 cardiology-heavy
medication names in `window.__DPX_MED_SUGGESTIONS__` at the top of
`src/views/doctor_prescribe.ejs`. That should be replaced with a
DB-backed autocomplete:

- Option A: a `medications` catalog table (`id, name, generic_name,
  class, is_active`) + `GET /api/meds?q=...` returning top-N matches.
- Option B: RxNorm/FDA external source cached locally.

Either way, the view change is a one-line swap in the autocomplete
wiring; the constant is deliberately kept at file-top for that reason.

## Deployment order

1. Merge this proposal into `src/migrations/018_prescription_fields.sql`
   when ready. The migration is column-additive and idempotent.
2. Extend the POST handler per the sketches above.
3. Extend the GET handler to pass any persisted draft into the view.
4. Remove the `TODO(schema:)` / `TODO(handler:)` markers in
   `src/views/doctor_prescribe.ejs` as each field gets wired.
5. Signature-stamping and draft endpoint are separate tracks and do not
   block 018.

## Rollback

Column-additive and idempotent. A rollback simply drops the columns:

```sql
ALTER TABLE prescriptions
  DROP COLUMN IF EXISTS diagnosis_ar,
  DROP COLUMN IF EXISTS instructions_ar,
  DROP COLUMN IF EXISTS refills;

ALTER TABLE users
  DROP COLUMN IF EXISTS signature_url,
  DROP COLUMN IF EXISTS signature_updated_at;

DELETE FROM schema_migrations WHERE filename = '018_prescription_fields.sql';
```
