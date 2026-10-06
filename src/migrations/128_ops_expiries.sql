-- ============================================================================
-- 128 — ops_expiries: the things that lapse
--
-- 6 Oct 2026 (watchtower). Domains, developer memberships, API tokens, plans.
-- Each one fails silently on a date somebody once knew. This is the register;
-- the credentials.expiring check (services/system_checks.js) reads it and
-- warns at 30 days, fails at 7, and warns for every row whose date nobody has
-- entered yet — which is all of them on the day this ships. The dates are
-- entered from the Command app (PUT /api/v1/admin/expiries/:key).
--
-- `expires_on` NULL means "not entered", never "does not expire".
-- ============================================================================

CREATE TABLE IF NOT EXISTS ops_expiries (
  key        text        PRIMARY KEY,
  label      text        NOT NULL,
  expires_on date,
  owner      text,
  notes      text,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE ops_expiries ENABLE ROW LEVEL SECURITY;

INSERT INTO ops_expiries (key, label) VALUES
  ('domain_tashkheesa_com',  'Domain tashkheesa.com'),
  ('apple_developer',        'Apple developer membership'),
  ('apple_push_key',         'Apple push key'),
  ('google_play',            'Google Play account'),
  ('instagram_graph_token',  'Instagram Graph token'),
  ('meta_system_token',      'Meta system token'),
  ('gmail_app_password_info','Gmail app password for info@'),
  ('github_token_mini',      'GitHub token on the mini'),
  ('tailscale_node_key',     'Tailscale node key'),
  ('twilio',                 'Twilio'),
  ('kashier_keys',           'Kashier keys'),
  ('cloudflare',             'Cloudflare'),
  ('render_plan',            'Render plan'),
  ('supabase_plan',          'Supabase plan'),
  ('google_workspace',       'Google Workspace'),
  ('cloudinary',             'Cloudinary'),
  ('expo_eas',               'Expo / EAS'),
  ('anthropic_key',          'Anthropic key')
ON CONFLICT (key) DO NOTHING;
