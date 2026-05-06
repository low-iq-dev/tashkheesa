-- 043: Codify the schema mutations that previously lived in
-- src/migrate_mobile_api.js (the fire-and-forget boot path that is
-- deleted in this PR — see THEME_01_SCHEMA_DRIFT_FIX_PLAN.md).
-- Every column / table / index here is what the mobile API
-- (/api/v1/*) needs to read or write.
--
-- Explicitly NOT codified here (intentional):
--   * orders.urgent — dropped by migration 010, re-added by the
--     boot path on every restart. Migration 044 drops it once and
--     for all.
--   * users.reset_token, users.reset_token_expires — dead since
--     P0-AUTH-1 was fixed (2026-05-05); mobile reset-password now
--     consumes password_reset_tokens (the same table the portal
--     uses). Leaving these columns as unmaintained zombies in
--     prod; a future cleanup migration may drop them. Not
--     recreated here.
--   * payments table — dropped by migration 042; re-created empty
--     by the boot path. Mobile readers (routes/api/cases.js)
--     migrated in this PR to source the same fields from `orders`.
--     Not recreated here.
--   * otp_codes — already in migration 015.
--   * doctor_specialties — already in migration 033.
--   * orders.{clinical_question (012), base_price (037),
--     sla_deadline (001), deleted_at (022), urgency_flag (001),
--     medical_history (002), urgency_tier (016), payment_link (002),
--     payment_method (002), payment_status (002), paid_at (020+032),
--     total_price_with_addons (002)} — already covered.
--
-- All ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE
-- INDEX IF NOT EXISTS so this migration is a strict no-op on any
-- production database that has already executed the boot path at
-- least once.

-- ─── users (mobile auth + push notifications) ───────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMP;

-- ─── orders (mobile case fields) ────────────────────────────
-- reference_id: the human-readable "TSH-..." case number the mobile
-- UI shows; written by routes/api/cases.js INSERT.
-- country: ISO country code captured at case submission.
-- currency: order-locked currency (defaults to 'EGP').
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reference_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EGP';

-- ─── notifications (alternate mobile in-app schema) ─────────
-- The portal's notifications table (001) carries:
--   id, order_id, to_user_id, channel, template, status, response, at
-- The mobile API adds an alternate schema for in-app notifications:
--   type, title, message, is_read, data
-- Both schemas coexist on the same table. Eventual consolidation is
-- tracked in the audit (DATA-12). This migration codifies the
-- mobile additions so a fresh DB built from src/migrations/ alone
-- produces the same columns the boot path was producing.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data TEXT;

-- ─── order_files (mobile / Uploadcare metadata) ─────────────
-- The portal's order_files table (001) carries:
--   id, order_id, url, label, created_at
-- The mobile API adds Uploadcare-specific metadata + AI image
-- quality status used by ai_image_check.js.
ALTER TABLE order_files ADD COLUMN IF NOT EXISTS uploadcare_uuid TEXT;
ALTER TABLE order_files ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE order_files ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE order_files ADD COLUMN IF NOT EXISTS size INTEGER;
ALTER TABLE order_files ADD COLUMN IF NOT EXISTS ai_quality_status TEXT;
ALTER TABLE order_files ADD COLUMN IF NOT EXISTS ai_quality_note TEXT;

-- ─── order_timeline (mobile case-detail timeline events) ────
-- Mobile API at routes/api/cases.js reads + writes this table for
-- every case state transition. Until now the table existed only
-- via the boot-time CREATE TABLE IF NOT EXISTS in
-- migrate_mobile_api.js. Codified here.
CREATE TABLE IF NOT EXISTS order_timeline (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  actor TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Indexes ────────────────────────────────────────────────
-- Match the boot-path index set, minus indexes already created by
-- earlier migrations (idx_orders_deleted_at via 022,
-- idx_doctor_specialties_doctor via 033) and minus indexes for the
-- deprecated payments table.
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(reference_id);
CREATE INDEX IF NOT EXISTS idx_order_timeline ON order_timeline(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(to_user_id, is_read);
