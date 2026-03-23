# Orders vs Cases Table Analysis

## Verdict

The `cases` table is legacy. The `orders` table is the live system of record. They represent the same entity (a patient's case/request for a specialist review) and share the same UUID namespace. The codebase already migrated to `orders` via `CASE_TABLE = 'orders'` in `case_lifecycle.js`, but 4 files still query `cases` directly. These should be consolidated.

---

## Current State

### The `orders` table (LIVE — 33+ files, 200+ queries)

Every major feature uses this table: patient dashboard, doctor queue, admin panel, payments, SLA enforcement, analytics, notifications, reports. The `case_lifecycle.js` state machine explicitly defines `const CASE_TABLE = 'orders'` (line 35), so even functions named `createDraftCase` and `markCasePaid` write to `orders`.

Key columns: `id`, `patient_id`, `doctor_id`, `specialty_id`, `service_id`, `status`, `payment_status`, `sla_hours`, `price`, `doctor_fee`, `created_at`, `accepted_at`, `deadline_at`, `completed_at`, `breached_at`, `report_url`, `diagnosis_text`, `impression_text`, `recommendation_text`.

### The `cases` table (LEGACY — 4 files, 10 queries)

Only used for:

| File | What it does with `cases` |
|---|---|
| `case-intelligence.js` | Reads/writes `intelligence_status` column (4 UPDATE queries) |
| `routes/doctor.js` | Reads `intelligence_status` for the doctor case file view (1 SELECT) |
| `routes/order_flow.js` | Reads `intelligence_status` for the intelligence API (1 SELECT) |
| `routes/ops.js` | Adds `COUNT(*) FROM cases` to ops dashboard totals (4 queries) |

The `cases` table has columns that `orders` doesn't: `reference_code`, `sla_type`, `sla_deadline`, `sla_paused_at`, `sla_remaining_seconds`, `paid_at`, `intelligence_status`. Most are unused in live code. The only one that matters is `intelligence_status`.

### Related tables using `case_id`

These all store `case_id` which references the same UUID as `orders.id`:

| Table | Used by | Purpose |
|---|---|---|
| `case_files` | `case-intelligence.js`, `case_lifecycle.js`, `routes/doctor.js`, `routes/order_flow.js` | AI extraction pipeline files |
| `case_context` | `routes/order_flow.js`, `case_lifecycle.js` | Reason for review, language, urgency |
| `case_events` | `case_lifecycle.js` | Lifecycle audit trail (distinct from `order_events`) |
| `case_extractions` | `case-intelligence.js`, `routes/doctor.js`, `routes/order_flow.js` | Aggregated AI extraction data |
| `doctor_assignments` | `case_lifecycle.js` | Assignment history with accept/complete timestamps |

These tables do NOT need renaming. Their `case_id` column already points to `orders.id` UUIDs. The FK is conceptual (no actual FOREIGN KEY constraint in the schema), so no DDL change is needed for them.

### The parallel file systems

There are two file tables that split by naming convention:

| Table | FK column | Used for |
|---|---|---|
| `order_files` | `order_id` | Files uploaded by patients during order submission (Uploadcare URLs) |
| `case_files` | `case_id` | Files tracked by the AI intelligence pipeline (disk paths + extraction data) |

These serve different purposes and should NOT be merged. `order_files` is the patient-facing upload record. `case_files` is the AI processing pipeline's working set with columns like `extracted_text`, `structured_data`, `processing_status`.

---

## The Problem

The `intelligence_status` column only exists on the `cases` table. When `case-intelligence.js` runs `UPDATE cases SET intelligence_status = 'processing' WHERE id = $1`, it's updating a row in `cases` using an ID from `orders`. This only works if a matching row exists in `cases` — which it does for cases created through `case_lifecycle.js` (which inserts into both), but may not exist for orders created through other paths (admin panel, superadmin, public orders).

This means the AI intelligence pipeline silently fails for orders that don't have a corresponding `cases` row.

---

## Migration Plan

### Phase 1: Add `intelligence_status` to `orders` (non-breaking)

Create migration `009_merge_intelligence_status.sql`:

```sql
-- Add intelligence_status to orders table
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
```

### Phase 2: Update 4 files to use `orders` instead of `cases` (the actual fix)

**`src/case-intelligence.js`** (4 queries):
- `UPDATE cases SET intelligence_status = ... WHERE id = $1` becomes `UPDATE orders SET intelligence_status = ... WHERE id = $1`

**`src/routes/doctor.js`** (1 query):
- `SELECT intelligence_status FROM cases WHERE id = $1` becomes `SELECT intelligence_status FROM orders WHERE id = $1`

**`src/routes/order_flow.js`** (1 query):
- `SELECT id, intelligence_status FROM cases WHERE id = $1` becomes `SELECT id, intelligence_status FROM orders WHERE id = $1`
- Remove the fallback `SELECT id FROM orders WHERE id = $1` since we're already querying orders

**`src/routes/ops.js`** (4 queries):
- Remove `+ (SELECT COUNT(*) FROM cases)` from combined counts — just count orders
- Remove standalone `SELECT COUNT(*) FROM cases WHERE ...` queries
- The cases table contributes zero rows in production (all live data is in orders)

### Phase 3: Stop creating rows in `cases` (cleanup)

If `case_lifecycle.js` inserts into both tables, remove the `cases` insert. Audit `createDraftCase` and any other function that does `INSERT INTO cases`.

### Phase 4: Drop `cases` table (final, optional)

After confirming no queries reference `cases`, create migration `010_drop_cases_table.sql`:

```sql
DROP TABLE IF EXISTS cases;
```

This is optional and should only happen after Phase 2 has been deployed and verified in production.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Orders without cases rows (intelligence silently fails) | **Active bug** | Phase 1+2 fix this immediately |
| Ops dashboard double-counting | Low (cosmetic) | Phase 2 fixes this |
| case_files/case_context/case_events orphaned | None | These use `case_id` = `orders.id`, no change needed |
| Dropping cases table breaks old queries | Low | Phase 4 is optional, only after full verification |

## Recommendation

Execute Phase 1 and Phase 2 together. They are safe, non-breaking changes that fix an active bug (intelligence pipeline failing for orders without `cases` rows). Phase 3 and 4 can be done later as cleanup.

Total files changed: 5 (1 migration SQL + 4 JS files). Every change is a find-and-replace of table name. No logic changes.
