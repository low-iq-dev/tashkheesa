-- 007: Case intelligence (AI extraction pipeline)

-- ============================================================
-- case_files — additional columns for AI processing
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='file_size_bytes') THEN
    ALTER TABLE case_files ADD COLUMN file_size_bytes INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='mime_type') THEN
    ALTER TABLE case_files ADD COLUMN mime_type TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='processing_status') THEN
    ALTER TABLE case_files ADD COLUMN processing_status TEXT DEFAULT 'pending';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='extracted_text') THEN
    ALTER TABLE case_files ADD COLUMN extracted_text TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='structured_data') THEN
    ALTER TABLE case_files ADD COLUMN structured_data JSONB;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='document_category') THEN
    ALTER TABLE case_files ADD COLUMN document_category TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='language_detected') THEN
    ALTER TABLE case_files ADD COLUMN language_detected TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='processing_error') THEN
    ALTER TABLE case_files ADD COLUMN processing_error TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='case_files' AND column_name='processed_at') THEN
    ALTER TABLE case_files ADD COLUMN processed_at TIMESTAMP;
  END IF;
END $$;

-- ============================================================
-- case_extractions — aggregated AI extraction results per case
-- ============================================================
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

-- ============================================================
-- cases — intelligence status tracking
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cases' AND column_name='intelligence_status') THEN
    ALTER TABLE cases ADD COLUMN intelligence_status TEXT DEFAULT 'none';
  END IF;
END $$;

-- ============================================================
-- Indexes for case intelligence queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_case_files_case_id ON case_files(case_id);
CREATE INDEX IF NOT EXISTS idx_case_files_processing_status ON case_files(processing_status);
CREATE INDEX IF NOT EXISTS idx_case_extractions_case_id ON case_extractions(case_id);
