-- SAFETY: DEV ONLY
PRAGMA foreign_keys = OFF;

-- Clear dependent tables first
DELETE FROM order_events;
DELETE FROM notifications;
DELETE FROM order_files;
DELETE FROM order_additional_files;

-- Clear orders
DELETE FROM orders;

-- Insert demo orders (unassigned, new)
INSERT INTO orders (
  id,
  patient_id,
  doctor_id,
  specialty_id,
  service_id,
  sla_hours,
  status,
  created_at
) VALUES
('demo-new-1', NULL, NULL, 'radiology', 'cardiology', 24, 'new', datetime('now')),
('demo-new-2', NULL, NULL, 'radiology', 'cardiology', 24, 'new', datetime('now')),
('demo-new-3', NULL, NULL, 'radiology', 'cardiology', 24, 'new', datetime('now')),
('demo-new-4', NULL, NULL, 'radiology', 'cardiology', 48, 'new', datetime('now')),
('demo-new-5', NULL, NULL, 'radiology', 'cardiology', 48, 'new', datetime('now')),
('demo-new-6', NULL, NULL, 'radiology', 'cardiology', 72, 'new', datetime('now')),
('demo-new-7', NULL, NULL, 'radiology', 'cardiology', 72, 'new', datetime('now')),
('demo-new-8', NULL, NULL, 'radiology', 'cardiology', 72, 'new', datetime('now'));

PRAGMA foreign_keys = ON;