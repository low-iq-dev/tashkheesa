-- 057_theme14_specialty_catalog_cleanup.sql
--
-- Theme 14 prerequisite — align the visible-specialty enum with the launch
-- catalog so the AI classifier (Phase 3 polish, migration 058) can recommend
-- both a specialty AND a priced service. Pre-flight investigation surfaced
-- 8 visible specialties with zero services in any state; Ziad's triage:
--
--   Action 1 — Hide `spec-anesthesiology` (atypical for the second-opinion
--              product shape: OR-support specialty, not consultable).
--   Action 2 — Resolve the Pathology / Lab & Pathology duplicate:
--                * `spec-pathology` (visible, 0 services) → is_visible=false
--                * `lab_pathology`  (hidden, 16 visible + 5 hidden services)
--                                                       → is_visible=true
--              Net effect: same Pathology coverage at launch, no orphan
--              specialty rows, 16 priced lab services become routable.
--   Action 3 — Add 6 baseline "[Specialty] Consultation" services to the
--              6 keeper specialties (Cardiothoracic Surgery, Clinical
--              Nutrition, Emergency Medicine, Psychiatry, Rheumatology,
--              Vascular Surgery). Pricing per the Tashkheesa Canonical
--              Pricing v4 formula: doctor_fee = base_price * 0.20 with
--              floor at 250 EGP. (Companion update to the canonical
--              pricing sheet is a follow-up step — not bundled here.)
--
-- End state: 21 visible specialties (22 - 2 hidden + 1 revealed), all
-- with at least one visible priced service. Classifier enum at Phase 3
-- polish ship time becomes 21.
--
-- Notes on schema invariants honoured here:
--   * `specialties` has NO `updated_at` column — the proposed UPDATE
--     SET ... updated_at=NOW() in the brief is dropped (would error).
--   * ON CONFLICT target is `(specialty_id, name)` (matches the actual
--     UNIQUE constraint `services_specialty_name_unique`) — NOT `(id)`
--     which is the bug pattern documented in side issue #61.
--   * `code` column is half-empty in prod (57 filled / 99 NULL).
--     Convention going forward: code = id. Backfill of the 42 NULL rows
--     is logged as side issue #76 (not bundled here).
--   * `svc-<specialty-slug>-consultation` ID format is a NEW convention
--     in prod (zero rows match `id LIKE 'svc-%'` today). Aligns with the
--     planned format referenced in `docs/pricing/PRICING_RECONCILIATION_v4_PROD.md`.
--   * All 20 services columns set explicitly per row — no defaulting —
--     so the migration is reviewable without cross-referencing schema.

BEGIN;

-- ─── Action 1 — Hide Anesthesiology. ─────────────────────────────────
UPDATE specialties SET is_visible = false
WHERE id = 'spec-anesthesiology';

-- ─── Action 2 — Resolve Pathology / Lab & Pathology duplicate. ──────
-- spec-pathology has 0 services in any state; lab_pathology has 16 visible
-- + 5 hidden. Services are independent of specialty.is_visible — the 16
-- visible lab services stay visible when the specialty flips visible; the
-- 5 hidden ones stay hidden (no implicit cascade).
UPDATE specialties SET is_visible = false WHERE id = 'spec-pathology';
UPDATE specialties SET is_visible = true  WHERE id = 'lab_pathology';

-- ─── Action 3 — Add 6 baseline consultation services. ───────────────
-- Per Ziad-locked pricing: base_price + doctor_fee = base_price * 0.20
-- with a 250 EGP floor on doctor_fee. SLA hours = 72 (standard tier).
-- ON CONFLICT (specialty_id, name) — re-run idempotency targets the
-- UNIQUE constraint that can actually fire on duplicate insertion
-- (see side issue #61 for the wrong-target precedent).

INSERT INTO services (
  id, specialty_id, code, name,
  base_price, doctor_fee, currency,
  payment_link, sla_hours, is_visible,
  video_consultation_price, video_doctor_commission_pct,
  appointment_price, doctor_commission_pct,
  video_consultation_prices_json,
  sla_24hr_price, sla_24hr_prices_json,
  vip_multiplier, urgent_multiplier, urgency_uplift_doctor_pct
) VALUES
  -- Cardiothoracic Surgery (Complex tier; base 2500 EGP, fee 500)
  ('svc-cardiothoracic-consultation', 'spec-cardiothoracic',
   'svc-cardiothoracic-consultation', 'Cardiothoracic Surgery Consultation',
   2500, 500, 'EGP',
   NULL, 72, true,
   NULL, 85,
   0, 80,
   '{}',
   100, '{}',
   1.30, 1.60, 30),

  -- Clinical Nutrition (Simple tier; base 1250 EGP, fee at floor 250)
  ('svc-clinical-nutrition-consultation', 'spec-clinical-nutrition',
   'svc-clinical-nutrition-consultation', 'Clinical Nutrition Consultation',
   1250, 250, 'EGP',
   NULL, 72, true,
   NULL, 85,
   0, 80,
   '{}',
   100, '{}',
   1.30, 1.60, 30),

  -- Emergency Medicine (Moderate tier; base 1500 EGP, fee 300)
  ('svc-emergency-medicine-consultation', 'spec-emergency-medicine',
   'svc-emergency-medicine-consultation', 'Emergency Medicine Consultation',
   1500, 300, 'EGP',
   NULL, 72, true,
   NULL, 85,
   0, 80,
   '{}',
   100, '{}',
   1.30, 1.60, 30),

  -- Psychiatry (Moderate tier; base 1500 EGP, fee 300)
  ('svc-psychiatry-consultation', 'spec-psychiatry',
   'svc-psychiatry-consultation', 'Psychiatry Consultation',
   1500, 300, 'EGP',
   NULL, 72, true,
   NULL, 85,
   0, 80,
   '{}',
   100, '{}',
   1.30, 1.60, 30),

  -- Rheumatology (Moderate tier; base 1500 EGP, fee 300)
  ('svc-rheumatology-consultation', 'spec-rheumatology',
   'svc-rheumatology-consultation', 'Rheumatology Consultation',
   1500, 300, 'EGP',
   NULL, 72, true,
   NULL, 85,
   0, 80,
   '{}',
   100, '{}',
   1.30, 1.60, 30),

  -- Vascular Surgery (Complex tier; base 2500 EGP, fee 500)
  ('svc-vascular-surgery-consultation', 'spec-vascular-surgery',
   'svc-vascular-surgery-consultation', 'Vascular Surgery Consultation',
   2500, 500, 'EGP',
   NULL, 72, true,
   NULL, 85,
   0, 80,
   '{}',
   100, '{}',
   1.30, 1.60, 30)
ON CONFLICT (specialty_id, name) DO NOTHING;

-- ─── Post-condition guards (atomic — failure rolls back the txn). ───
DO $$
DECLARE
  visible_count INT;
  new_services_count INT;
BEGIN
  -- Expected: 22 pre-migration visible − 2 hidden (anesthesiology, pathology)
  -- + 1 revealed (lab_pathology) = 21 visible.
  SELECT COUNT(*) INTO visible_count FROM specialties WHERE is_visible = true;
  IF visible_count != 21 THEN
    RAISE EXCEPTION 'Migration 057 post-condition failed: expected 21 visible specialties, got %', visible_count;
  END IF;

  -- Expected: 6 new visible services across the 6 keeper specialties.
  -- ON CONFLICT (specialty_id, name) means a re-run keeps the COUNT at 6
  -- (it doesn't duplicate).
  SELECT COUNT(*) INTO new_services_count FROM services
   WHERE specialty_id IN (
     'spec-cardiothoracic', 'spec-clinical-nutrition',
     'spec-emergency-medicine', 'spec-psychiatry',
     'spec-rheumatology',     'spec-vascular-surgery'
   ) AND is_visible = true;
  IF new_services_count != 6 THEN
    RAISE EXCEPTION 'Migration 057 post-condition failed: expected 6 new visible services, got %', new_services_count;
  END IF;
END $$;

COMMIT;
