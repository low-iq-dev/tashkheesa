-- Soft-delete support for unpaid expired orders.
-- Set when an unpaid case has been in expired_unpaid for >24h (total 48h since creation).
-- 2026-08-26: this line used to read "Hard purge happens 90 days later via
-- scripts/purge_old_deleted_orders.js", which was never true — nothing
-- scheduled that script and it was never run. It read as a guarantee that
-- purging was handled, which is why nobody looked at it for four months.
-- Purging is now scripts/retention_purge.js, and it is OFF: it writes only
-- with RETENTION_PURGE_ENABLED=true and --apply. Comment-only edit to an
-- already-applied migration; the runner tracks by filename and will never
-- re-read this file.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at) WHERE deleted_at IS NOT NULL;
