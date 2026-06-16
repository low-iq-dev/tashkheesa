-- 072_harden_orders_active_view.sql
-- ============================================================================
-- PROPOSED — REVIEW ARTIFACT. Lives in docs/sql/ ONLY (do not move into
-- src/migrations/ until approved; sequence it alongside 070 in §5 Step 3).
--
-- WHY: public.orders_active is a VIEW (relkind='v'), owned by `postgres`
-- (rolbypassrls=true), with security_invoker UNSET (defaults to false) and SELECT
-- granted to `anon` + `authenticated`. A non-security_invoker view evaluates
-- access to its underlying tables — INCLUDING row-level security — as the view
-- OWNER. Owner = postgres (bypassrls), so anon/authenticated could read every
-- `orders` row THROUGH this view even after 070 enables RLS on `orders`.
-- Base-table RLS (and the relkind='r' guards in 070/071) do NOT cover this.
--
-- FIX (two layers):
--   1) security_invoker=true  → the view evaluates orders' RLS as the CALLER, so
--      anon/authenticated hit orders' default-deny. The app (postgres, bypassrls)
--      is unaffected and still sees all rows through the view, exactly as today.
--   2) REVOKE SELECT from anon/authenticated → they cannot read the view at all
--      (defense-in-depth if security_invoker is ever reset).
--
-- Requires PG15+ for security_invoker; prod is PG17. No FORCE. No app impact —
-- the portal and patient/admin APIs connect only as `postgres`.
-- ============================================================================

ALTER VIEW public.orders_active SET (security_invoker = true);
REVOKE SELECT ON public.orders_active FROM anon, authenticated;

-- Post-check (run separately):
--   SET ROLE anon; SELECT count(*) FROM public.orders_active;  -- EXPECT 0 rows or permission denied
--   RESET ROLE;
