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
--     hospital affiliations (list of { name, role, primary })
--   - Certifications JSONB array (list of { name, body, year })
--   - Profile photo URL (added alongside the runbook's 11 columns
--     because the migration runner in src/db.js records each filename
--     in schema_migrations — so both land atomically here rather than
--     in a separate 018 file).
--
-- JSONB was chosen over separate tables for v1 because these lists are
-- small (<20 items), rendered together with the parent user, and not
-- queried across users. If we later need to filter doctors by sub-
-- specialty we can promote sub_specialties to a join table then.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='name_ar') THEN
    ALTER TABLE users ADD COLUMN name_ar TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='bio_ar') THEN
    ALTER TABLE users ADD COLUMN bio_ar TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='years_of_experience') THEN
    ALTER TABLE users ADD COLUMN years_of_experience INTEGER;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='medical_license_number') THEN
    ALTER TABLE users ADD COLUMN medical_license_number TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='license_country') THEN
    ALTER TABLE users ADD COLUMN license_country TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='medical_school') THEN
    ALTER TABLE users ADD COLUMN medical_school TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='graduation_year') THEN
    ALTER TABLE users ADD COLUMN graduation_year INTEGER;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='sub_specialties') THEN
    ALTER TABLE users ADD COLUMN sub_specialties JSONB DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='spoken_languages') THEN
    ALTER TABLE users ADD COLUMN spoken_languages JSONB DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='affiliations') THEN
    ALTER TABLE users ADD COLUMN affiliations JSONB DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='certifications') THEN
    ALTER TABLE users ADD COLUMN certifications JSONB DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='profile_photo_url') THEN
    ALTER TABLE users ADD COLUMN profile_photo_url TEXT;
  END IF;
END $$;
