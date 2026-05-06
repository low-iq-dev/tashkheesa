-- 045: orders_active is the canonical "live" projection of orders.
--
-- Background: migration 022 added orders.deleted_at for soft-delete
-- (case auto-deleted when 48h unpaid, etc.). Until this migration,
-- only 4 sites in the entire codebase filtered on `deleted_at IS NULL`
-- — soft-deleted orders were leaking into patient dashboards, doctor
-- queues, SLA breach sweeps, finance reports, broadcast targeting,
-- and refund handlers. See docs/audits/THEME_01_SCHEMA_DRIFT_FIX_PLAN.md
-- sub-issue D for the full inventory.
--
-- Adoption rules going forward:
--   * READS that should NOT see soft-deleted rows: use orders_active.
--   * MUTATIONS (INSERT / UPDATE / DELETE / RETURNING …): use orders.
--     Postgres views are not directly mutable in the general case;
--     mutations target the base table by id and the soft-delete state
--     of the target row is irrelevant to the operation's intent.
--   * Forensic / audit / admin "trash" reads that DO want to see
--     deleted rows: use orders directly with an explicit
--     `-- include-deleted-ok: <reason>` comment justifying the
--     intent. The CI lint test in tests/core/orders-table-readers.test.js
--     uses that exact comment as its allowlist marker.
--
-- The VIEW is `CREATE OR REPLACE` so re-runs are no-ops; it carries
-- no special permissions or RLS — every column on `orders` is
-- visible through it, just filtered. PostgreSQL evaluates the
-- WHERE clause as a predicate-pushdown over downstream queries, so
-- the planner generally produces the same plan as inline filtering.

CREATE OR REPLACE VIEW orders_active AS
  SELECT * FROM orders WHERE deleted_at IS NULL;

-- Defensive: ensure the partial index from migration 022 still
-- covers the predicate-pushdown path.
-- (idx_orders_deleted_at WHERE deleted_at IS NOT NULL — already
-- exists as of migration 022; this comment is a reminder, not an op.)
