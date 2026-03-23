-- 009: Move intelligence_status from cases table to orders table
-- The cases table is legacy; orders is the live system of record.
-- This migration adds the column to orders and copies existing values.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='orders' AND column_name='intelligence_status')
  THEN
    ALTER TABLE orders ADD COLUMN intelligence_status TEXT DEFAULT 'none';
  END IF;
END $$;

-- Copy any existing intelligence_status values from cases to orders
UPDATE orders o SET intelligence_status = c.intelligence_status
FROM cases c WHERE c.id = o.id AND c.intelligence_status IS NOT NULL
AND c.intelligence_status != 'none'
AND (o.intelligence_status IS NULL OR o.intelligence_status = 'none');
