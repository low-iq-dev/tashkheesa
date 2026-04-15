-- 010: Broadcast notification system
-- Adds doctor capacity columns, broadcast tracking on orders,
-- migrates legacy urgent column to urgency_flag, and creates
-- indexes for the acceptance watcher and broadcast queries.

-- 1. Migrate urgent → urgency_flag and drop the legacy column
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='urgent') THEN
    UPDATE orders SET urgency_flag = true WHERE urgent = true AND (urgency_flag IS NULL OR urgency_flag = false);
    ALTER TABLE orders DROP COLUMN urgent;
  END IF;
END $$;

-- 2. Doctor capacity columns on users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_active_cases integer DEFAULT 5;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_active_cases_urgent integer DEFAULT 8;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_available boolean DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamp;

-- 3. Broadcast tracking columns on orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS broadcast_sent_at timestamp;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS broadcast_count integer DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS acceptance_deadline_at timestamp;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tier text DEFAULT 'standard';

-- 4. Indexes for the acceptance watcher and broadcast queries
CREATE INDEX IF NOT EXISTS idx_orders_acceptance_deadline
  ON orders (acceptance_deadline_at)
  WHERE doctor_id IS NULL AND status IN ('pending', 'available', 'submitted', 'new', 'paid');

CREATE INDEX IF NOT EXISTS idx_doctor_specialties_doctor_id
  ON doctor_specialties (doctor_id);
