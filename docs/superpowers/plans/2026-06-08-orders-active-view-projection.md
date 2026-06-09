# orders_active View Projection Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recreate the `orders_active` view so it projects every `orders` column, fixing P0-1/P0-2/P0-6/P1-1/P2-1 with one additive migration, guarded by a parity test.

**Architecture:** A `CREATE OR REPLACE VIEW orders_active AS SELECT * FROM orders WHERE deleted_at IS NULL` migration (069) re-expands `*` to the current 71 `orders` columns (currently frozen at 67 from migration 045). A self-asserting `DO` block in the migration and a parity assertion in the existing view test prevent silent re-drift. Validated on a throwaway clone before a coordinated merge to `main` (which auto-deploys to prod).

**Tech Stack:** PostgreSQL 17 (Supabase), Node `pg`, the file-based migration runner in `src/db.js`, the custom test runner in `tests/run.js`.

**Constraints (do not violate):**
- Auto-deploy, prod-only: merge to `main` = immediate prod deploy + migration on boot. No staging DB.
- A failed migration crashloops boot → takes down the public coming-soon page. Dry-run on a clone is mandatory.
- Marketing session is active on `main`. Merge timing is a human checkpoint (ziad clears it).
- READ-ONLY against prod until the coordinated merge. No manual prod DDL.

---

### Task 0: Isolated worktree off latest `main`

**Files:** none (setup only)

- [ ] **Step 1: Fetch and branch off the current production tip**

```bash
cd /Users/ziadelwahsh/tashkheesa-portal
git fetch origin
git worktree add -b fix/orders-active-view-projection /Users/ziadelwahsh/tash-fix-view origin/main
cd /Users/ziadelwahsh/tash-fix-view
git log -1 --format='%h %s'   # expect the current origin/main tip (1e49d68 or newer)
```

- [ ] **Step 2: Confirm node_modules available for running the test**

The worktree has no `node_modules`. Either `npm ci` here, or run tests with the main checkout's modules:
```bash
ls node_modules >/dev/null 2>&1 || echo "use NODE_PATH=/Users/ziadelwahsh/tashkheesa-portal/node_modules or npm ci"
```

---

### Task 1: Parity test (RED — proves drift is detectable)

**Files:**
- Modify: `tests/core/orders-active-view.test.js` (insert after the "VIEW exists" check, ~line 45)

- [ ] **Step 1: Add the parity assertion**

Insert immediately after the `t.pass('orders_active VIEW exists');` block, before `// 2. Insert a fresh test order`:

```js
    // 1b. PARITY GUARD: orders_active must project EVERY column on orders.
    //     The view is `SELECT * FROM orders` — Postgres freezes `*` at creation,
    //     so a future `ALTER TABLE orders ADD COLUMN` silently drifts the view
    //     until it is recreated (migrations 045/069). This assertion auto-tracks
    //     new columns (it reads live information_schema) and fails loudly on drift.
    try {
      const missing = await pool.query(
        `SELECT oc.column_name
           FROM information_schema.columns oc
          WHERE oc.table_schema = 'public' AND oc.table_name = 'orders'
            AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns vc
               WHERE vc.table_schema = 'public' AND vc.table_name = 'orders_active'
                 AND vc.column_name = oc.column_name)
          ORDER BY oc.ordinal_position`
      );
      if (missing.rowCount !== 0) {
        throw new Error(
          'orders_active is missing orders column(s): ' +
          missing.rows.map(function (r) { return r.column_name; }).join(', ') +
          ' — recreate the view (migration 069 pattern)'
        );
      }
      t.pass('orders_active projects every orders column (no drift)');
    } catch (e) { t.fail('orders_active column parity', e); return; }
```

- [ ] **Step 2: Build a dry-run clone of the CURRENT (broken) prod schema**

```bash
URL=$(grep -E '^DATABASE_URL=' /Users/ziadelwahsh/tashkheesa-portal/.env.production | sed -E 's/^DATABASE_URL=//')
pg_dump "${URL}?sslmode=require" --schema=public --schema-only --no-owner --no-privileges -f /tmp/tash-audit/prod-schema.sql
dropdb --if-exists tash_dryrun 2>/dev/null; createdb tash_dryrun
psql tash_dryrun -v ON_ERROR_STOP=0 -f /tmp/tash-audit/prod-schema.sql >/tmp/tash-audit/load.log 2>&1
psql tash_dryrun -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='orders_active'"   # expect 67 (broken)
```
*(Supabase-branch alternative: `mcp__claude_ai_Supabase__create_branch` → apply → verify → `delete_branch`. Use whichever is quicker; the local path above is the deterministic default.)*

- [ ] **Step 3: Run the test against the broken clone — expect FAIL**

Run:
```bash
DATABASE_URL=postgresql://localhost/tash_dryrun JWT_SECRET=dryrun node tests/core/orders-active-view.test.js
```
Expected: `❌ orders_active column parity: orders_active is missing orders column(s): sla_paused_at, sla_remaining_seconds, assignment_status, no_sla_refund_eligibility`

---

### Task 2: Migration 069 (GREEN — makes the parity test pass)

**Files:**
- Create: `src/migrations/069_orders_active_view_projection_fix.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 069_orders_active_view_projection_fix.sql
--
-- Fix: orders_active was created as `SELECT * FROM orders ...` (migration 045).
-- Postgres expands `*` to the table columns AT CREATION TIME and freezes that
-- list, so later `ALTER TABLE orders ADD COLUMN` (056, etc.) did NOT propagate.
-- As of 2026-06-08 the view is missing 4 columns that exist on `orders`:
--   sla_paused_at, sla_remaining_seconds, assignment_status, no_sla_refund_eligibility
-- Code doing `SELECT <col> FROM orders_active` for those columns crashes
-- (queryOne rethrows) or silently empties (safeAll -> []). This breaks the
-- patient order-detail + refund pages, the superadmin manual-queue, the
-- broadcast skip-guard, and dashboard counters.
--
-- This RE-RUNS the 045 statement. `CREATE OR REPLACE VIEW` re-expands `*` to the
-- CURRENT orders columns; the new list preserves the existing 67 columns in the
-- same order and appends the 4 new ones (the only shape CREATE OR REPLACE VIEW
-- allows) — verified against live information_schema (view cols are an in-order
-- prefix of orders cols). PURELY ADDITIVE: no data touched; re-run is a no-op.
--
-- A post-condition guard asserts FULL parity (every orders column is projected)
-- and ABORTS the transaction if not, so any regression fails loudly on boot
-- instead of silently shipping a half-fixed view.

BEGIN;

CREATE OR REPLACE VIEW orders_active AS
  SELECT * FROM orders WHERE deleted_at IS NULL;

-- Post-condition guard: orders_active must project EVERY orders column.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(oc.column_name, ', ' ORDER BY oc.ordinal_position)
    INTO missing
  FROM information_schema.columns oc
  WHERE oc.table_schema = 'public'
    AND oc.table_name = 'orders'
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns vc
      WHERE vc.table_schema = 'public'
        AND vc.table_name = 'orders_active'
        AND vc.column_name = oc.column_name
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'orders_active projection guard failed — missing orders column(s): %', missing;
  END IF;
END $$;

COMMIT;
```

- [ ] **Step 2: Apply the migration to the dry-run clone**

Run:
```bash
psql tash_dryrun -v ON_ERROR_STOP=1 -f src/migrations/069_orders_active_view_projection_fix.sql
psql tash_dryrun -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='orders_active'"   # expect 71
```
Expected: `COMMIT` (no `RAISE EXCEPTION`), column count 71.

- [ ] **Step 3: Run the parity test against the fixed clone — expect PASS**

Run:
```bash
DATABASE_URL=postgresql://localhost/tash_dryrun JWT_SECRET=dryrun node tests/core/orders-active-view.test.js
```
Expected: `✅ orders_active projects every orders column (no drift)` and all existing assertions pass.

- [ ] **Step 4: Re-run the four previously-crashing query shapes against the clone**

Run:
```bash
psql tash_dryrun -c "SELECT no_sla_refund_eligibility FROM orders_active LIMIT 1"
psql tash_dryrun -c "SELECT assignment_status FROM orders_active LIMIT 1"
psql tash_dryrun -c "SELECT id, no_sla_refund_eligibility FROM orders_active WHERE id IS NOT NULL LIMIT 1"   -- patient-detail shape
psql tash_dryrun -c "SELECT assignment_status FROM orders_active WHERE assignment_status='manual_queue' LIMIT 1"  -- superadmin-list shape
```
Expected: all four succeed (no `column ... does not exist`).

- [ ] **Step 5: Drop the dry-run clone**

```bash
dropdb tash_dryrun
```

---

### Task 3: Commit (test + migration together)

**Files:** the two from Tasks 1 & 2.

- [ ] **Step 1: Commit on the feature branch**

```bash
cd /Users/ziadelwahsh/tash-fix-view
git add src/migrations/069_orders_active_view_projection_fix.sql tests/core/orders-active-view.test.js
git commit -m "fix(schema): re-project orders_active so it surfaces all orders columns

orders_active was SELECT * frozen at migration 045; later ADD COLUMNs
(assignment_status, no_sla_refund_eligibility, sla_paused_at,
sla_remaining_seconds) never propagated, crashing patient order-detail,
refund, and superadmin manual-queue reads. Re-run CREATE OR REPLACE VIEW
(additive, verified prefix), guard full parity in-migration, and add a
parity assertion to the view test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Backup, PR, coordinated merge — HUMAN CHECKPOINT

**Files:** none (delivery)

- [ ] **Step 1: Full prod backup (restore point) — immediately before merge**

```bash
URL=$(grep -E '^DATABASE_URL=' /Users/ziadelwahsh/tashkheesa-portal/.env.production | sed -E 's/^DATABASE_URL=//')
pg_dump "${URL}?sslmode=require" --no-owner --no-privileges -Fc -f /tmp/tash-audit/prod-backup-2026-06-08.dump
ls -lh /tmp/tash-audit/prod-backup-2026-06-08.dump   # contains PII — keep local, never commit
```

- [ ] **Step 2: Push and open the PR (base = `main`)**

```bash
git push -u origin fix/orders-active-view-projection
gh pr create --base main --title "fix(schema): re-project orders_active view" \
  --body "Keystone fix from the audit. Additive CREATE OR REPLACE VIEW (re-projects 4 frozen columns) + parity guard + test. Dry-run validated on a prod-schema clone. See docs/superpowers/specs/2026-06-08-orders-active-view-keystone-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 2.5: STOP. Get ziad's go-ahead on merge timing.** Merge = deploy = reboot that also ships whatever else is on `main`. Do not merge until ziad confirms the coming-soon session is clear and traffic is low. **Do not proceed past this step autonomously.**

- [ ] **Step 3: Merge (after go-ahead)**

```bash
gh pr merge --merge --delete-branch
```

---

### Task 5: Post-deploy verification (read-only against prod)

**Files:** none

- [ ] **Step 1: Confirm the deploy picked up the commit**

```bash
sleep 60   # allow Render to build+boot
curl -fsS https://tashkheesa.com/__version | grep -o '"gitSha":"[^"]*"'   # expect the merge commit SHA
```

- [ ] **Step 2: Confirm the migration applied and the view is fixed**

```bash
/tmp/tash-audit/roq "SELECT filename FROM schema_migrations WHERE filename='069_orders_active_view_projection_fix.sql'"
/tmp/tash-audit/roq "SELECT count(*) FROM information_schema.columns WHERE table_name='orders_active'"   # expect 71
/tmp/tash-audit/roq "SELECT assignment_status, no_sla_refund_eligibility FROM orders_active LIMIT 1"     # succeeds
```

- [ ] **Step 3: Confirm the coming-soon page is still up**

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://tashkheesa.com/   # expect 200
```

- [ ] **Step 4: Spot-check the previously-broken routes** (manual, once portal access is exercised): patient order-detail, refund-request, superadmin manual-queue list/detail load without 500/hang.

---

## Self-Review

**Spec coverage:** Migration (§4.1) → Task 2. Parity test (§4.2) → Task 1. Dry-run (§5.3) → Tasks 1–2. Backup (§5.2) → Task 4.1. Coordinated merge (§5.5) → Task 4.2.5. Post-deploy verification (§5.6) → Task 5. Rollback (§6) → covered by the backup (4.1) + fix-forward note. All spec sections mapped.

**Placeholder scan:** No TBD/TODO; every code/SQL/command step is concrete. ✓

**Type/name consistency:** View name `orders_active`, the 4 columns, the migration filename `069_orders_active_view_projection_fix.sql`, and the parity query are identical across the migration, the test, and the verification steps. ✓

**Known limitation (carried from spec §7):** the parity test reliably fails on direct invocation / in the dry-run, but is not a hard CI gate until the runner's async-masking bug (audit P1-14) is fixed — out of scope, flagged for the next cycle.
