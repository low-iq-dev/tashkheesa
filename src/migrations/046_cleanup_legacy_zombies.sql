-- 046: Defensive cleanup for two zombie schema artifacts.
--
-- (a) `orders.urgent` — migration 044 issues `ALTER TABLE orders DROP
--     COLUMN IF EXISTS urgent`. On at least one local migrate() run,
--     044 was recorded as executed in schema_migrations but the column
--     was observed to survive. Forensic re-run via pool.query (same
--     SQL, isolated) drops the column cleanly every time. Cause
--     unknown — possibly a transient pg-node / Postgres edge case.
--     This migration re-issues the DROP unconditionally as
--     defense-in-depth. If 044 already completed correctly on prod,
--     this is a no-op (DROP COLUMN IF EXISTS is safe).
--
-- (b) `payments` table — migration 042 successfully dropped this
--     table when it was empty. Until this PR, the deleted boot
--     script src/migrate_mobile_api.js was re-creating it empty on
--     every cold start, so production carries the table even though
--     the migration history says it was dropped. Phase 2 of Theme 1
--     removed the boot script; Phase 3 migrated all readers off the
--     table (the mobile case-detail endpoint now sources its payment
--     fields from `orders` columns). The empty zombie table is now
--     safe to remove for good.
--
-- Both ops are idempotent — fresh DBs built from src/migrations/
-- alone never produce these artifacts in the first place.

ALTER TABLE orders DROP COLUMN IF EXISTS urgent;
DROP TABLE IF EXISTS payments;
