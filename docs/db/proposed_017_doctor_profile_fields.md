# Migration 017 — doctor profile fields (SHIPPED)

Status: **APPLIED** — see `src/migrations/017_doctor_profile_fields.sql`.
Backs the redesigned doctor profile page at `/portal/doctor/profile`.

Shipped version added **12 columns** (the 11 originally proposed below
plus `profile_photo_url`, which was folded in because the migration
runner in `src/db.js` records each filename in `schema_migrations` and
won't re-run a modified file — so all profile-related columns had to
land atomically in one file).

Previously, the view rendered the corresponding inputs but they were either not submitted (read-only on the server side) or silently ignored by the existing POST handler. Each unbacked input was marked `<!-- TODO: needs schema + handler -->` in `src/views/doctor_profile.ejs`.

## Proposed SQL

```sql
-- 017: Doctor profile extended fields
--
-- Backs the redesigned /portal/doctor/profile view. Adds columns for
-- fields the new UI surfaces but which weren't tracked in the users
-- schema before:
--   - Arabic name and Arabic bio (for bilingual display on reports
--     and the patient-facing doctor directory)
--   - Professional credential fields (license #, license country,
--     medical school, graduation year, years of experience)
--   - Three JSONB arrays: sub-specialties, spoken languages, and
--     hospital affiliations (list of { name, role })
--   - Certifications JSONB array (list of { name, body, year })
--
-- JSONB was chosen over separate tables for v1 because these lists
-- are small (<20 items), rendered together with the parent user, and
-- not queried across users. If we later need to filter doctors by
-- sub-specialty, we can promote sub_specialties to a join table at
-- that point.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='name_ar') THEN
    ALTER TABLE users ADD COLUMN name_ar TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='bio_ar') THEN
    ALTER TABLE users ADD COLUMN bio_ar TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='years_of_experience') THEN
    ALTER TABLE users ADD COLUMN years_of_experience INTEGER;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='medical_license_number') THEN
    ALTER TABLE users ADD COLUMN medical_license_number TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='license_country') THEN
    ALTER TABLE users ADD COLUMN license_country TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='medical_school') THEN
    ALTER TABLE users ADD COLUMN medical_school TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='graduation_year') THEN
    ALTER TABLE users ADD COLUMN graduation_year INTEGER;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='sub_specialties') THEN
    ALTER TABLE users ADD COLUMN sub_specialties JSONB DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='spoken_languages') THEN
    ALTER TABLE users ADD COLUMN spoken_languages JSONB DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='affiliations') THEN
    ALTER TABLE users ADD COLUMN affiliations JSONB DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='certifications') THEN
    ALTER TABLE users ADD COLUMN certifications JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;
```

## Columns already present and wired in this branch (no migration needed)

The POST handler was extended to also persist two existing columns that the new form now surfaces:

- `date_of_birth` TEXT — already present in `users`
- `country_code` TEXT — already present in `users`

Plus the four previously-wired fields that still work as before:
- `name`, `phone`, `bio`, `specialty_id`

## Deployment order

1. Merge this proposal into `src/migrations/017_doctor_profile_fields.sql` when ready.
2. Extend the POST handler in `src/routes/doctor.js` to destructure and persist the new columns. Sketch:
   ```js
   const {
     name, phone, bio, specialty_id,
     date_of_birth, country_code,
     name_ar, bio_ar, years_of_experience,
     medical_license_number, license_country,
     medical_school, graduation_year,
     sub_specialties, spoken_languages,   // arrays (form submits as string[])
     affiliations, certifications         // array of objects
   } = req.body;
   ```
   For the JSONB columns, the form submits them via `name="sub_specialties[]"` etc. (chipset) and `name="certifications[][name]"` etc. (repeater). Parse into arrays before persisting — consider a small helper like `toJsonbArray(req.body.sub_specialties)` that normalizes missing / single-value / many-value cases.
3. Extend the GET handler to pass the new fields into the view:
   ```js
   res.render('doctor_profile', { ..., doctor: { ...doctor } });
   ```
   and update `doctor_profile.ejs` to pre-fill the corresponding inputs from `_doctor.name_ar`, `_doctor.bio_ar`, etc. (today the view hard-codes empty values for all UI-only inputs).
4. License-field changes should trigger a re-verification flow — not in scope for the schema migration itself. The view already surfaces the "Requires re-verification" note next to the license input.
5. Avatar upload (`Change photo`, `Remove`) is also TODO — needs a storage destination (R2 or similar), an `avatar_url` column, and an upload handler. Tracked separately; not in this migration.

## Rollback

This migration is column-additive and idempotent. A rollback simply drops the columns:

```sql
ALTER TABLE users
  DROP COLUMN IF EXISTS name_ar,
  DROP COLUMN IF EXISTS bio_ar,
  DROP COLUMN IF EXISTS years_of_experience,
  DROP COLUMN IF EXISTS medical_license_number,
  DROP COLUMN IF EXISTS license_country,
  DROP COLUMN IF EXISTS medical_school,
  DROP COLUMN IF EXISTS graduation_year,
  DROP COLUMN IF EXISTS sub_specialties,
  DROP COLUMN IF EXISTS spoken_languages,
  DROP COLUMN IF EXISTS affiliations,
  DROP COLUMN IF EXISTS certifications;

DELETE FROM schema_migrations WHERE filename = '017_doctor_profile_fields.sql';
```
