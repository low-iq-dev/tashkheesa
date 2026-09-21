-- Batch B verification scratch schema.
--
-- A faithful SUBSET of the production tables the earnings/report paths touch
-- (column names and types mirror prod information_schema, captured 2026-09-21
-- via the Supabase MCP — notably doctor_earnings's naive-UTC timestamps and
-- DOUBLE PRECISION money, addon_earnings's timestamptz + integer EGP, and
-- orders' timestamptz columns). Local Postgres cannot boot the app's own
-- migrations (070 needs the Supabase anon role), so verification runs against
-- this scratch DB instead: create a fresh database and pipe this file in.

CREATE TABLE users (
  id text PRIMARY KEY,
  email text,
  password_hash text,
  name text,
  role text,
  lang text,
  phone text,
  specialty_id text,
  date_of_birth text,
  gender text,
  is_active boolean DEFAULT true,
  pending_approval boolean DEFAULT false,
  is_paused boolean DEFAULT false,
  paused_at timestamptz,
  pause_reason text,
  created_at timestamptz DEFAULT NOW()
);

CREATE TABLE specialties (id text PRIMARY KEY, name text);

CREATE TABLE services (
  id text PRIMARY KEY,
  name text,
  urgency_uplift_doctor_pct integer
);

CREATE TABLE orders (
  id text PRIMARY KEY,
  patient_id text,
  doctor_id text,
  service_id text,
  specialty_id text,
  status text,
  payment_status text,
  price double precision,
  base_price double precision,
  doctor_fee double precision,
  urgency_uplift_amount numeric,
  urgency_tier text,
  sla_hours integer,
  notes text,
  addons_json text,
  video_consultation_selected boolean,
  video_consultation_price double precision,
  diagnosis_text text,
  impression_text text,
  recommendation_text text,
  report_url text,
  reassigned_count integer DEFAULT 0,
  reassigned_to_doctor_id text,
  reassigned_at timestamptz,
  reassignment_reason text,
  paid_at timestamptz,
  accepted_at timestamptz,
  acceptance_deadline_at timestamptz,
  deadline_at timestamptz,
  breached_at timestamptz,
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- The app reads through this view everywhere (migrations 043-045).
CREATE VIEW orders_active AS SELECT * FROM orders WHERE deleted_at IS NULL;

-- Naive-UTC timestamps + DOUBLE PRECISION money, exactly as prod (mig 004/054).
CREATE TABLE doctor_earnings (
  id text PRIMARY KEY,
  doctor_id text NOT NULL,
  appointment_id text NOT NULL,
  gross_amount double precision NOT NULL,
  commission_pct double precision NOT NULL,
  earned_amount double precision NOT NULL,
  status text,
  paid_at timestamp without time zone,
  created_at timestamp without time zone,
  reassigned_to_earning_id text,
  reassignment_reason text,
  clawback_reason text,
  clawback_applied_at timestamp without time zone
);

-- timestamptz + integer EGP, exactly as prod.
CREATE TABLE addon_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_addon_id uuid NOT NULL,
  doctor_id text NOT NULL,
  gross_amount_egp integer NOT NULL,
  commission_pct integer NOT NULL,
  earned_amount_egp integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  paid_at timestamptz
);
CREATE UNIQUE INDEX addon_earnings_order_addon_id_key ON addon_earnings (order_addon_id);

CREATE TABLE order_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text,
  addon_service_id text,
  status text,
  price_at_purchase_egp integer,
  price_at_purchase_currency text,
  price_at_purchase_amount integer,
  doctor_commission_pct_at_purchase integer,
  doctor_commission_amount_egp integer,
  metadata_json jsonb,
  refund_pending boolean,
  created_at timestamptz DEFAULT NOW(),
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz
);

CREATE TABLE appointments (
  id text PRIMARY KEY,
  order_id text,
  patient_id text,
  doctor_id text,
  specialty_id text,
  scheduled_at timestamp without time zone,
  status text,
  video_call_id text,
  payment_id text,
  price double precision,
  doctor_commission_pct double precision,
  created_at timestamp without time zone,
  updated_at timestamp without time zone
);

CREATE TABLE doctor_assignments (
  id text PRIMARY KEY,
  case_id text,
  doctor_id text,
  assigned_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  reassigned_from_doctor_id text,
  accept_by_at timestamptz
);

CREATE TABLE order_events (
  id text PRIMARY KEY,
  order_id text,
  label text,
  meta text,
  at timestamp without time zone,
  actor_user_id text,
  actor_role text
);

CREATE TABLE case_events (
  id text PRIMARY KEY,
  case_id text,
  event_type text,
  event_payload text,
  created_at timestamp without time zone
);

CREATE TABLE report_exports (
  id text PRIMARY KEY,
  case_id text,
  file_path text,
  created_by text,
  created_at timestamp without time zone
);

CREATE TABLE medical_records (
  id text PRIMARY KEY,
  patient_id text,
  record_type text,
  title text,
  description text,
  file_url text,
  order_id text,
  doctor_id text,
  is_shared_with_doctors boolean,
  created_at timestamp without time zone
);

CREATE TABLE case_annotations (
  id text PRIMARY KEY,
  case_id text,
  doctor_id text,
  annotated_image_data text,
  annotations_count integer,
  updated_at timestamp without time zone
);

CREATE TABLE error_logs (
  id text PRIMARY KEY,
  level text,
  category text,
  message text,
  user_id text,
  context text,
  created_at timestamp without time zone DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TABLE reviews (
  id text PRIMARY KEY,
  doctor_id text,
  rating numeric
);

-- Migration 109, verbatim object shapes.
CREATE TABLE doctor_sla_events (
  id         text PRIMARY KEY,
  doctor_id  text NOT NULL,
  order_id   text NOT NULL,
  reason     text NOT NULL DEFAULT 'sla_breach',
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_doctor_sla_events_doctor_created
  ON doctor_sla_events (doctor_id, created_at);
