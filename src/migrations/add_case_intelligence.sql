-- Case Intelligence Migration
-- Adds AI extraction/processing columns to existing case_files table,
-- creates case_extractions table, and adds intelligence_status to cases.
--
-- NOTE: This SQL is reference documentation. The actual migration runs
-- via migrateCaseIntelligence() in src/db.js using the colExists() pattern.
--
-- Existing case_files columns (unchanged):
--   id TEXT PK, case_id TEXT, filename TEXT, file_type TEXT,
--   storage_path TEXT, uploaded_at TIMESTAMP, is_valid BOOLEAN

-- =============================================
-- 1. Extend case_files with processing columns
-- =============================================

ALTER TABLE case_files ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'pending';
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS extracted_text TEXT;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS structured_data JSONB;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS document_category TEXT;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS language_detected TEXT;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS processing_error TEXT;
ALTER TABLE case_files ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP;

-- document_category: lab_report, imaging, referral_letter, prescription, intake_form, other, unknown
-- processing_status: pending, processing, extracted, failed
-- language_detected: ar, en, mixed

CREATE INDEX IF NOT EXISTS idx_case_files_case_id ON case_files(case_id);
CREATE INDEX IF NOT EXISTS idx_case_files_processing_status ON case_files(processing_status);

-- =============================================
-- 2. Create case_extractions table
-- =============================================

CREATE TABLE IF NOT EXISTS case_extractions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE,
  lab_values JSONB,
  patient_info JSONB,
  documents_inventory JSONB,
  missing_documents JSONB,
  extraction_metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- lab_values: array of {test, value, unit, reference_range, status}
--   status is ONLY: 'above', 'below', 'in_range'
--
-- patient_info: {age, gender, complaint, medications, allergies, family_history}
--   each field includes source_file
--
-- documents_inventory: array of {filename, type, pages, language, extracted}
--
-- missing_documents: array of strings (common docs that are absent)
--
-- extraction_metadata: {processing_time_ms, files_processed, ocr_language}

CREATE INDEX IF NOT EXISTS idx_case_extractions_case_id ON case_extractions(case_id);

-- =============================================
-- 3. Add intelligence_status to cases table
-- =============================================

ALTER TABLE cases ADD COLUMN IF NOT EXISTS intelligence_status TEXT DEFAULT 'none';

-- intelligence_status: none, processing, ready, failed
