-- 012: Website intake columns on orders
-- Adds 4 columns so the public website intake form can persist its fields
-- as proper queryable columns rather than stuffing them into orders.notes.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS clinical_question TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS case_files_url    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS test_type         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source            TEXT DEFAULT 'website_portal';
