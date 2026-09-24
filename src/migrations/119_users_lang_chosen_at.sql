-- ============================================================================
-- 119 — users.lang_chosen_at: a language the person CHOSE vs the column default
--
-- users.lang DEFAULT 'en' (migration 001) means every account that never
-- touched a language control reads as English. Arabic is the patient's
-- language, so for case language (services/intake_language.js) a never-set
-- 'en' must count as "unknown" and fall through to 'ar' — otherwise the
-- Arabic-recommendation guard on the doctor's report never fires on real
-- cases. The column records the moment the person made a choice:
--   * the web EN/عربي toggle (routes/lang.js, patients),
--   * the app's profile language update (routes/api/profile.js),
--   * app registration when the app sends a language (routes/api/auth.js).
--
-- No backfill: a non-default value ('ar') is itself evidence of a choice, and
-- the reader treats it as chosen. Only a bare 'en' needs the timestamp.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS lang_chosen_at TIMESTAMPTZ;

COMMENT ON COLUMN users.lang_chosen_at IS
  'When the user explicitly chose users.lang (toggle / profile / app signup). NULL + lang=''en'' = the column default, not a choice.';
