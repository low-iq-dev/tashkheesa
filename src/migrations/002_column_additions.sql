-- 002: Column additions to base tables (idempotent)

-- ============================================================
-- services
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='base_price') THEN
    ALTER TABLE services ADD COLUMN base_price DOUBLE PRECISION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='doctor_fee') THEN
    ALTER TABLE services ADD COLUMN doctor_fee DOUBLE PRECISION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='currency') THEN
    ALTER TABLE services ADD COLUMN currency TEXT DEFAULT 'EGP';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='payment_link') THEN
    ALTER TABLE services ADD COLUMN payment_link TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='sla_hours') THEN
    ALTER TABLE services ADD COLUMN sla_hours INTEGER DEFAULT 72;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='is_visible') THEN
    ALTER TABLE services ADD COLUMN is_visible BOOLEAN DEFAULT true;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='video_consultation_price') THEN
    ALTER TABLE services ADD COLUMN video_consultation_price DOUBLE PRECISION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='video_doctor_commission_pct') THEN
    ALTER TABLE services ADD COLUMN video_doctor_commission_pct DOUBLE PRECISION DEFAULT 70;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='appointment_price') THEN
    ALTER TABLE services ADD COLUMN appointment_price DOUBLE PRECISION DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='doctor_commission_pct') THEN
    ALTER TABLE services ADD COLUMN doctor_commission_pct DOUBLE PRECISION DEFAULT 70;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='video_consultation_prices_json') THEN
    ALTER TABLE services ADD COLUMN video_consultation_prices_json TEXT DEFAULT '{}';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='sla_24hr_price') THEN
    ALTER TABLE services ADD COLUMN sla_24hr_price DOUBLE PRECISION DEFAULT 100;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='sla_24hr_prices_json') THEN
    ALTER TABLE services ADD COLUMN sla_24hr_prices_json TEXT DEFAULT '{}';
  END IF;
END $$;

-- ============================================================
-- orders
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='medical_history') THEN
    ALTER TABLE orders ADD COLUMN medical_history TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='current_medications') THEN
    ALTER TABLE orders ADD COLUMN current_medications TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='language') THEN
    ALTER TABLE orders ADD COLUMN language TEXT DEFAULT 'en';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='urgency_flag') THEN
    ALTER TABLE orders ADD COLUMN urgency_flag BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='diagnosis_text') THEN
    ALTER TABLE orders ADD COLUMN diagnosis_text TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='impression_text') THEN
    ALTER TABLE orders ADD COLUMN impression_text TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='recommendation_text') THEN
    ALTER TABLE orders ADD COLUMN recommendation_text TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_status') THEN
    ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'unpaid';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_method') THEN
    ALTER TABLE orders ADD COLUMN payment_method TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_reference') THEN
    ALTER TABLE orders ADD COLUMN payment_reference TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_link') THEN
    ALTER TABLE orders ADD COLUMN payment_link TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='pre_breach_notified') THEN
    ALTER TABLE orders ADD COLUMN pre_breach_notified BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='sla_reminder_sent') THEN
    ALTER TABLE orders ADD COLUMN sla_reminder_sent BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='video_consultation_selected') THEN
    ALTER TABLE orders ADD COLUMN video_consultation_selected BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='video_consultation_price') THEN
    ALTER TABLE orders ADD COLUMN video_consultation_price DOUBLE PRECISION DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='addons_json') THEN
    ALTER TABLE orders ADD COLUMN addons_json TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='total_price_with_addons') THEN
    ALTER TABLE orders ADD COLUMN total_price_with_addons DOUBLE PRECISION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='sla_24hr_selected') THEN
    ALTER TABLE orders ADD COLUMN sla_24hr_selected BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='sla_24hr_price') THEN
    ALTER TABLE orders ADD COLUMN sla_24hr_price DOUBLE PRECISION DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='sla_24hr_deadline') THEN
    ALTER TABLE orders ADD COLUMN sla_24hr_deadline TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='referral_code') THEN
    ALTER TABLE orders ADD COLUMN referral_code TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='referral_discount') THEN
    ALTER TABLE orders ADD COLUMN referral_discount DOUBLE PRECISION DEFAULT 0;
  END IF;
END $$;

-- ============================================================
-- users
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='country_code') THEN
    ALTER TABLE users ADD COLUMN country_code TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='pending_approval') THEN
    ALTER TABLE users ADD COLUMN pending_approval BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='bio') THEN
    ALTER TABLE users ADD COLUMN bio TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='display_name') THEN
    ALTER TABLE users ADD COLUMN display_name TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_at') THEN
    ALTER TABLE users ADD COLUMN approved_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_by') THEN
    ALTER TABLE users ADD COLUMN approved_by TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='rejection_reason') THEN
    ALTER TABLE users ADD COLUMN rejection_reason TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='signup_notes') THEN
    ALTER TABLE users ADD COLUMN signup_notes TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='onboarding_complete') THEN
    ALTER TABLE users ADD COLUMN onboarding_complete BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='date_of_birth') THEN
    ALTER TABLE users ADD COLUMN date_of_birth TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='gender') THEN
    ALTER TABLE users ADD COLUMN gender TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='known_conditions') THEN
    ALTER TABLE users ADD COLUMN known_conditions TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='current_medications') THEN
    ALTER TABLE users ADD COLUMN current_medications TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='allergies') THEN
    ALTER TABLE users ADD COLUMN allergies TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='previous_surgeries') THEN
    ALTER TABLE users ADD COLUMN previous_surgeries TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='family_history') THEN
    ALTER TABLE users ADD COLUMN family_history TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='referred_by_code') THEN
    ALTER TABLE users ADD COLUMN referred_by_code TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='email_marketing_opt_out') THEN
    ALTER TABLE users ADD COLUMN email_marketing_opt_out BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='country') THEN
    ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'EG';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='muted_until') THEN
    ALTER TABLE users ADD COLUMN muted_until TIMESTAMP;
  END IF;
END $$;

-- ============================================================
-- order_events
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_events' AND column_name='actor_user_id') THEN
    ALTER TABLE order_events ADD COLUMN actor_user_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_events' AND column_name='actor_role') THEN
    ALTER TABLE order_events ADD COLUMN actor_role TEXT;
  END IF;
END $$;

-- ============================================================
-- order_additional_files
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_additional_files' AND column_name='label') THEN
    ALTER TABLE order_additional_files ADD COLUMN label TEXT;
  END IF;
END $$;

-- ============================================================
-- notifications
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='dedupe_key') THEN
    ALTER TABLE notifications ADD COLUMN dedupe_key TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='attempts') THEN
    ALTER TABLE notifications ADD COLUMN attempts INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='retry_after') THEN
    ALTER TABLE notifications ADD COLUMN retry_after TIMESTAMP;
  END IF;
END $$;

-- ============================================================
-- conversations
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='conversations' AND column_name='closed_at') THEN
    ALTER TABLE conversations ADD COLUMN closed_at TIMESTAMP;
  END IF;
END $$;

-- ============================================================
-- appointments
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='sla_24hr_selected') THEN
    ALTER TABLE appointments ADD COLUMN sla_24hr_selected BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='diagnosis_submitted_at') THEN
    ALTER TABLE appointments ADD COLUMN diagnosis_submitted_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='sla_compliant') THEN
    ALTER TABLE appointments ADD COLUMN sla_compliant BOOLEAN;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='reminder_24h_sent') THEN
    ALTER TABLE appointments ADD COLUMN reminder_24h_sent BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='reminder_1h_sent') THEN
    ALTER TABLE appointments ADD COLUMN reminder_1h_sent BOOLEAN DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='no_show_party') THEN
    ALTER TABLE appointments ADD COLUMN no_show_party TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='patient_requested_at') THEN
    ALTER TABLE appointments ADD COLUMN patient_requested_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='doctor_proposed_at') THEN
    ALTER TABLE appointments ADD COLUMN doctor_proposed_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='doctor_proposed_time') THEN
    ALTER TABLE appointments ADD COLUMN doctor_proposed_time TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='patient_confirmed_at') THEN
    ALTER TABLE appointments ADD COLUMN patient_confirmed_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='slot_notes') THEN
    ALTER TABLE appointments ADD COLUMN slot_notes TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='slot_admin_alerted_at') THEN
    ALTER TABLE appointments ADD COLUMN slot_admin_alerted_at TIMESTAMP;
  END IF;
END $$;

-- ============================================================
-- appointment_payments
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='appointment_payments' AND column_name='refund_status') THEN
    ALTER TABLE appointment_payments ADD COLUMN refund_status TEXT;
  END IF;
END $$;

-- ============================================================
-- video_calls
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='video_calls' AND column_name='duration_minutes') THEN
    ALTER TABLE video_calls ADD COLUMN duration_minutes INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='video_calls' AND column_name='patient_joined_at') THEN
    ALTER TABLE video_calls ADD COLUMN patient_joined_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='video_calls' AND column_name='doctor_joined_at') THEN
    ALTER TABLE video_calls ADD COLUMN doctor_joined_at TIMESTAMP;
  END IF;
END $$;

-- ============================================================
-- medical_records
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='medical_records' AND column_name='order_id') THEN
    ALTER TABLE medical_records ADD COLUMN order_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='medical_records' AND column_name='doctor_id') THEN
    ALTER TABLE medical_records ADD COLUMN doctor_id TEXT;
  END IF;
END $$;

-- ============================================================
-- specialties
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='specialties' AND column_name='is_visible') THEN
    ALTER TABLE specialties ADD COLUMN is_visible BOOLEAN DEFAULT true;
  END IF;
END $$;
