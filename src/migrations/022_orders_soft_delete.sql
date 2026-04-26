-- Soft-delete support for unpaid expired orders.
-- Set when an unpaid case has been in expired_unpaid for >24h (total 48h since creation).
-- Hard purge happens 90 days later via scripts/purge_old_deleted_orders.js.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at) WHERE deleted_at IS NOT NULL;
