-- Migration 055: messages.file_key + order_additional_files.file_key
--
-- Theme 13 Sub-issue C2.A — schema groundwork for the messages-attach
-- direct-to-R2 migration. Adds a nullable `file_key TEXT` column to both
-- tables that today carry Uploadcare CDN URLs in `file_url`.
--
-- WHAT:
--   - messages.file_key                — R2 key for files attached to
--                                        a message via the (post-C2)
--                                        new patient_order.ejs widget.
--   - order_additional_files.file_key  — R2 key for files mirrored from
--                                        the messages-attach flow into
--                                        the additional-files surface.
--
-- WHY:
--   The existing `file_url` column stores HTTPS Uploadcare CDN URLs
--   (publicly addressable — privacy gap surfaced in
--   docs/audits/UPLOAD_PROVIDER_AUDIT.md §6a). The R2 cutover stores
--   storage keys (e.g. `messages-attach/<patient-id>/<uuid>.pdf`)
--   that the unified /files/:id reader (src/server.js:507-510) signs
--   on demand with 1h expiry and gates by conversation/order
--   membership.
--
-- WHY A SEPARATE COLUMN (not repurposing file_url):
--   Per THEME_13_C2_FIX_PLAN.md §8 Q5 — separate column means readers
--   disambiguate by which column is non-null instead of regexing the
--   value. The dual-mode invariant ("exactly one of file_url, file_key
--   per row") is enforced at the app level (src/routes/patient.js
--   messages handler in C2.F) — no DB CHECK constraint here because
--   that would block a hypothetical backfill script that needs to
--   write both columns transiently before the swap.
--
-- SAFETY:
--   - Both columns are nullable.
--   - ADD COLUMN IF NOT EXISTS — idempotent, safe to re-run, safe
--     under the existing schema_migrations gate (src/db.js:14-45).
--   - No data write; existing rows remain untouched.
--   - No FK / index / CHECK changes.
--   - file_key has no index because /files/:id looks up by `id` (the
--     PK on both tables) and reads file_key as part of the row.
--
-- PRE-FLIGHT (verified 2026-05-14 against prod):
--   messages.total                          = 0
--   messages.with_file                      = 0
--   order_additional_files.total            = 0
--   So this migration adds columns to two empty tables in prod.
--   In local dev, existing rows (if any) keep file_key = NULL.
--
-- ROLLBACK:
--   ALTER TABLE messages DROP COLUMN IF EXISTS file_key;
--   ALTER TABLE order_additional_files DROP COLUMN IF EXISTS file_key;
--   Safe at any point — no readers reference file_key until C2.D + C2.E
--   ship in subsequent commits.

BEGIN;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS file_key TEXT;

ALTER TABLE order_additional_files
  ADD COLUMN IF NOT EXISTS file_key TEXT;

COMMIT;
