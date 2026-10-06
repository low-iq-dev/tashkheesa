-- ============================================================================
-- 129 — orders.submitted_at: the moment we asked for money
--
-- 6 Oct 2026 (E2E fixes, E2E_CONTRACT.md items 2 and 4). orders has created_at
-- (the patient OPENED the wizard — a draft row is born on step 1) and
-- updated_at (last touch), but nothing that says when the case was submitted.
-- Two things were reading created_at as if it were that:
--
--   * the payment-reminder ladder (case_lifecycle.dispatchUnpaidCaseReminders).
--     A draft created 10:13 got payment_reminder_30m on WhatsApp, email and
--     in-app at 10:44, while the patient was still filling the form and before
--     the case had a price. The ladder now runs from submitted_at.
--   * the patient case list ordering (API: submittedAt, list ordered by it).
--
-- Both submit paths (API draft submit and the web wizard) stamp
-- submitted_at = NOW() from this release on. NULL means "not submitted yet"
-- (a draft) or "submitted by a path that predates the stamp"; every reader
-- uses COALESCE(submitted_at, ..., created_at), so NULL is always safe.
--
-- BACKFILL. Rows that are not drafts get the earliest order_timeline
-- 'submitted' row (both API submit paths have always written one), else
-- created_at. Drafts stay NULL. This cannot re-trigger a reminder: the ladder's
-- dedupe key is payment_reminder:<level>:<channel>:<order>:<user> with no time
-- component, and the sweep only looks at cases submitted in the last 25 hours.
-- updated_at is deliberately NOT touched — it is the unpaid-expiry clock
-- (UNPAID_CASE_TTL) and a backfill is not patient activity.
--
-- order_timeline.created_at is a naive TIMESTAMP whose digits are UTC (see 081
-- for the history), so the session is pinned to UTC for this transaction
-- before the value is copied into a timestamptz.
--
-- No index: the only predicate on the column is the sweep's
-- COALESCE(submitted_at, created_at) window over unpaid rows, and orders is
-- hundreds of rows, not millions. Add one when a query needs it.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS; the backfill only fills
-- NULLs). No explicit BEGIN/COMMIT — the runner (src/db.js) wraps the file and
-- its schema_migrations row in one transaction.
-- ============================================================================

SET LOCAL TIME ZONE 'UTC';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

COMMENT ON COLUMN orders.submitted_at IS
  'When the patient submitted the case (wizard finished, price shown). NULL for drafts. Stamped by both submit paths; anchors the payment-reminder ladder. See migration 129.';

UPDATE orders o
   SET submitted_at = COALESCE(
         (SELECT MIN(t.created_at)
            FROM order_timeline t
           WHERE t.order_id = o.id
             AND t.status ILIKE 'submitted'),
         o.created_at)
 WHERE o.submitted_at IS NULL
   AND UPPER(COALESCE(o.status, '')) <> 'DRAFT';

-- ── orders_active re-sync ───────────────────────────────────────────────────
-- public.orders_active is `SELECT * FROM orders WHERE deleted_at IS NULL` and
-- freezes its column list at creation, so the new column is invisible through
-- the view until it is re-created. This is the 084 / 121 block verbatim:
-- wrapped in its own exception block so a refusal (42P16) is a deploy-log
-- WARNING, not a crash-loop. See 084's header for the reasoning.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    BEGIN
      EXECUTE 'CREATE OR REPLACE VIEW public.orders_active WITH (security_invoker = true) AS '
           || 'SELECT * FROM orders WHERE deleted_at IS NULL';

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE SELECT ON public.orders_active FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE SELECT ON public.orders_active FROM authenticated';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Migration 129: could NOT re-sync public.orders_active (% %). NOT FATAL, boot continues, but orders_active may be missing submitted_at. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (check pg_depend first and rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;',
        SQLSTATE, SQLERRM;
    END;
  END IF;
END $$;

-- Post-condition parity guard, copied from 084 / 121 (WARNING unless
-- tashkheesa.migration_strict is on).
DO $$
DECLARE
  missing text;
  strict_mode boolean :=
    lower(COALESCE(current_setting('tashkheesa.migration_strict', true), 'off'))
      IN ('on','true','1','yes');
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    SELECT string_agg(oc.column_name, ', ' ORDER BY oc.ordinal_position)
      INTO missing
    FROM information_schema.columns oc
    WHERE oc.table_schema = 'public'
      AND oc.table_name  = 'orders'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns vc
        WHERE vc.table_schema = 'public'
          AND vc.table_name   = 'orders_active'
          AND vc.column_name  = oc.column_name
      );

    IF missing IS NOT NULL THEN
      IF strict_mode THEN
        RAISE EXCEPTION 'Migration 129: orders_active is missing orders columns after re-sync: % (tashkheesa.migration_strict is on)', missing;
      ELSE
        RAISE WARNING 'Migration 129: orders_active is MISSING orders columns after re-sync: %. Readers of orders_active cannot see these columns. NOT FATAL, boot continues. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;', missing;
      END IF;
    END IF;
  END IF;
END $$;
