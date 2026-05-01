-- 035_error_logs_category.sql
-- Adds a category column to error_logs so audit-trail rows can be filtered
-- without parsing the JSON context blob.
--
-- BACKGROUND: the new GET /admin/doctors/:id/national-id endpoint
-- (src/routes/admin.js) writes one row per access with level='audit' and
-- category='admin_audit'. Storing the category in its own column lets us
-- query "show all admin national-ID views" with a fast indexed scan
-- instead of `context::jsonb @> '{"category":"admin_audit"}'` over the
-- whole table. Future audit categories (e.g. 'pii_export', 'role_change')
-- can reuse the same column.
--
-- Old rows pre-dating this migration have category=NULL — intentional.
-- They are pre-audit-log error rows; not backfilling avoids implying
-- they're audit events.

ALTER TABLE error_logs
  ADD COLUMN IF NOT EXISTS category TEXT;

-- Partial index: skip the ~all NULL rows that exist today and most rows
-- going forward (real errors won't set category). Keeps the index tiny
-- and lookups by category cheap.
CREATE INDEX IF NOT EXISTS idx_error_logs_category
  ON error_logs(category)
  WHERE category IS NOT NULL;
