-- 019_addon_services.sql
--
-- Phase 2 of the add-on service abstraction
-- (docs/architecture/addon_service_abstraction.md).
--
-- Creates three new tables (addon_services, order_addons, addon_earnings),
-- seeds addon_services with the three add-ons that exist today
-- (video_consult, sla_24hr, prescription) at the §0 commission rates,
-- and fixes the services.doctor_commission_pct / video_doctor_commission_pct
-- column defaults that shipped at 70 in migration 002 (§6 of the design doc).
--
-- Fully idempotent: every object creation is guarded by IF NOT EXISTS or an
-- equivalent DO block, and the UPDATE backfills use WHERE-clause safety.
-- Safe to re-run. The boot-time migration runner applies this on the next
-- startup.
--
-- New code behind feature flag ADDON_SYSTEM_V2 stays dormant until Phase 3.
-- This migration is purely additive; rolling the code back does not require
-- rolling the schema back.

BEGIN;

-- ---- 1. addon_services: registry of available add-ons ------------------

CREATE TABLE IF NOT EXISTS addon_services (
  id                        TEXT PRIMARY KEY,
  type                      TEXT NOT NULL,
  name_en                   TEXT NOT NULL,
  name_ar                   TEXT NOT NULL,
  description_en            TEXT,
  description_ar            TEXT,
  base_price_egp            INTEGER NOT NULL,
  prices_json               JSONB,
  doctor_commission_pct     INTEGER NOT NULL DEFAULT 80,
  has_lifecycle             BOOLEAN NOT NULL DEFAULT false,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  sort_order                INTEGER NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT addon_services_type_check CHECK (type IN ('video_consult', 'sla_upgrade', 'prescription'))
);

CREATE INDEX IF NOT EXISTS idx_addon_services_active
  ON addon_services (is_active, sort_order);

-- Seed the three add-ons that exist today. Commission rates per §0 of the
-- design doc: add-ons pay the doctor 80%, SLA-style upsells pay the doctor
-- 0% (Tashkheesa-only fee).
INSERT INTO addon_services
  (id, type, name_en, name_ar, description_en, description_ar,
   base_price_egp, prices_json, doctor_commission_pct, has_lifecycle, sort_order)
VALUES
  ('video_consult', 'video_consult',
   'Video Consultation with Specialist', 'استشارة فيديو مع الاستشاري',
   'A live video consultation with your assigned specialist after the written report.',
   'استشارة فيديو مباشرة مع الاستشاري المعيَّن بعد صدور التقرير المكتوب.',
   200,
   '{"EGP": 200, "SAR": 50, "AED": 45, "USD": 15}'::jsonb,
   80, true, 10),
  ('sla_24hr', 'sla_upgrade',
   '24-hour Priority SLA', 'رأي طبي خلال 24 ساعة',
   'Your case is moved to the 24-hour priority queue.',
   'يتم تحويل حالتك إلى قائمة الأولوية خلال 24 ساعة.',
   100,
   '{"EGP": 100, "SAR": 25, "AED": 22, "USD": 8}'::jsonb,
   0, false, 20),
  ('prescription', 'prescription',
   'Digital Prescription', 'روشتة رقمية',
   'A digital prescription signed by your consultant, delivered with your report if clinically indicated.',
   'روشتة رقمية موقعة من استشاريك، تُسلَّم مع التقرير عند الحاجة طبياً.',
   400,
   '{"EGP": 400, "SAR": 100, "AED": 90, "USD": 30}'::jsonb,
   80, true, 30)
ON CONFLICT (id) DO NOTHING;

-- ---- 2. order_addons: instances attached to orders ---------------------

CREATE TABLE IF NOT EXISTS order_addons (
  id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  addon_service_id                    TEXT NOT NULL REFERENCES addon_services(id),
  status                              TEXT NOT NULL DEFAULT 'pending',
  price_at_purchase_egp               INTEGER NOT NULL,
  price_at_purchase_currency          TEXT    NOT NULL,
  price_at_purchase_amount            INTEGER NOT NULL,
  doctor_commission_pct_at_purchase   INTEGER NOT NULL,
  doctor_commission_amount_egp        INTEGER,
  metadata_json                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  refund_pending                      BOOLEAN NOT NULL DEFAULT false,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at                        TIMESTAMPTZ,
  cancelled_at                        TIMESTAMPTZ,
  refunded_at                         TIMESTAMPTZ,
  CONSTRAINT order_addons_status_check
    CHECK (status IN ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded'))
);

CREATE INDEX IF NOT EXISTS idx_order_addons_order
  ON order_addons (order_id);
CREATE INDEX IF NOT EXISTS idx_order_addons_status
  ON order_addons (status);
CREATE INDEX IF NOT EXISTS idx_order_addons_pending_refund
  ON order_addons (refund_pending) WHERE refund_pending = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_addons_order_service
  ON order_addons (order_id, addon_service_id);

-- ---- 3. addon_earnings: doctor payout per fulfilled add-on -------------

CREATE TABLE IF NOT EXISTS addon_earnings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_addon_id         UUID NOT NULL REFERENCES order_addons(id) ON DELETE CASCADE,
  doctor_id              TEXT NOT NULL,
  gross_amount_egp       INTEGER NOT NULL,
  commission_pct         INTEGER NOT NULL,
  earned_amount_egp      INTEGER NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'pending',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at                TIMESTAMPTZ,
  CONSTRAINT addon_earnings_status_check CHECK (status IN ('pending', 'paid'))
);

CREATE INDEX IF NOT EXISTS idx_addon_earnings_doctor
  ON addon_earnings (doctor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_earnings_once
  ON addon_earnings (order_addon_id);

-- ---- 4. Fix the 70%/80% commission-default bug (see §6) ----------------

-- Services column defaults were 70; §0 commission model says add-ons pay 80.
-- The video.js fallback already returns 80 for rows with NULL, so production
-- today earns at 80; any row that somehow inherited 70 at insert time is
-- underpaying the doctor by 14% of the video consult fee.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'services'
       AND column_name = 'video_doctor_commission_pct'
  ) THEN
    EXECUTE 'ALTER TABLE services ALTER COLUMN video_doctor_commission_pct SET DEFAULT 80';
    UPDATE services SET video_doctor_commission_pct = 80
      WHERE video_doctor_commission_pct = 70;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'services'
       AND column_name = 'doctor_commission_pct'
  ) THEN
    EXECUTE 'ALTER TABLE services ALTER COLUMN doctor_commission_pct SET DEFAULT 80';
    UPDATE services SET doctor_commission_pct = 80
      WHERE doctor_commission_pct = 70;
  END IF;
END
$$;

COMMIT;
