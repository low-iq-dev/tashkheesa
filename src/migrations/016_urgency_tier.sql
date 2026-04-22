-- 016: Add urgency_tier column to orders table
-- Replaces the boolean urgency_flag with a proper 3-value tier system
-- Values: 'standard' | 'fast_track' | 'urgent'
-- urgency_flag (boolean) is kept for backwards compatibility

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'urgency_tier'
  ) THEN
    ALTER TABLE orders ADD COLUMN urgency_tier TEXT DEFAULT 'standard';
  END IF;
END $$;

-- Backfill existing rows from urgency_flag
UPDATE orders
SET urgency_tier = CASE
  WHEN urgency_flag = true THEN 'fast_track'
  ELSE 'standard'
END
WHERE urgency_tier = 'standard' OR urgency_tier IS NULL;
