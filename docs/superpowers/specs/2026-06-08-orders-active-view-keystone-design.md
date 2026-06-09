# Design — `orders_active` view projection fix (keystone)

- **Date:** 2026-06-08
- **Status:** Approved (Approach A). Awaiting user review of artifacts before any commit/merge.
- **Author:** Claude (paired with ziad)
- **Scope (this cycle):** ONE migration that re-projects the `orders_active` view, plus a parity test. Nothing else.

## 1. Context & constraints (verified this session)

- **Production deploys from `main`.** `tashkheesa.com/__version` → `gitSha 1e49d68`, `mode: production`. `main` = `origin/main` = current prod.
- **Auto-deploy, prod-only.** Merge to `main` ships immediately; migrations run on Render boot **directly against the production DB**; there is **no staging DB**.
- **Public exposure = coming-soon page only.** Patient/doctor portals are not public; the 25 `orders` rows are test/seed. Portal breakage harms no real user — but a **failed migration crashloops boot and takes down the public coming-soon page** (cf. the migration-050 crashloop). That is the risk we manage.
- **Marketing session is actively on `main`** (the coming-soon work). Merge = deploy = reboot, which also ships whatever is on `main`. Merge timing must be coordinated.

## 2. The fix

Re-run migration 045's statement so the view re-expands `SELECT *` to the current `orders` columns:

```sql
CREATE OR REPLACE VIEW orders_active AS SELECT * FROM orders WHERE deleted_at IS NULL;
```

**Root cause:** Postgres expands `*` to the table's columns at view-creation time and freezes that list. Migration 045 created the view; later `ALTER TABLE orders ADD COLUMN` (056 etc.) did **not** propagate. The view is missing exactly 4 columns that exist on `orders`: `sla_paused_at`, `sla_remaining_seconds`, `assignment_status`, `no_sla_refund_eligibility`.

**Proven additive (live `information_schema`):** the view's 67 columns are an exact in-order prefix of `orders`' 71 columns, so `CREATE OR REPLACE VIEW` appends only the 4 missing columns at the end — the only shape `CREATE OR REPLACE VIEW` permits. No data touched. Re-run is a no-op.

**Findings cleared (zero code changes):**
- P0-1 — patient order-detail page (`no_sla_refund_eligibility`)
- P0-2 — refund-request GET + POST (`no_sla_refund_eligibility`)
- P0-6 — superadmin manual-queue list/detail/approve/cancel (`assignment_status`)
- P1-1 — broadcast manual-queue skip-guard (`assignment_status`)
- P2-1 — superadmin dashboard counters (`assignment_status`)

**Explicitly NOT cleared (out of scope this cycle):** P0-3/P0-4 (`reports.js` uninvoked `requireAuth` hang), P0-5 (`reports.js` `locked_price` — column exists on no table), P1-4 (`referrals.js` `locked_price`), P0-7 (negative-margin pricing data). These need code/data changes, not the view.

## 3. Approach (decided)

**A — dry-run on a clone, then one atomic PR.** Riders agreed with the user:
1. **View stays `SELECT *`** (auto-tracks new columns) **+ a parity test** in `tests/core/orders-active-view.test.js` that fails loudly on drift (better than a hand-maintained column list).
2. **Dry-run effort matched to risk:** the additive-prefix property is already proven against live `information_schema`. Use a Supabase branch if it's quick; otherwise a local Postgres loaded with the prod schema dump.
3. **`BEGIN/COMMIT` + post-condition guard in the migration regardless** (the runner wraps nothing in a transaction — verified in `src/db.js`).
4. **`pg_dump` backup before merge** (`scripts/backup-db.js` is dead SQLite; `pg_dump` 18.3 is installed).
5. **Coordinate merge timing with the user**, who clears it with the coming-soon session.

Rejected: **B** (direct prod DDL then sync the file) — manual prod write, violates "Render boot is canonical," creates a file/DB drift window; the dry-run already removes B's only advantage. **C** (harden the migration runner first) — scope-creep for one atomic `CREATE OR REPLACE VIEW`; worth doing later.

## 4. Artifacts

### 4.1 Migration — `src/migrations/069_orders_active_view_projection_fix.sql`

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

-- ── Post-condition guard: orders_active must project EVERY orders column ──
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

### 4.2 Parity test — appended to `tests/core/orders-active-view.test.js`

Inserted as a new assertion immediately after the existing "VIEW exists" check (step 1), before the row-insert steps:

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

## 5. Procedure

1. **Branch** off the latest `main` (e.g. `fix/orders-active-view-projection`); author 069 + the test there. (Use a dedicated worktree to avoid touching the marketing checkout.)
2. **Backup:** `pg_dump` the prod DB (schema + data — it is tiny) to a local, gitignored path. This is the restore point. (Supabase platform backups are the secondary net.)
3. **Dry-run on a clone** (Supabase branch if quick, else local Postgres seeded with the prod schema dump):
   - apply 069 → it succeeds and the guard passes;
   - confirm the 4 columns now appear in `orders_active`;
   - run the four previously-crashing queries (`SELECT no_sla_refund_eligibility FROM orders_active LIMIT 1`, `SELECT assignment_status FROM orders_active LIMIT 1`, plus the patient-detail and superadmin-list query shapes) → all succeed;
   - run `node tests/core/orders-active-view.test.js` directly against the clone → parity assertion passes.
4. **PR to `main`** — just the migration + the test. Small, atomic, fast to review.
5. **Coordinated merge** at a low/zero-traffic moment the user has cleared with the coming-soon session. Merge → Render boots → 069 applies → guard passes → view fixed.
6. **Post-deploy verification (read-only against prod):**
   - `/tmp/tash-audit/roq "SELECT assignment_status, no_sla_refund_eligibility FROM orders_active LIMIT 1"` → succeeds;
   - the previously-broken routes load (patient order-detail, refund-request, superadmin manual-queue) once portal access is exercised;
   - `schema_migrations` shows `069_orders_active_view_projection_fix.sql`.

## 6. Rollback

Migrations are forward-only (filename-tracked; applied DDL persists, and reverting the file does not undo the DDL). Because the change is a `CREATE OR REPLACE VIEW`:
- **If the guard fails on boot:** the transaction rolls back and `069` is not recorded; boot crashloops (coming-soon down). The dry-run is what prevents this from ever reaching prod. Fix-forward: correct the migration, redeploy.
- **If the new view causes an unforeseen problem:** fix-forward with a `070` that recreates the prior/corrected definition, or manually `CREATE OR REPLACE VIEW` from the `pg_dump` view definition. The `pg_dump` backup is the worst-case restore point.

## 7. Known dependency / limitation (flagged, not silently accepted)

The parity test runs inside an async IIFE. The current batch runner (`tests/run.js`) has a separate bug (audit **P1-14**) that can let the process exit before async assertions are counted — so the parity test reliably surfaces drift when **run directly** (`node tests/core/orders-active-view.test.js`) and in the dry-run, but is **not yet a hard CI gate** until P1-14 is fixed. P1-14 is out of this cycle's scope; recommended as the next item when we reassess.

## 8. Out of scope (next reassessment)

P0-3/P0-4/P0-5 (`reports.js`), P1-4 (`referrals.js`), P0-7 (pricing data + market gating), reminder re-fix (P1-5/P1-6), IDOR (P1-7/P1-8), CI gate (P1-13/14/15/16). Each is its own atomic PR under the same dry-run + coordinated-merge discipline established here.
