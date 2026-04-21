-- 013: App waitlist table for /app campaign landing page
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS app_waitlist (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios_other', 'other')),
    user_agent TEXT,
    referrer TEXT,
    utm_source TEXT,
    utm_campaign TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    notified_at TIMESTAMPTZ
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- Unique constraint: one entry per email+platform
DO $$ BEGIN
  ALTER TABLE app_waitlist ADD CONSTRAINT app_waitlist_email_platform_unique UNIQUE (email, platform);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- App analytics events table — tracks CTA clicks, page views by variant
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS app_analytics_events (
    id SERIAL PRIMARY KEY,
    event TEXT NOT NULL,
    variant TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    referrer TEXT,
    utm_source TEXT,
    utm_campaign TEXT,
    meta JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- Index for ops dashboard queries
CREATE INDEX IF NOT EXISTS idx_app_waitlist_created ON app_waitlist (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_analytics_event ON app_analytics_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_analytics_variant ON app_analytics_events (variant, created_at DESC);
