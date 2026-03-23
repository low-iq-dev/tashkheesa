-- 005: Messaging, prescriptions, and chat moderation tables

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  patient_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  file_url TEXT,
  file_name TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_reports (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  reported_by TEXT NOT NULL,
  reporter_role TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT DEFAULT 'open',
  admin_notes TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
