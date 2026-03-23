-- 004: Video consultation tables

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  patient_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  specialty_id TEXT,
  scheduled_at TIMESTAMP NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  status TEXT DEFAULT 'pending',
  video_call_id TEXT,
  payment_id TEXT,
  price DOUBLE PRECISION NOT NULL,
  doctor_commission_pct DOUBLE PRECISION NOT NULL,
  cancel_reason TEXT,
  rescheduled_from TEXT,
  rescheduled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS video_calls (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  twilio_room_name TEXT UNIQUE,
  initiated_by TEXT,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  duration_seconds INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS appointment_payments (
  id TEXT PRIMARY KEY,
  appointment_id TEXT,
  patient_id TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'EGP',
  status TEXT DEFAULT 'pending',
  method TEXT,
  reference TEXT,
  refund_reason TEXT,
  refunded_at TIMESTAMP,
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doctor_earnings (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  gross_amount DOUBLE PRECISION NOT NULL,
  commission_pct DOUBLE PRECISION NOT NULL,
  earned_amount DOUBLE PRECISION NOT NULL,
  status TEXT DEFAULT 'pending',
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doctor_availability (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT DEFAULT 'Africa/Cairo',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS appointment_slots (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL,
  available_at TIMESTAMP NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  is_booked BOOLEAN DEFAULT false,
  booked_by_patient_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
