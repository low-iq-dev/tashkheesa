-- 033: Onboarding schema alignment (codification)
--
-- Captures the schema changes that were applied directly to production
-- as `020_onboarding_schema_alignment.sql` on 2026-05-01 but that never
-- landed in this repo's migrations directory. This migration is
-- idempotent — every change is guarded with IF NOT EXISTS / ON CONFLICT
-- so it's safe to apply on a fresh dev database AND a no-op on production
-- (where every change already exists).
--
-- Why this exists:
--   - A fresh `npm run migrate` against a blank Postgres should land the
--     schema in exactly the same state as production.
--   - 017_doctor_profile_fields.sql added the FIRST batch of doctor
--     profile fields. 023_users_signature_url.sql added signature_url.
--     This file adds the SECOND batch (national_id encryption, SLA tier
--     prefs, onboarding flag, demographics, capacity caps, availability
--     fields), the doctor_specialties junction, the pgcrypto extension
--     used to encrypt national_id, and the full specialty seed with
--     Arabic translations on all 27 rows.
--
-- Numbered 033 (not 020) because 020_orders_paid_at.sql already owns the
-- 020 slot in the local sequence. The on-prod naming collision is
-- harmless because schema_migrations is keyed on filename and the runner
-- in src/db.js is additive.

-- ─────────────────────────────────────────────────────────────────────
-- pgcrypto: needed for pgp_sym_encrypt(national_id, key) at signup time.
-- ─────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────
-- users: net-new columns (the ones 017 + 023 didn't add).
-- ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='national_id_encrypted') THEN
    ALTER TABLE users ADD COLUMN national_id_encrypted BYTEA;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='sla_tiers_supported') THEN
    ALTER TABLE users ADD COLUMN sla_tiers_supported JSONB DEFAULT '["standard"]'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='onboarding_complete') THEN
    ALTER TABLE users ADD COLUMN onboarding_complete BOOLEAN DEFAULT false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='date_of_birth') THEN
    ALTER TABLE users ADD COLUMN date_of_birth TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='gender') THEN
    ALTER TABLE users ADD COLUMN gender TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='max_active_cases') THEN
    ALTER TABLE users ADD COLUMN max_active_cases INTEGER DEFAULT 5;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='max_active_cases_urgent') THEN
    ALTER TABLE users ADD COLUMN max_active_cases_urgent INTEGER DEFAULT 8;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='is_available') THEN
    ALTER TABLE users ADD COLUMN is_available BOOLEAN DEFAULT true;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='last_seen_at') THEN
    ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMP;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- specialties: name_ar column for bilingual rendering.
-- 001_initial_tables.sql creates (id, name, is_visible) — no name_ar.
-- ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='specialties' AND column_name='name_ar') THEN
    ALTER TABLE specialties ADD COLUMN name_ar TEXT;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- doctor_specialties junction: supports primary + secondary specialties
-- per doctor. The schema mirrors what's live on prod exactly: text id PK,
-- text doctor_id + specialty_id (no FK; matches the rest of the schema's
-- application-level integrity model), single index on doctor_id.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_specialties (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL,
  specialty_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doctor_specialties_doctor ON doctor_specialties(doctor_id);

-- ─────────────────────────────────────────────────────────────────────
-- specialties seed: 27 rows with EN + AR names + visibility flag.
--
-- ON CONFLICT (id) DO UPDATE so this is:
--   * a full seed on a fresh DB (creates all 27 rows)
--   * a no-op on prod (every row already there with these values)
--   * a backfill if someone has older rows missing name_ar
--
-- Visibility flags match what's live on prod as of 2026-05-01.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO specialties (id, name, name_ar, is_visible) VALUES
  ('spec-anesthesiology',      'Anesthesiology',           'التخدير',                    true),
  ('spec-cardiology',          'Cardiology',               'أمراض القلب',               true),
  ('spec-cardiothoracic',      'Cardiothoracic Surgery',   'جراحة القلب والصدر',         true),
  ('spec-clinical-nutrition',  'Clinical Nutrition',       'التغذية العلاجية',           true),
  ('spec-dermatology',         'Dermatology',              'الأمراض الجلدية',           true),
  ('spec-emergency-medicine',  'Emergency Medicine',       'طب الطوارئ',                true),
  ('spec-endocrinology',       'Endocrinology',            'الغدد الصماء',              true),
  ('spec-ent',                 'ENT',                      'أنف وأذن وحنجرة',           false),
  ('spec-gastroenterology',    'Gastroenterology',         'الجهاز الهضمي',             true),
  ('spec-general-surgery',     'General Surgery',          'الجراحة العامة',             false),
  ('spec-hematology',          'Hematology',               'أمراض الدم',                true),
  ('spec-internal-medicine',   'Internal Medicine',        'الباطنة',                   false),
  ('lab_pathology',            'Lab & Pathology',          'المختبر وعلم الأمراض',       false),
  ('spec-nephrology',          'Nephrology',               'أمراض الكلى',               true),
  ('spec-neurology',           'Neurology',                'المخ والأعصاب',             true),
  ('spec-obgyn',               'OB/GYN',                   'النساء والتوليد',           true),
  ('spec-oncology',            'Oncology',                 'الأورام',                   true),
  ('spec-ophthalmology',       'Ophthalmology',            'طب العيون',                 true),
  ('spec-orthopedics',         'Orthopedics',              'العظام',                    true),
  ('spec-pathology',           'Pathology',                'علم الأمراض',               true),
  ('spec-pediatrics',          'Pediatrics',               'طب الأطفال',                false),
  ('spec-psychiatry',          'Psychiatry',               'الطب النفسي',               true),
  ('spec-pulmonology',         'Pulmonology',              'أمراض الصدر',               true),
  ('spec-radiology',           'Radiology',                'الأشعة',                    true),
  ('spec-rheumatology',        'Rheumatology',             'أمراض الروماتيزم',          true),
  ('spec-urology',             'Urology',                  'المسالك البولية',           true),
  ('spec-vascular-surgery',    'Vascular Surgery',         'جراحة الأوعية الدموية',     true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  name_ar = EXCLUDED.name_ar,
  is_visible = EXCLUDED.is_visible;
