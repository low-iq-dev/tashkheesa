-- 014: Add accept_by_at column to doctor_assignments (required by case_lifecycle.js and case_sla_worker.js)
ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS accept_by_at TIMESTAMP;
