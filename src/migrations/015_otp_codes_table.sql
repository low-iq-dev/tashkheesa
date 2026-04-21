-- 015: Add otp_codes table to standard migration runner
-- Previously only created in migrate_mobile_api.js which runs outside the normal migration flow.
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
