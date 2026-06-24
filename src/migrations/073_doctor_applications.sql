-- 073_doctor_applications.sql
-- Public doctor-application STAGING table.
--
-- Applications are NOT doctors. Nothing in slice 1 writes to `users`; this table
-- is a separate staging surface that a Command "Applications" review (slice 2)
-- later promotes into `users` as a pending doctor. specialty_id stores the
-- applicant's chosen taxonomy id (spec-* slug) OR the literal 'other'; the
-- slice-2 promotion is responsible for mapping it onto users.specialty_id.
--
-- Self-idempotent (IF NOT EXISTS / guarded DO block): the boot-time runner
-- (src/db.js) sends the whole file in one query and records it by filename.

CREATE TABLE IF NOT EXISTS doctor_applications (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             timestamptz NOT NULL DEFAULT NOW(),
  status                 text        NOT NULL DEFAULT 'new',   -- new | reviewed | promoted | rejected
  full_name              text        NOT NULL,
  full_name_ar           text,
  email                  text        NOT NULL,
  phone                  text        NOT NULL,
  specialty_id           text        NOT NULL,                 -- taxonomy id (spec-*) OR 'other'
  specialty_other        text,                                 -- the free-text when specialty_id = 'other'
  sub_specialties        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  medical_license_number text,
  license_country        text,
  bio                    text,
  bio_ar                 text,
  cv_url                 text,
  current_affiliation    text,
  years_experience       integer,
  source                 text        NOT NULL DEFAULT 'web_apply',
  submitter_ip           text,                                 -- spam forensics
  user_agent             text,                                 -- spam forensics
  review_notes           text                                  -- slice-2 reviewer field
);

-- status domain guard (idempotent add).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'doctor_applications_status_chk'
  ) THEN
    ALTER TABLE doctor_applications
      ADD CONSTRAINT doctor_applications_status_chk
      CHECK (status IN ('new', 'reviewed', 'promoted', 'rejected'));
  END IF;
END $$;

-- Review queue: newest-first within a status (the slice-2 list query).
CREATE INDEX IF NOT EXISTS idx_doctor_applications_status_created
  ON doctor_applications (status, created_at DESC);

-- Match the 070 default-deny RLS posture. The app connects as the table owner
-- (RLS-bypass), so this does NOT affect the app's reads/writes; it denies every
-- other role by default (no policies = deny all). ENABLE is idempotent.
ALTER TABLE doctor_applications ENABLE ROW LEVEL SECURITY;
