-- 085_rls_payment_event_reviews_ops_push_log.sql
-- ============================================================================
-- AUDIT-2026-08-22 — two public base tables were never given RLS.
--
-- 070_rls_enable_default_deny.sql enabled default-deny ROW LEVEL SECURITY on the
-- 58 public base tables that existed when it was written (2026-06-15). Every
-- table created SINCE has had to opt in for itself; 073_doctor_applications.sql:55
-- is the worked example and says so explicitly. Two did not:
--
--   payment_event_reviews  (075) — operator annotations on payment events:
--     reviewed_by, reviewed_at, and a free-text `note` on amount-mismatch
--     triage. This is payment-dispute data. If the Supabase Data API is live,
--     ANY holder of the project's publishable/anon key can SELECT the whole
--     table over PostgREST. That is the single worst exposure in this schema.
--
--   ops_push_log           (082) — the throttle + audit trail for operator
--     pushes: titles, bodies and order_ids of every alert sent to superadmins.
--     Lower severity than the above, same defect.
--
-- EFFECT AND NON-EFFECT
-- ---------------------
-- ENABLE ROW LEVEL SECURITY with NO policies and NO FORCE is default-deny: the
-- table becomes invisible to every role that is NOT rolbypassrls. The
-- application connects as `postgres` (rolbypassrls = true) and is therefore
-- COMPLETELY UNAFFECTED — same reasoning, same posture, same wording as 070 and
-- 073. Only anon / authenticated (rolbypassrls = false) lose access, which is the
-- entire intent.
--
-- If the app is ever repointed at a NON-bypass role, this migration — like 070
-- before it — makes those two tables return zero rows with no error. See the
-- operator check in 070's header comment.
--
-- Idempotent: ENABLE on an already-enabled table is a no-op, and each statement
-- is guarded on the table existing (075 itself only creates
-- payment_event_reviews when payment_events is present, so a fresh/local DB can
-- legitimately lack it).
--
-- No explicit BEGIN/COMMIT — the runner (src/db.js) sends this file as one
-- multi-statement simple query and wraps it, together with its schema_migrations
-- row, in a single transaction.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.payment_event_reviews') IS NOT NULL THEN
    ALTER TABLE public.payment_event_reviews ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE '085: RLS enabled (default-deny) on payment_event_reviews';
  ELSE
    RAISE NOTICE '085: payment_event_reviews absent (075 skipped it) — nothing to lock';
  END IF;

  IF to_regclass('public.ops_push_log') IS NOT NULL THEN
    ALTER TABLE public.ops_push_log ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE '085: RLS enabled (default-deny) on ops_push_log';
  ELSE
    RAISE NOTICE '085: ops_push_log absent — nothing to lock';
  END IF;
END $$;

-- Post-condition: whichever of the two exists must now have relrowsecurity set.
-- Fail loudly rather than logging a NOTICE nobody reads — the whole point of
-- this file is that an unlocked payment table shipped once already.
DO $$
DECLARE
  unlocked text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO unlocked
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN ('payment_event_reviews', 'ops_push_log')
    AND NOT c.relrowsecurity;

  IF unlocked IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 085: RLS is still OFF on: %', unlocked;
  END IF;
END $$;
