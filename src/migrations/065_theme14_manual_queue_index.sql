-- 065_theme14_manual_queue_index.sql
--
-- Theme 14 Phase 5 — Manual queue list page (GET /superadmin/manual-queue)
-- reads `orders WHERE completed_at IS NULL AND assignment_status =
-- 'manual_queue'`. The existing partial index from migration 056 covers
-- 'manual_pending'; this migration adds a sibling partial index keyed to
-- the Phase 5 manual_queue bucket so the list query stays index-only as
-- volume grows.
--
-- Additive + idempotent — safe to run repeatedly and to apply on Render
-- boot without prior approval.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_orders_assignment_status_manual_queue
  ON orders(assignment_status)
  WHERE assignment_status = 'manual_queue';

COMMIT;
