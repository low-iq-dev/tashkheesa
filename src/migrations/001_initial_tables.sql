-- 001: Initial table creation (all base tables)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  name TEXT,
  role TEXT,
  specialty_id TEXT,
  phone TEXT,
  lang TEXT DEFAULT 'en',
  notify_whatsapp BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS specialties (
  id TEXT PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  specialty_id TEXT,
  code TEXT,
  name TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  patient_id TEXT,
  doctor_id TEXT,
  specialty_id TEXT,
  service_id TEXT,
  sla_hours INTEGER,
  status TEXT,
  language TEXT DEFAULT 'en',
  urgency_flag BOOLEAN DEFAULT false,
  price DOUBLE PRECISION,
  doctor_fee DOUBLE PRECISION,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP,
  accepted_at TIMESTAMP,
  deadline_at TIMESTAMP,
  completed_at TIMESTAMP,
  breached_at TIMESTAMP,
  reassigned_count INTEGER DEFAULT 0,
  report_url TEXT,
  notes TEXT,
  diagnosis_text TEXT,
  impression_text TEXT,
  recommendation_text TEXT,
  uploads_locked BOOLEAN DEFAULT false,
  additional_files_requested BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  label TEXT,
  meta TEXT,
  at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_additional_files (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  file_url TEXT,
  uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_files (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  url TEXT,
  label TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  to_user_id TEXT,
  channel TEXT,
  template TEXT,
  status TEXT,
  response TEXT,
  at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  reference_code TEXT UNIQUE,
  status TEXT,
  sla_type TEXT,
  sla_deadline TIMESTAMP,
  language TEXT DEFAULT 'en',
  urgency_flag BOOLEAN DEFAULT false,
  sla_paused_at TIMESTAMP,
  sla_remaining_seconds INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP,
  paid_at TIMESTAMP,
  breached_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS case_files (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  filename TEXT,
  file_type TEXT,
  storage_path TEXT,
  uploaded_at TIMESTAMP DEFAULT NOW(),
  is_valid BOOLEAN
);

CREATE TABLE IF NOT EXISTS case_context (
  case_id TEXT PRIMARY KEY,
  reason_for_review TEXT,
  urgency_flag BOOLEAN DEFAULT false,
  language TEXT DEFAULT 'en'
);

CREATE TABLE IF NOT EXISTS doctor_assignments (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  doctor_id TEXT,
  assigned_at TIMESTAMP,
  accepted_at TIMESTAMP,
  completed_at TIMESTAMP,
  reassigned_from_doctor_id TEXT
);

CREATE TABLE IF NOT EXISTS case_events (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  event_type TEXT,
  event_payload TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_annotations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  annotation_data TEXT,
  annotated_image_data TEXT,
  annotations_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_exports (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  review_text TEXT,
  is_anonymous BOOLEAN DEFAULT false,
  is_visible BOOLEAN DEFAULT true,
  admin_flagged BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS error_logs (
  id TEXT PRIMARY KEY,
  error_id TEXT,
  level TEXT DEFAULT 'error',
  message TEXT,
  stack TEXT,
  context TEXT,
  request_id TEXT,
  user_id TEXT,
  url TEXT,
  method TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pre_launch_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  language TEXT DEFAULT 'en',
  service_interest TEXT,
  case_description TEXT,
  source TEXT DEFAULT 'coming_soon_page',
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  medications TEXT NOT NULL,
  diagnosis TEXT,
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  valid_until TEXT,
  pdf_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medical_records (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  file_url TEXT,
  file_name TEXT,
  date_of_record TEXT,
  provider TEXT,
  tags TEXT,
  is_shared_with_doctors BOOLEAN DEFAULT false,
  is_hidden BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
