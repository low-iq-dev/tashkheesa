-- 008: Default admin setting for auto-assign (disabled by default)
INSERT INTO admin_settings (key, value, updated_at)
VALUES ('auto_assign_enabled', 'false', NOW())
ON CONFLICT (key) DO NOTHING;
