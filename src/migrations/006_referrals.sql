-- 006: Referrals, campaigns, Instagram, and ops tables

CREATE TABLE IF NOT EXISTS referral_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  type TEXT DEFAULT 'patient',
  reward_type TEXT DEFAULT 'discount',
  reward_value DOUBLE PRECISION DEFAULT 10,
  max_uses INTEGER DEFAULT 0,
  times_used INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_redemptions (
  id TEXT PRIMARY KEY,
  referral_code_id TEXT NOT NULL,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL,
  order_id TEXT,
  reward_granted BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject_en TEXT NOT NULL,
  subject_ar TEXT,
  template TEXT NOT NULL,
  target_audience TEXT DEFAULT 'all',
  status TEXT DEFAULT 'draft',
  scheduled_at TIMESTAMP,
  sent_at TIMESTAMP,
  total_recipients INTEGER DEFAULT 0,
  total_sent INTEGER DEFAULT 0,
  total_failed INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  sent_at TIMESTAMP,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_regional_prices (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  hospital_cost DOUBLE PRECISION,
  tashkheesa_price DOUBLE PRECISION,
  doctor_commission DOUBLE PRECISION,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(service_id, country_code)
);

CREATE TABLE IF NOT EXISTS file_ai_checks (
  id TEXT PRIMARY KEY,
  file_id TEXT,
  order_id TEXT,
  is_medical_image BOOLEAN,
  image_quality TEXT,
  quality_issues TEXT,
  detected_scan_type TEXT,
  matches_expected BOOLEAN,
  confidence DOUBLE PRECISION,
  recommendation TEXT,
  checked_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ig_scheduled_posts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  day_number INTEGER,
  post_type TEXT NOT NULL DEFAULT 'IMAGE',
  caption_en TEXT,
  caption_ar TEXT,
  caption TEXT,
  hashtags TEXT,
  image_urls TEXT,
  scheduled_at TEXT,
  status TEXT DEFAULT 'pending_approval',
  approved_by TEXT,
  approved_at TEXT,
  image_prompt TEXT,
  rejection_feedback TEXT,
  generation_count INTEGER DEFAULT 0,
  ig_media_id TEXT,
  published_at TEXT,
  error_message TEXT,
  post_label TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  current_task TEXT,
  token_cost_usd DOUBLE PRECISION DEFAULT 0,
  meta TEXT,
  pinged_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_token_log (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  cost_usd DOUBLE PRECISION DEFAULT 0,
  task_label TEXT,
  logged_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_config (
  agent_name TEXT PRIMARY KEY,
  is_enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Seed default agent config rows (idempotent)
INSERT INTO agent_config (agent_name, is_enabled) VALUES
  ('ops-agent', true),
  ('growth-agent', true),
  ('care-agent', true),
  ('finance-agent', true)
ON CONFLICT (agent_name) DO NOTHING;
