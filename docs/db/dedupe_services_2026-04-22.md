# Runbook: Services Table Dedupe (2026-04-22)

One-shot DB fix. Run once per environment before applying migration `011_services_unique_name.sql`.

## Problem

Local boot crashed on migration `011_services_unique_name.sql`, which adds:

```sql
ALTER TABLE services
  ADD CONSTRAINT services_specialty_name_unique UNIQUE (specialty_id, name);
```

The constraint could not be created because the `services` table contained duplicate `(specialty_id, name)` pairs.

Scope at diagnosis time (local DB):
- 301 rows in `services`
- 47 duplicate groups, each with exactly 4 rows → 188 duplicate rows
- All 4 rows in every group had byte-identical payloads (verified — 0 groups with differing data)
- Zero references to any duplicate row from `orders.service_id` or `service_regional_prices.service_id`
- No enforced foreign keys target `services.id`

Root cause appears to be a seeder that ran 4× before `ON CONFLICT` deduplication was wired in. Migration 011's header comment references `scripts/dedupe_services.js --live` as the intended precondition — that script was not present / not run, hence this manual procedure.

## Strategy

Keep one row per `(specialty_id, name)` group (`MIN(id)` — deterministic), delete the rest. Because payloads are identical and nothing external references the duplicates, this is value-preserving.

## Exact SQL that was run on local

### Step 1 — Backup (separate transaction so it survives regardless of delete outcome)

```sql
CREATE TABLE services_backup_2026_04_22 AS TABLE services;
-- Expected: 301 rows copied.
SELECT COUNT(*) FROM services_backup_2026_04_22;
```

### Step 2 — Delete with embedded sanity checks

Run with `psql -v ON_ERROR_STOP=1` so a failed `RAISE EXCEPTION` aborts the transaction before `COMMIT` is reached.

```sql
BEGIN;

DO $$
DECLARE
  pre_count      int;
  deleted_count  int;
  post_count     int;
  dup_remaining  int;
BEGIN
  SELECT COUNT(*) INTO pre_count FROM services;

  WITH keepers AS (
    SELECT MIN(id) AS id FROM services GROUP BY specialty_id, name
  )
  DELETE FROM services WHERE id NOT IN (SELECT id FROM keepers);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  SELECT COUNT(*) INTO post_count FROM services;
  SELECT COUNT(*) INTO dup_remaining FROM (
    SELECT 1 FROM services GROUP BY specialty_id, name HAVING COUNT(*) > 1
  ) t;

  RAISE NOTICE 'pre=%  deleted=%  post=%  dup_groups_remaining=%',
                pre_count, deleted_count, post_count, dup_remaining;

  IF deleted_count <> 141 THEN
    RAISE EXCEPTION 'Sanity check FAILED: expected 141 deletions, got %', deleted_count;
  END IF;
  IF (pre_count - post_count) <> 141 THEN
    RAISE EXCEPTION 'Sanity check FAILED: count did not drop by 141 (pre=% post=%)', pre_count, post_count;
  END IF;
  IF dup_remaining <> 0 THEN
    RAISE EXCEPTION 'Sanity check FAILED: % duplicate groups remain', dup_remaining;
  END IF;

  RAISE NOTICE 'Both sanity checks PASSED — safe to commit.';
END $$;

COMMIT;
```

### Step 3 — Apply migration 011 and record it

```sql
BEGIN;
\i src/migrations/011_services_unique_name.sql
INSERT INTO schema_migrations (filename) VALUES ('011_services_unique_name.sql')
  ON CONFLICT (filename) DO NOTHING;
COMMIT;

-- Verify:
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname = 'services_specialty_name_unique';
-- Expected: services_specialty_name_unique | UNIQUE (specialty_id, name)
```

## Sanity checks and expected results (local run)

| Check | Expected | Actual (local) |
|---|---|---|
| `deleted_count` from the DELETE | 141 | 141 |
| `pre_count - post_count` | 141 | 301 − 160 = 141 |
| `dup_remaining` groups after DELETE | 0 | 0 |
| `services_specialty_name_unique` exists | yes | yes |
| Dev server boots cleanly | yes | yes (migrations 013–016 also applied) |

All three `RAISE EXCEPTION` guards must pass; if any fails, the transaction rolls back and no rows are deleted.

## Prod / staging deployment note

**The production and staging databases will need the same treatment before deploying the branch that carries migration 011.** Do NOT deploy until dedupe has been run against the target environment.

Before running on prod:
1. Take a fresh application-level backup (not just the `services_backup_2026_04_22` table) — standard pre-migration snapshot.
2. Re-verify the expected numbers on the target DB first — they may differ from local:
   ```sql
   SELECT COUNT(*) FROM services;
   SELECT COUNT(*) FROM (
     SELECT 1 FROM services GROUP BY specialty_id, name HAVING COUNT(*) > 1
   ) t;
   -- Also: check orders.service_id and service_regional_prices.service_id
   -- references to duplicate IDs are zero. If not, stop and rebind first.
   ```
3. Update the hardcoded `141` in the sanity-check `RAISE EXCEPTION`s to whatever `(pre_count - distinct_groups)` the target DB actually has, OR swap to a relative check: `IF deleted_count <> (pre_count - (SELECT COUNT(*) FROM (SELECT 1 FROM services GROUP BY specialty_id, name) t)) THEN ...`.
4. Run the Step 1 backup, then Step 2 delete, then Step 3 migration apply.
5. Drop `services_backup_YYYY_MM_DD` once the unique constraint has held for a full app cycle (post-deploy smoke passing).

## Rollback

If something goes wrong before `COMMIT` in Step 2, the transaction auto-rolls back (either because a `RAISE EXCEPTION` fired, or because `ON_ERROR_STOP=1` aborted on the first error). No data lost.

If something goes wrong after `COMMIT` and before dropping the backup table:

```sql
BEGIN;
TRUNCATE services;
INSERT INTO services SELECT * FROM services_backup_2026_04_22;
COMMIT;
-- Then also remove the 011 row from schema_migrations if it was recorded:
DELETE FROM schema_migrations WHERE filename = '011_services_unique_name.sql';
-- And drop the constraint if it was created:
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_specialty_name_unique;
```
