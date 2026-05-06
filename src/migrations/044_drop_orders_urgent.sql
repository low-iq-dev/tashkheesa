-- 044: Drop the legacy orders.urgent column.
--
-- Migration 010 (2026-04-15) already DROPped this column when it
-- migrated values to orders.urgency_flag. The deleted boot script
-- src/migrate_mobile_api.js was re-adding it on every cold start
-- (BOOLEAN DEFAULT false, never read by any application code —
-- orders.urgency_flag is the canonical field per migration 010 + 016).
-- With the boot path removed in this PR, this migration cleans the
-- empty zombie column off production once and for all.
--
-- DROP COLUMN IF EXISTS so a fresh DB built from src/migrations/
-- alone (where 010 has already removed urgent and the boot path no
-- longer exists) gracefully skips this no-op.

ALTER TABLE orders DROP COLUMN IF EXISTS urgent;
