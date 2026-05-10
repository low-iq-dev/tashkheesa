-- 047: alias 'awaiting_files' (non-canonical) → 'REJECTED_FILES' (canonical).
--
-- Theme 7 sub-issue D (2026-05-10).
--
-- Background:
--   `'awaiting_files'` was a non-canonical status string written by the
--   admin/superadmin "approve additional files request" flow at
--   routes/admin.js and routes/superadmin.js. It was NOT in CASE_STATUS,
--   STATUS_ALIASES, or DB_STATUS_VARIANTS — so any caller of
--   transitionCase on a row in this state would throw
--   `assertCanonicalDbStatus`. The string was also a parallel track to
--   the canonical REJECTED_FILES state (same logical meaning: "case
--   waiting for patient to upload files"), creating drift.
--   See P0-STATE-4 in docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md.
--
-- This migration:
--   (a) Converts existing rows: status='awaiting_files' → 'REJECTED_FILES'.
--       Confirmed 16 rows in production at scoping time (Ziad, 2026-05-09
--       via Supabase SQL).
--   (b) Backfills sla_paused_at + sla_remaining_seconds for any
--       REJECTED_FILES row where pause data is NULL — fixes the
--       "SLA-keeps-ticking" bug from P1-STATE-9 (resumeSla never called)
--       at the entry point. Going forward, the pauseSla() call added in
--       Phase 3 to routes/doctor.js handles the new-row path; this
--       backfill cleans existing rows that entered REJECTED_FILES via
--       the raw doctor reject-files write without pausing.
--
-- Idempotent:
--   - (a) WHERE status='awaiting_files' — re-runs find no rows after first apply.
--   - (b) WHERE sla_paused_at IS NULL — re-runs are no-ops once pause
--     data is set.
--
-- Rollback:
--   The reverse migration is not provided. The 'awaiting_files' string
--   was never canonical; rolling back would re-introduce the drift the
--   audit captured (P0-STATE-4). If a row needs to be returned to the
--   "admin-approval-pending" semantics, that's an order_events branch
--   (admin_approved_files_request vs doctor_rejected_files), not a
--   status change.

BEGIN;

-- (pre) Forensics 2026-05-10 (Theme 7 Phase 3 hotfix):
--   The orders table never had `sla_paused_at` or `sla_remaining_seconds`.
--   Migration 001 declared them on the legacy `cases` table; the
--   cases→orders architectural migration carried the SLA-pause feature
--   forward in CODE only (case_lifecycle.pauseSla/resumeSla) — the
--   matching schema add-on was never written. Production has been
--   silently no-op'ing pauseSla()/resumeSla() since the runtime gating
--   at case_lifecycle.js:1606 / :1636 was added; every call has
--   emitted `SLA_PAUSE_SKIPPED { reason: 'columns_missing' }` or
--   `SLA_RESUME_SKIPPED` to case_events instead of actually pausing.
--
--   The first deploy attempt of this migration (push of commit 0a580de
--   on 2026-05-10) failed at the (b) UPDATE below with
--   `column "sla_paused_at" does not exist` (PG error 42703); the
--   BEGIN/COMMIT wrapper rolled the whole migration back, so production
--   sat at schema_migrations.latest = 046 with no partial state.
--
--   Add the columns here so (b) below has somewhere to write — and so
--   the new pauseSla() call at routes/doctor.js:2194 (Theme 7 Phase 3)
--   starts actually pausing the deadline going forward.
--
--   Type choice: TIMESTAMPTZ matches the modern convention used by
--   migration 022 (`deleted_at TIMESTAMPTZ`). The JS writer at
--   case_lifecycle.js:1621 produces `now.toISOString()`, which Postgres
--   parses correctly into either type, but TZ-aware is safer for the
--   SLA arithmetic at case_lifecycle.js:1647. Legacy cases.sla_paused_at
--   is TIMESTAMP-without-TZ; cases is dead per src/docs/ORDERS_VS_CASES.md
--   so the cross-table inconsistency does not compound.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sla_remaining_seconds INTEGER;

-- (a) Convert non-canonical 'awaiting_files' rows.
UPDATE orders
   SET status = 'REJECTED_FILES',
       updated_at = NOW()
 WHERE status = 'awaiting_files';

-- (b) Backfill SLA pause data for REJECTED_FILES rows where it's missing.
--     Only applies to rows that have a deadline_at + sla_hours so the
--     pause math is well-defined. Computes sla_remaining_seconds as
--     max(0, deadline_at - NOW()) — the budget at migration time.
UPDATE orders
   SET sla_paused_at = NOW(),
       sla_remaining_seconds = GREATEST(
         0,
         EXTRACT(EPOCH FROM (deadline_at - NOW()))::INTEGER
       ),
       updated_at = NOW()
 WHERE status = 'REJECTED_FILES'
   AND sla_paused_at IS NULL
   AND deadline_at IS NOT NULL
   AND sla_hours IS NOT NULL;

COMMIT;
