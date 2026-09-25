-- 121_doctor_push_prefs_and_arabic_report.sql
-- ============================================================================
-- Doctor app, second wave — push preferences, quiet hours, and the Arabic
-- report body. All additive; nothing reads these until services/doctor_push.js
-- and the /api/v1/doctor draft routes land in the same deploy.
--
-- 1. doctor_notification_prefs — one row per (doctor, preference key), where
--    a MISSING row means "enabled". Keys are the app's vocabulary (offer,
--    window, deadline, message, files, payout, news) and live in
--    services/doctor_push.js DOCTOR_PREF_KEYS; no CHECK constraint, following
--    orders.status and users.appearance_preference (value vocabularies live in
--    code, the API write path allowlists). 'offer' is locked ON in code — a
--    row for it is ignored by the push path — so a doctor can never silence
--    the one notification the platform's SLA depends on.
--
-- 2. users.quiet_hours_on / quiet_from / quiet_to — the doctor's do-not-
--    disturb window, stored as CAIRO WALL-CLOCK times (time without zone,
--    interpreted in Africa/Cairo by services/doctor_push.js), because that is
--    what the doctor sets on the phone and what "22:00 to 07:00" means to
--    them across the April/October DST changes. A window may cross midnight
--    (from > to). Locked keys push through quiet hours.
--
-- 3. orders.*_text_ar + report_ar_approved_at — the Arabic version of the
--    three report sections. Until now the delivered PDF printed Arabic section
--    HEADINGS over an English body; the doctor app composes an Arabic body
--    per section and had nowhere to send it. report_ar_approved_at is the
--    doctor's sign-off on the Arabic text (NULL = not approved); the PDF
--    prints whatever Arabic text is stored, approval is the app's gate.
--    Mirrors the English trio (diagnosis_text / impression_text /
--    recommendation_text) name for name so the schema probes in
--    services/report_submission.js resolve them the same way.
-- ============================================================================

CREATE TABLE IF NOT EXISTS doctor_notification_prefs (
  doctor_id  text NOT NULL,
  key        text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doctor_id, key)
);

-- Same RLS posture as every table created since 070 (worked example: 073) —
-- default-deny for anon/authenticated; the owner-role app is unaffected.
ALTER TABLE doctor_notification_prefs ENABLE ROW LEVEL SECURITY;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS quiet_hours_on boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quiet_from time,
  ADD COLUMN IF NOT EXISTS quiet_to time;

COMMENT ON COLUMN users.quiet_from IS
  'Doctor quiet hours start, Cairo wall-clock (Africa/Cairo). Interpreted by services/doctor_push.js; may be later than quiet_to (window crosses midnight).';
COMMENT ON COLUMN users.quiet_to IS
  'Doctor quiet hours end, Cairo wall-clock (Africa/Cairo). See quiet_from.';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS diagnosis_text_ar text,
  ADD COLUMN IF NOT EXISTS impression_text_ar text,
  ADD COLUMN IF NOT EXISTS recommendation_text_ar text,
  ADD COLUMN IF NOT EXISTS report_ar_approved_at timestamptz;

-- ── orders_active re-sync ───────────────────────────────────────────────────
-- public.orders_active freezes its column list at creation, so every
-- `ALTER TABLE orders ADD COLUMN` must be followed by a re-sync or readers of
-- the view (every doctor read in this codebase, rule 4 of the brief) never see
-- the new columns. This is the 084 block verbatim: `SELECT *` rather than an
-- explicit list so it is correct whatever columns a neighbouring migration
-- (120) appends, wrapped in its own exception block so a refusal (42P16) is a
-- deploy-log WARNING, not a crash-loop. See 084's header for the reasoning.
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
      RAISE WARNING 'Migration 121: could NOT re-sync public.orders_active (% %). NOT FATAL, boot continues, but orders_active may be missing diagnosis_text_ar / impression_text_ar / recommendation_text_ar / report_ar_approved_at. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (check pg_depend first and rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;',
        SQLSTATE, SQLERRM;
    END;
  END IF;
END $$;

-- Post-condition parity guard, copied from 084 (WARNING unless
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
        RAISE EXCEPTION 'Migration 121: orders_active is missing orders columns after re-sync: % (tashkheesa.migration_strict is on)', missing;
      ELSE
        RAISE WARNING 'Migration 121: orders_active is MISSING orders columns after re-sync: %. Readers of orders_active cannot see these columns. NOT FATAL, boot continues. TO FIX as the database owner: BEGIN; DROP VIEW public.orders_active CASCADE; (rebuild any dependent view) CREATE VIEW public.orders_active WITH (security_invoker = true) AS SELECT * FROM orders WHERE deleted_at IS NULL; REVOKE SELECT ON public.orders_active FROM anon, authenticated; COMMIT;', missing;
      END IF;
    END IF;
  END IF;
END $$;
