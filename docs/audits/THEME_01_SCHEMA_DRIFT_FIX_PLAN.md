# Theme 1 — Schema Drift & Boot Race: Fix Plan

**Date:** 2026-05-06
**Author:** Claude Opus 4.7 (1M context)
**Working tree HEAD:** `213d07d` (`docs(audit): comprehensive pre-launch audit 2026-05-06`)
**Sources:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` § Section 08 findings DATA-1, DATA-2, DATA-3, DATA-4, DATA-5; verified directly against the codebase for this scoping.

> Scoping document only. **No source files have been modified. No migrations have been run.** Diffs in §4 are *proposed*, not applied.

---

## 1. Executive summary

Tashkheesa boots in two phases: (a) a *real* migration runner (`src/db.js#migrate`) that walks `src/migrations/*.sql` and records `schema_migrations`, then (b) a *parallel* fire-and-forget script (`src/migrate_mobile_api.js`) that `ALTER`s + `CREATE`s outside of any history. Boot phase (b) is **not awaited** — Express begins listening before its mutations finish — and it actively undoes mutations from phase (a):

- Migration 010 drops `orders.urgent` (migrated to `urgency_flag`); the boot script re-adds it on every cold start. No code reads it; it's a confused, empty column with default `false` permanently in prod.
- Migration 042 drops the legacy `payments` table; the boot script re-creates it empty on every cold start. The mobile API (`routes/api/cases.js`) still reads from this empty table, returning a `null`-shaped payment object on every mobile case-detail request.
- The boot script added `orders.deleted_at` for soft-delete in April. Of **340** order queries across **46** files, only **4** filter on `deleted_at IS NULL`. Soft-deleted orders leak into patient dashboards, doctor queues, SLA breach sweeps, finance reports, refund handlers, and broadcast targeting.

**User-visible symptoms today:** mobile case-detail returns a hollow payment object; cold-start race lets the first ~1–10s of post-deploy traffic hit a state where `deleted_at` may not yet exist (manifests as "column does not exist" 500s in error_logs); auto-deleted unpaid orders still get SLA breach notifications fired at the (deleted) patient.

**Risk if shipped as-is:** silent ghost-order pollution of every operational dashboard, latent post-deploy 500s, and a permanent precedent that "schema can be added at boot" — which is how this drift got introduced in the first place.

---

## 2. Current state

### Sub-issue A — `migrateForMobileApi(pool)` is fire-and-forget

**Location:** `src/server.js:466` (the audit references `:461`; the actual call is at `:466` — `:461` is the `process.exit(1)` from the migrate-failure branch).

**Verbatim** (`src/server.js:455-470`):

```js
var _dbReady = (async function initDatabase() {
  try {
    await migrate();
    logMajor('Database migration complete');
  } catch (err) {
    logFatal('DB migrate failed — refusing to start', err);
    process.exit(1);
  }

  try {
    var { migrateForMobileApi } = require('./migrate_mobile_api');
    migrateForMobileApi(pool);                                 // ← no await
  } catch (err) {
    console.error('[migrate] Mobile API migration failed:', err.message);
  }
```

**Boot sequence (top-down):**

1. `await migrate()` (line 457) — walks `src/migrations/*.sql` sequentially; awaits `runDataFixups()` and `seedPricingData()`.
2. `migrateForMobileApi(pool)` (line 466) — **returns a Promise that nobody awaits.** The `try/catch` only catches synchronous errors (`require()` throws). Async rejections inside `pool.query` escape into the unhandledRejection guard at `server.js:195-206` and trigger `process.exit(1)`.
3. Staging-only `seedDemoData()` (lines 486-495).
4. IIFE returns.
5. `_dbReady.then(...)` (line 868) registers workers + crons + `app.listen(PORT)` (line 977).

**Race window:** the duration between step 5 starting and the in-flight Promise from step 2 resolving. With Supabase pooler latency, that's typically a few hundred ms; under load or DB pressure it can be seconds.

**git blame:** introduced 2026-04-06 in commit `c15a7b61` ("feat: wire mobile API into portal — PostgreSQL routes, migrations, rate-limit fixes").

### Sub-issue B — `orders.urgent` re-added by the boot path after migration 010 drops it

**Location 1 (re-add):** `src/migrate_mobile_api.js:37`

```js
await safeAddColumn('orders', 'urgent', 'BOOLEAN DEFAULT false');
```

**Location 2 (canonical drop):** `src/migrations/010_broadcast_system.sql:7-12`

```sql
-- 1. Migrate urgent → urgency_flag and drop the legacy column
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='urgent') THEN
    UPDATE orders SET urgency_flag = true WHERE urgent = true AND (urgency_flag IS NULL OR urgency_flag = false);
    ALTER TABLE orders DROP COLUMN urgent;
  END IF;
END $$;
```

**git blame:**

- Re-add: `c15a7b61` (Ziad, **2026-04-06**, mobile API wiring).
- Drop: `f0775732` (Ziad, **2026-04-15**, "feat: order broadcast & notification system").

The boot-path re-add was authored *9 days before* the drop migration. At the time it was written, `orders.urgent` already existed in the schema, so `safeAddColumn` was a no-op. Migration 010 then dropped it, and from that point forward every subsequent boot ran 010 (which is recorded in `schema_migrations` so it doesn't re-run after the first deploy that picked it up — but the boot path re-runs unconditionally and re-adds the column). After ~one prod deploy, the canonical drop is permanently undone every restart.

**Code readers of `orders.urgent`:** **0** (verified `grep -rn 'orders\.urgent\b\|\.urgent\s*=' --include='*.js' src/` excluding `urgency_*` matches → empty).

**Code readers of `orders.urgency_flag`:** 20+ across `validators/orders.js`, `notify/broadcast.js`, `routes/order_flow.js`, `routes/patient.js`, `routes/api/cases_intake.js`, `case_lifecycle.js`, `workers/acceptance_watcher.js`.

**Conclusion:** the drop is correct. The boot-path re-add is the bug. It survives because nothing reads the resurrected column.

### Sub-issue C — `payments` table dropped by 042, re-created empty by the boot path

**Location 1 (re-create):** `src/migrate_mobile_api.js:81-94`

```js
await pool.query(`
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    amount DOUBLE PRECISION,
    currency TEXT DEFAULT 'EGP',
    status TEXT DEFAULT 'pending',
    method TEXT,
    payment_link TEXT,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  )
`);
```

**Location 2 (canonical drop):** `src/migrations/042_paymob_intentions.sql:49-70` — guarded `DROP TABLE payments` (refuses with `RAISE EXCEPTION` if any rows exist; otherwise drops cleanly).

**git blame:**

- Re-create: `c15a7b61` (Ziad, **2026-04-06**).
- Drop: `1fd57fd` (Ziad, "feat(payments): migration 042 — paymob intentions, payment_events, drop legacy payments").

**Code readers of `payments` table** (verified `grep -rn 'FROM payments\|INTO payments\|UPDATE payments\|JOIN payments' --include='*.js' src/`):

| File | Line | Query |
|---|---|---|
| `src/routes/api/cases.js` | 142 | `SELECT status, amount, currency, payment_link as "paymentLink" FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1` |
| `src/routes/api/cases.js` | 358 | `SELECT status, amount, currency, payment_link as "paymentLink", method, paid_at as "paidAt" FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1` |
| `src/routes/api/profile.js` | 139 | `{ table: 'payments', column: 'order_id', subquery: true }` (account-deletion FK enumeration) |

**Conclusion:** 042 was authored under the (incorrect) assumption that the `payments` table was unused. Two mobile-API endpoints still SELECT from it; the third entry is in the GDPR account-deletion list. Currently those SELECTs return zero rows on every call (table is empty by virtue of the CREATE-on-boot), so the mobile UI shows a degraded payment view. If we fix the boot script (delete the CREATE) without also fixing the readers, the mobile API will start throwing "relation does not exist" — visible on every case-detail request.

### Sub-issue D — `deleted_at IS NULL` filter missing in 99% of order queries

**Inventory (verified):**

- Total order-table touch points across `src/`: **340** (counting `FROM orders`, `UPDATE orders`, `INSERT INTO orders`, `DELETE FROM orders`, `JOIN orders`).
- Distinct files touching `orders`: **46**.
- Total references to `deleted_at` across `src/` (any token, any context): **9** — and only **4** of those are actual filters in queries:
  - `src/case_lifecycle.js:548` (the soft-delete sweep itself, writing `deleted_at = $1`)
  - `src/case_lifecycle.js:552` (idempotency guard for the sweep)
  - `src/routes/api/cases.js:35` (mobile case-list)
  - `src/routes/api/cases.js:101` (mobile case-detail)

The remaining 5 references are: `safeAddColumn` in `migrate_mobile_api.js:38`, the index in `migrate_mobile_api.js:114`, and three lines of comments around the soft-delete sweep in `case_lifecycle.js`.

**Per-file order query count (top of distribution):**

| File | Order queries | Filters `deleted_at IS NULL`? | Action |
|---|---:|---|---|
| `src/routes/superadmin.js` | 45 | No | Bug — covers admin dashboard, mark-paid, reassign, cancel, doctor approval. |
| `src/routes/admin.js` | 44 | No | Bug — covers analytics dashboard, KPI tiles, finance views. |
| `src/routes/doctor.js` | 38 | No | Bug — doctor queue, cases list, completed list. |
| `src/routes/patient.js` | 32 | No | Bug — `/dashboard`, my-orders, case-detail, prescription view. |
| `src/routes/analytics.js` | 28 | No | Bug — every analytics dashboard. |
| `src/routes/ops.js` | 14 | No | Bug — /ops dashboard. |
| `src/routes/tash-api.js` | 12 | No | Bug — public stats API. |
| `src/routes/order_flow.js` | 11 | No | Mostly mutations; a few SELECTs need fix. |
| `src/routes/api/cases.js` | 9 | **Yes (the only one)** | Already correct. |
| `src/routes/payments.js` | 8 | No | Bug — Paymob webhook handler reads `orders` to flip status; deleted orders should not be paid. |
| `src/server.js` | 7 | No | Bug — `/files/:fileId` PHI gate; SLA reminder + breach sweep (DATA-3 race compounds this). |
| `src/notify/broadcast.js` | 5 | No | Bug — broadcast eligibility queries. |
| `src/sla_worker.js` (+ `case_sla_worker.js`, `sla_watcher.js`, `jobs/sla_watcher.js`) | 12 combined | No | Bug — SLA sweeps fire breach notifications at deleted orders. |
| `src/auto_assign.js` | 3 | No | Bug — auto-assigns deleted orders (rare; only fires before delete). |
| Others (32 files) | ~76 | No | Mix; most are reads that should filter. |

**Categorization (rules-of-thumb from the inventory above):**

- **MUST filter (live-state reads):** ~250 sites. Patient/doctor/admin dashboards, SLA workers, payment handlers, broadcast targeting, finance reports, file gates.
- **MUST NOT filter (mutations and lookups by id):** mutations are `UPDATE`/`INSERT`/`DELETE`; for those the soft-delete is irrelevant — we're targeting a known row by id. ~60 sites. Single-id `WHERE id = $1` SELECTs (~67 sites) *should* still filter for symmetry, but the impact of skipping is low because they're typically gated by the row-existing check anyway.
- **INTENTIONALLY include deleted (forensic / purge):** the codebase has **zero** explicit "include_deleted" / "show_all" / forensic queries. There is no admin trash view. There is no purge job (the audit notes a 90-day purge is referenced in commit messages but the worker isn't located in `src/`).
- **The soft-delete sweep itself:** `case_lifecycle.js:548` already filters correctly.

**Conclusion:** Roughly 250 sites need the filter. Forensic exclusions are negligible (none today). A `VIEW orders_active AS SELECT * FROM orders WHERE deleted_at IS NULL` lets ~250 sites switch via a one-token rename (`FROM orders` → `FROM orders_active`) without rewriting WHERE clauses.

### Sub-issue E (out-of-scope but related — informational only)

While walking the boot path I confirmed the audit's DATA-5 finding (`order_timeline` table only exists via the boot path; no migration codifies it; routes write to it). This is the *fifth* example of the same root cause as A/B/C, so its fix slots into the same "delete `migrate_mobile_api.js` + codify in migration 043" remediation.

`doctor_specialties` overlaps similarly: created by the boot path *and* by migration 033 (which does an ALTER + INSERT on the same table). Same family of drift.

These are noted here for context; they will be resolved as a side-effect of the recommended fix path. No separate action item.

---

## 3. Root cause

Two distinct causes, with one compounding the other:

**Cause 1: a parallel schema-mutation file (`migrate_mobile_api.js`) was introduced as a shortcut on 2026-04-06 to wire the mobile API in without polluting the migration tree.** It runs unconditionally on every boot, outside `schema_migrations`. As subsequent migrations (010, 015, 033, 042) modified the same tables it touches, nobody updated the boot path to remove the now-redundant adds — so the boot path silently undoes the migration history. This is the root of A, B, C, and (informationally) E.

**Cause 2: `orders.deleted_at` was added in this same parallel script** (line 38), so it never got first-class adoption. There was no migration PR forcing reviewers to grep for "every orders query needs the filter." Soft-delete shipped (April 26) and the rest of the codebase carried on as if it didn't exist. This is the root of D.

**Compounding:** `migrateForMobileApi` is fire-and-forget, so even when the boot-path columns *do* eventually exist in steady state, post-deploy traffic can hit the brief window before they're applied. Any code path that depends on `orders.deleted_at` (e.g. the auto-delete sweep at 48h) can 500 with "column does not exist" on the first ~1-10s after a cold start. The fix for A is a precondition for the fix for D being safe.

---

## 4. Fix plan

> Diffs are *proposed*, not applied. Files referenced by absolute path.

### A — Boot race

Two-step fix; ship step 1 first, plan step 2 within 30 days.

**Step A.1 (small, immediate):** add `await` and convert silent failure to fatal.

`src/server.js:464-469` — proposed diff:

```diff
   try {
     var { migrateForMobileApi } = require('./migrate_mobile_api');
-    migrateForMobileApi(pool);
+    await migrateForMobileApi(pool);
   } catch (err) {
-    console.error('[migrate] Mobile API migration failed:', err.message);
+    logFatal('Mobile API migration failed — refusing to start', err);
+    process.exit(1);
   }
```

**Order of operations:** ship A.1 alone first (no other changes). Verify on staging. Then proceed to B/C/D.

**Risk:** boot now FAILS LOUDLY if `migrate_mobile_api` throws. Today, async failures crash via `unhandledRejection` (which already exits, just less clearly); sync failures are silently logged and the server proceeds anyway. After the fix, both failure modes are explicit `logFatal` + exit. On the first deploy with this fix, any latent `migrate_mobile_api` error will block boot — mitigated by the existing staging-first deploy practice.

**Estimated time:** 30 minutes (1 line edit + log-message tightening + staging verification + prod deploy with rollback ready).

**Step A.2 (medium, within 30 days):** codify everything `migrate_mobile_api.js` does into a new migration `043_codify_mobile_api_schema.sql`, then delete `migrate_mobile_api.js` and the call site at `server.js:464-469`.

The new migration would contain:

- Every `safeAddColumn` from `migrate_mobile_api.js` lines 23-38 EXCEPT `orders.urgent` (sub-issue B) — wrapped in `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`.
- `CREATE TABLE IF NOT EXISTS otp_codes` — verify against migration 015 first (which already creates `otp_codes`); if 015 covers it, skip.
- `CREATE TABLE IF NOT EXISTS order_timeline` — currently boot-path only.
- `CREATE TABLE IF NOT EXISTS doctor_specialties` — verify against migration 033 (which references it); collapse if duplicate.
- `CREATE TABLE IF NOT EXISTS payments` — see sub-issue C; the recommendation is to *drop* this rather than codify, but the migration must still be aware that production currently has this table empty.
- All 7 boot-path indexes (`idx_orders_ref`, `idx_order_timeline`, `idx_notifications_type`, `idx_notifications_is_read`, `idx_payments_order`, `idx_doctor_specialties_doctor`, `idx_orders_deleted_at`).

After 043 is deployed and verified, **delete `src/migrate_mobile_api.js` and remove the call from `server.js:464-469` entirely** in a follow-up commit.

**Risk:** the codification migration must be byte-equivalent to what production currently has, otherwise the next deploy on prod will re-run it (it's a fresh entry in `schema_migrations`) and could fail the `IF NOT EXISTS` checks if column types diverge. Mitigation: dump the current `information_schema` for each touched table on prod, diff against 043, only ship 043 once it's a perfect superset.

**Estimated time:** 4 hours (write 043 from current schema + diff against prod information_schema + staging deploy + verification + prod deploy + delete the old file in a follow-up PR).

### B — `orders.urgent`

Single line deletion + optional cleanup migration.

`src/migrate_mobile_api.js:37` — proposed diff:

```diff
   await safeAddColumn('orders', 'sla_deadline', 'TIMESTAMP');
-  await safeAddColumn('orders', 'urgent', 'BOOLEAN DEFAULT false');
   await safeAddColumn('orders', 'deleted_at', 'TIMESTAMPTZ');
```

After A.2 ships, this entire file is deleted, so B becomes a no-op contribution to A.2.

**Optional cleanup migration `044_drop_orders_urgent.sql`:**

```sql
-- 044: Drop the legacy orders.urgent column. Migration 010 already
-- did this; the boot path was re-creating it on every deploy. After
-- migrate_mobile_api.js stops re-adding it (B), this migration cleans
-- the column off prod once and for all.
ALTER TABLE orders DROP COLUMN IF EXISTS urgent;
```

**Order of operations:** B's source-line deletion can ship in the same commit as A.1 (or as part of A.2). Migration 044 should ship *after* B is deployed, so the column doesn't get re-added between 044 running and the boot path no-op'ing.

**Risk:** none. No code reads `orders.urgent` (verified). Column is empty (default `false`).

**Estimated time:** 5 minutes (one line) + 30 minutes (migration 044 + staging + prod).

### C — `payments` table

Three options. **Recommendation: C1.**

**Option C1 (recommended): update mobile API to read from `orders.payment_status` + a new `orders.payment_link` column. Drop the boot-path `CREATE TABLE`.**

Files to edit:

- `src/routes/api/cases.js:142` — replace SELECT with a read from `orders`:

  ```diff
  -    const paymentRow = await queryOne(
  -      'SELECT status, amount, currency, payment_link as "paymentLink" FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
  -      [orderId]
  -    );
  +    // payments table dropped by migration 042; legacy data lived in orders.
  +    const paymentRow = await queryOne(
  +      'SELECT payment_status as status, COALESCE(total_price_with_addons, price) as amount, currency, payment_link as "paymentLink" FROM orders WHERE id = $1',
  +      [orderId]
  +    );
  ```

- `src/routes/api/cases.js:358` — same pattern; `method` and `paid_at` come from `orders.payment_method` and `orders.paid_at` respectively (both already exist per migrations 020/032).
- `src/routes/api/profile.js:139` — remove `{ table: 'payments', ... }` from the GDPR account-deletion list (table is being deprecated).
- `src/migrate_mobile_api.js:81-94` — delete the `CREATE TABLE IF NOT EXISTS payments` block.

Plus a new migration to add `orders.payment_link` (if not already present — verify against migration 020):

```sql
-- 045: Add orders.payment_link to absorb the field the deprecated
-- payments table held. Used by the mobile case-detail endpoint.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_link TEXT;
```

**Option C2: revert migration 042's drop. Codify `payments` table in a fresh migration. Update orders.paymob_transaction_id to FK into payments.** — Reverts a deliberate consolidation. Not recommended; payment_events was meant to replace `payments`.

**Option C3: build a Postgres VIEW that looks like the old `payments` table.** — Fragile mapping; payment_events doesn't directly contain `payment_link` or `method` per row, so the VIEW would need to JOIN against orders for those fields. Complexity not worth it.

**Order of operations:**

1. Confirm with mobile-app team that the response-shape change in C1 is compatible with the current shipped client (Q1 in §8).
2. Ship migration 045 (ADD COLUMN payment_link).
3. Backfill `orders.payment_link` from `payments.payment_link` for any historical rows (likely zero — `payments` is empty in prod, but verify).
4. Ship the route-handler patches.
5. (As part of A.2) delete the `CREATE TABLE payments` block from `migrate_mobile_api.js`.
6. Eventually: migration 046 with `DROP TABLE IF EXISTS payments;` once we're confident no readers remain.

**Risk:** the response-shape change at routes/api/cases.js:142, :358 must match the mobile client's parser. The current behavior returns `null`-shaped objects (because the table is empty); if the mobile client tolerates null gracefully, the new shape with real values is a strict improvement. But if the client treats `paymentRow == null` as "no payment to show" and the new code returns a populated row for an unpaid order, the UI semantics shift. Mitigation: confirm with mobile team (Q1).

**Estimated time:** 2 hours (read mobile contract + 3 source edits + migration 045 + backfill verification + staging + prod). Plus the migrate_mobile_api delete (5 min, folded into A.2).

### D — `deleted_at` filter coverage

Three options. **Recommendation: D1.**

**Option D1 (recommended): Postgres VIEW `orders_active`.**

Migration `046_orders_active_view.sql` (illustrative):

```sql
-- 046: orders_active is the canonical "live" projection of orders.
-- Reads that should NOT see soft-deleted rows MUST use orders_active.
-- Mutations (UPDATE/INSERT/DELETE) and forensic/audit reads continue
-- to use orders directly.
CREATE OR REPLACE VIEW orders_active AS
  SELECT * FROM orders WHERE deleted_at IS NULL;
```

Then a phased sweep across the 250 read sites: `FROM orders` → `FROM orders_active` (one token).

**Phasing:**

- *Phase 1 (1 hour):* land the migration. Write a `tests/core/orders-active-view.test.js` that confirms the view exists and returns only non-deleted rows.
- *Phase 2 (~2-3 days):* per-file sweep, tested per file before moving on. Order of files (highest impact first):
  - `src/routes/admin.js` (44 reads) → ~half day
  - `src/routes/superadmin.js` (45 reads) → ~half day
  - `src/routes/doctor.js` (38 reads) → ~half day
  - `src/routes/patient.js` (32 reads) → ~half day
  - `src/routes/analytics.js` + `ops.js` + `tash-api.js` + `order_flow.js` + `payments.js` + `server.js` + remaining (~106 reads combined) → ~half day
  - SLA workers (`case_sla_worker.js`, `sla_watcher.js`, `jobs/sla_watcher.js`, `sla_worker.js`, `server.js#runSlaReminderJob`) (12 reads) → ~30 minutes — **highest priority** because deleted+breached is the noisiest interaction.
- *Phase 3 (2-4 hours):* production smoke test with a soft-deleted test order (set deleted_at, walk every dashboard, restore).

Per-route work pattern (illustrative diff for `src/routes/admin.js:61`):

```diff
-    "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) != 'completed'"
+    "SELECT COUNT(1) AS c FROM orders_active WHERE LOWER(COALESCE(status, '')) != 'completed'"
```

**Option D2: append `AND deleted_at IS NULL` to every WHERE clause.** Brittle and easy to forget for the 251st query when someone adds it next month. Doesn't move the bug class.

**Option D3: Postgres Row-Level Security policy.** Most robust but requires session-role config and changes the security model. High blast radius; not recommended for this sprint.

**Order of operations:**

1. Ship A.1 first (closes the race window where `deleted_at` may not yet exist).
2. Ship migration 046 (creates the view).
3. Sweep route files in priority order, testing per file.
4. Once all reads are migrated, optionally add a lint test that grep-fails any new `FROM orders\b` not on an allowlist.

**Risk:**

- VIEWs are not directly UPDATE-able. Any site that does `UPDATE orders` must remain on `orders` (not `orders_active`). The sweep is reads-only — straightforward to verify by grepping for `UPDATE orders_active` post-sweep (must return zero).
- Postgres can sometimes pessimize plans through views. Run `EXPLAIN` on the highest-traffic dashboard query (`admin.js:851` — the totals SUM) before/after.
- We have no admin "trash" view today. If Ziad wants forensic restore (Q2), it needs a separate route reading `FROM orders WHERE deleted_at IS NOT NULL`.

**Estimated time:** ~3 days for safe, tested rollout.

---

## 5. Verification steps

### A — boot determinism

1. **Local pre-flight:** `node -e "require('./src/server')"` — confirm boot completes without exit code 1.
2. **Log ordering on staging:** after deploy, `tail -f` Render logs and confirm:
   - `Database migration complete` (from `migrate()`)
   - `[migrate] Running mobile API migrations...` (boot script start)
   - `[migrate] Mobile API migrations complete.` (boot script end)
   - `Tashkheesa portal running on port 3000` (listen)
   in that order. **The "complete" line must appear before "running on port" — that is the guarantee A.1 buys.**
3. **Cold-start test on Render free-tier:** deploy to staging → wait 15+ minutes for spin-down → curl `/healthz` → check log order on the cold-start. Repeat 3x to rule out timing flukes.
4. **Failure-mode test:** in a short-lived branch, intentionally break `migrate_mobile_api.js` (e.g. add `await pool.query('SELECT * FROM table_that_does_not_exist')` at line 12). Deploy to staging. Confirm the server exits 1 with `logFatal('Mobile API migration failed — refusing to start', err)` rather than serving traffic. Revert the branch.
5. **First-request smoke:** immediately after a successful prod deploy, hit a route that touches `orders.deleted_at` (e.g. `/dashboard` as a logged-in patient). Confirm 200, not 500 with "column deleted_at of relation orders does not exist". Run `grep -c "column .* does not exist" error_logs` for the first 5 minutes — must be 0.

### B — `orders.urgent` absence

1. **DB check (staging):**
   ```sql
   SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='orders' AND column_name='urgent';
   ```
   Before fix: returns 1 row. After source fix (B without 044): boot still re-adds it; fails. After source fix + boot path stops running it (i.e. after A.2): returns 0 rows on a fresh DB. After migration 044: returns 0 rows on prod.
2. **Code check:**
   ```bash
   grep -rn "orders\.urgent\b\|\.urgent\s*=" --include='*.js' src/ | grep -v urgenc
   ```
   Must be empty.
3. **Smoke:** create a new case via `POST /patient/new-case/step1` and follow through to step 5. Confirm `urgency_flag` is set correctly (true for VIP/urgent tiers, false for standard) and the order persists.

### C — `payments` table removal

1. **DB check (staging, after A.2 ships):**
   ```sql
   SELECT relname FROM pg_class WHERE relname='payments' AND relkind='r';
   ```
   Must return 0 rows on a fresh DB.
2. **Code check:**
   ```bash
   grep -rnE "FROM payments\b|INTO payments\b|UPDATE payments\b" --include='*.js' src/
   ```
   Must be empty after the cases.js / profile.js patches.
3. **Mobile smoke:**
   ```
   curl -X GET https://staging.tashkheesa.com/api/v1/cases -H "Authorization: Bearer <token>"
   ```
   Confirm response includes `payment.status`, `payment.amount`, `payment.currency`, `payment.paymentLink` (now sourced from `orders`).
   ```
   curl -X GET https://staging.tashkheesa.com/api/v1/cases/<test-paid-order-id>
   ```
   Confirm `payment.paidAt` is populated (sourced from `orders.paid_at`).
4. **Backfill verification:** `SELECT COUNT(*) FROM payments;` on prod *before* removing the boot-path CREATE → should be 0 (consistent with the audit's claim that `payments` has never been written by current code). If non-zero, STOP and investigate before deleting.

### D — `deleted_at` filter coverage

1. **View existence:**
   ```sql
   SELECT * FROM orders_active LIMIT 1;
   ```
   Returns one row (the view is queryable).
2. **Per-file regression: insert a soft-deleted test order in staging, walk every dashboard.**
   ```sql
   UPDATE orders SET deleted_at = NOW() WHERE id = 'staging-test-order-id';
   ```
   Then for each route migrated in Phase 2:
   - GET the dashboard URL while logged in as the appropriate role (patient / doctor / admin / superadmin).
   - Confirm `staging-test-order-id` does NOT appear on the page.
   - Restore with `UPDATE orders SET deleted_at = NULL WHERE id = 'staging-test-order-id'` and re-verify it reappears.
3. **SLA worker regression (highest stakes):**
   - Soft-delete an order whose `deadline_at` is in the past.
   - Wait for the next SLA sweep (5min interval).
   - Confirm `error_logs` does NOT show breach notification queued for the deleted order.
   - Confirm `notifications` table does NOT have a new `template='sla_breached_*'` row for that order.
4. **Lint test (CI):**
   ```bash
   ! grep -rnE "FROM orders\b" --include='*.js' src/ | \
     grep -vE "FROM orders_active|FROM orders WHERE deleted_at|FROM orders\b.*-- include-deleted-ok" | \
     grep -vF "src/case_lifecycle.js"
   ```
   (Allowlist: case_lifecycle.js for the soft-delete sweep itself; explicit `-- include-deleted-ok` comment for forensic queries.) The grep must return nothing.

### Render cold-start test plan (specific to A)

**Goal:** prove that after a Render deploy, the very first incoming request can safely depend on every column listed in `migrate_mobile_api.js`.

1. Deploy fix A.1 to staging.
2. SSH to a probe machine; install `httpie` or use `curl`.
3. From the Render dashboard, manually deploy a no-op (e.g. push an unchanged commit). This forces a cold start.
4. As soon as Render shows "Live", race a request: `time curl -i https://staging.tashkheesa.com/dashboard`.
5. Confirm:
   - HTTP 302 to `/login` (anonymous request) — not 500.
   - Render logs show the boot-sequence ordering from §5.A.2.
6. Repeat with a logged-in session cookie hitting `/dashboard` directly. Confirm 200 with the patient dashboard rendering.
7. Repeat 3 times. The race window should be unreachable after A.1.

If any of the 3 cold-start probes returns 500 with a "column does not exist" error, A.1 is insufficient and we need to investigate further (likely a different un-awaited mutation elsewhere).

---

## 6. What to add to the test suite

Test runner: `tests/run.js` (zero-deps, function-style assertions, function-style code).

### A.1 — boot await

**File (new):** `tests/core/boot-await-mobile-api.test.js`

```js
// Asserts that server.js awaits migrateForMobileApi before app.listen.
// Catches the regression class where boot is fire-and-forget.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
_testRunner.test('migrateForMobileApi is awaited', () => {
  if (!/await\s+migrateForMobileApi\s*\(/.test(src)) {
    throw new Error('src/server.js does not await migrateForMobileApi(pool); boot race risk.');
  }
});
```

**Asserts:** `await migrateForMobileApi(...)` literal exists in `server.js`. Source-level check; no DB / network needed.

### A.2 — codification (when delivered)

**File (new):** `tests/core/no-mobile-api-boot-script.test.js`

```js
// After A.2: migrate_mobile_api.js must be deleted; everything is in src/migrations/.
const fs = require('fs');
const path = require('path');
_testRunner.test('migrate_mobile_api.js has been removed', () => {
  const p = path.join(__dirname, '..', '..', 'src', 'migrate_mobile_api.js');
  if (fs.existsSync(p)) {
    throw new Error('src/migrate_mobile_api.js still exists; A.2 not complete.');
  }
});
```

### B — `orders.urgent` is gone from code

**File (new):** `tests/core/no-orders-urgent.test.js`

```js
// Asserts no source file references orders.urgent (column removed by migration 044).
const { execSync } = require('child_process');
_testRunner.test('no source file references orders.urgent', () => {
  let hits;
  try {
    hits = execSync(
      "grep -rnE 'orders\\.urgent\\b|\\.urgent\\s*=' --include='*.js' src/ | grep -v urgenc || true",
      { encoding: 'utf8' }
    ).trim();
  } catch (_) { hits = ''; }
  if (hits) throw new Error('Found orders.urgent references:\n' + hits);
});
```

### C — payments table not read from mobile API

**File (new):** `tests/core/no-payments-table-readers.test.js`

```js
// Asserts no route reads from the deprecated `payments` table.
const { execSync } = require('child_process');
_testRunner.test('no route reads FROM payments', () => {
  const hits = execSync(
    "grep -rnE 'FROM payments\\b|INTO payments\\b|UPDATE payments\\b|JOIN payments\\b' --include='*.js' src/ || true",
    { encoding: 'utf8' }
  ).trim();
  if (hits) throw new Error('Found legacy payments-table readers:\n' + hits);
});
```

### D — orders_active VIEW + filter coverage

**File 1 (new):** `tests/core/orders-active-view.test.js`

Integration test (requires DB):

```js
// Insert an order, soft-delete it, query orders_active, assert it's hidden.
_testRunner.test('orders_active VIEW excludes soft-deleted rows', async () => {
  const { pool } = require('../../src/pg');
  const id = 'test-soft-delete-' + Date.now();
  await pool.query("INSERT INTO orders(id, status) VALUES ($1, 'new')", [id]);
  await pool.query("UPDATE orders SET deleted_at = NOW() WHERE id = $1", [id]);
  const r = await pool.query("SELECT id FROM orders_active WHERE id = $1", [id]);
  if (r.rowCount !== 0) throw new Error('soft-deleted order leaked into orders_active');
  await pool.query("DELETE FROM orders WHERE id = $1", [id]);
});
```

**File 2 (new):** `tests/core/orders-table-readers-allowlist.test.js`

Lint-style:

```js
// Asserts every `FROM orders` outside an allowlist either uses orders_active or
// includes deleted_at IS NULL. Catches new bugs introduced by future PRs.
const { execSync } = require('child_process');
const ALLOWLIST = [
  'src/case_lifecycle.js',           // soft-delete sweep itself
  'src/migrate_mobile_api.js',       // (will be deleted in A.2)
  // Add explicit forensic / admin-trash files here as they're added.
];
_testRunner.test('no unfiltered orders reads outside allowlist', () => {
  const raw = execSync(
    "grep -rnE 'FROM orders\\b' --include='*.js' src/ || true",
    { encoding: 'utf8' }
  ).trim();
  const offenders = raw.split('\n').filter(line => {
    if (!line) return false;
    if (/orders_active/.test(line)) return false;
    if (/deleted_at\s+IS\s+NULL/.test(line)) return false;
    if (/-- include-deleted-ok/.test(line)) return false;
    const file = line.split(':')[0];
    if (ALLOWLIST.includes(file)) return false;
    return true;
  });
  if (offenders.length) throw new Error('Unfiltered orders reads:\n' + offenders.join('\n'));
});
```

### Cross-cutting

**File (new):** `tests/core/migration-runner-self-sufficient.test.js`

```js
// Asserts that running migrate() against a fresh DB produces every column /
// table / index that the application expects, without needing migrate_mobile_api.
// Catches future schema drift between migrations and boot-path.
// (Heavyweight: spin up a temp Postgres via testcontainers or pg-mem; only
// runs when TEST_INTEGRATION=1.)
```

---

## 7. Rollback plan

Each fix is independently reversible. Order matters: roll back D before C before B before A.

| Fix | Rollback | Data harm? | Time |
|---|---|---|---|
| A.1 | Revert the `await` and the `logFatal`/`process.exit` lines. Server returns to fire-and-forget. | None. | 5 min |
| A.2 | Restore `src/migrate_mobile_api.js` from git. Restore the call site at server.js:464-469. Add migration 047 marking 043 as superseded if needed. | None — 043's mutations are already in production schema; restoring boot path is a no-op. | 30 min |
| B (source) | Revert the `safeAddColumn('orders', 'urgent', ...)` deletion. | None. | 1 min |
| 044 (DROP urgent) | Migration 048: `ALTER TABLE orders ADD COLUMN urgent BOOLEAN DEFAULT false;` | Empty column re-created; no historical data was in it (010 already moved values to urgency_flag). | 15 min |
| 045 (ADD payment_link) | Migration 049: `ALTER TABLE orders DROP COLUMN payment_link;` | Loses any payment_link values written between 045 and rollback — likely 0 in the immediate window. | 15 min |
| C (cases.js patches) | Revert source diffs. Mobile API resumes reading from `payments` (which is empty). | UX regression on mobile case-detail. | 5 min |
| 046 (DROP payments, if shipped) | Migration 050: `CREATE TABLE payments (... same shape as before ...);`. | None — table is empty in prod. | 30 min |
| D phase 2 (route sweeps) | Per-file revert. Each file is independent. | Soft-deleted orders re-appear in dashboards (the original buggy state). | 5-30 min per file |
| 046 (orders_active VIEW) | `DROP VIEW orders_active;`. Then revert the `FROM orders_active` → `FROM orders` substitutions (requires the per-file revert above to land first, otherwise you have queries pointing at a now-missing view). | None. | 1 hour for full revert |

**Fast-rollback drill (if a launch-day disaster happens):**

1. **Symptom:** post-deploy mobile case-detail returns 500 with "column payment_link does not exist."
2. **Action:** revert 045 + cases.js patches — `git revert <sha>`. Re-deploy. Mobile case-detail resumes returning the hollow shape. Triage why 045 didn't apply on the boot before deploy.

---

## 8. Open questions for Ziad

These need a product/architecture decision before fixing. Each has concrete options A/B/C with my recommendation.

### Q1: Does the mobile app display `payments.payment_link` and/or `payments.method`?

This blocks Option C1.

- **Option A:** *Both fields are displayed.* We need to (a) add `orders.payment_link` (already proposed in migration 045), and (b) ensure `orders.payment_method` (already exists per migration 020) is exposed in the mobile response. Two-field fix.
- **Option B:** *Only `payment_link` is displayed; `method` is unused on mobile.* Migration 045 alone is sufficient; the response shape adapter only needs `payment_link`.
- **Option C:** *Neither is displayed; the mobile UI just shows "Paid" / "Unpaid" / "Refunded".* No new column needed; just remove the fields from the API response shape.
- **My recommendation: B.** `orders.payment_method` already exists, so wiring it into the response is free. `payment_link` is the only field that needs a new column. Migration 045 + the cases.js patch covers it.

### Q2: Do we build an admin "trash" view for soft-deleted orders before launch?

This affects how D's allowlist evolves.

- **Option A:** *Yes, build it now.* Add `/superadmin/orders/trash` — `FROM orders WHERE deleted_at IS NOT NULL`. ~half-day. Lets ops investigate or restore.
- **Option B:** *No, never.* Soft-deleted = invisible to UI forever. If ops needs to investigate, they use raw SQL via the pgAdmin / Supabase console. Faster, simpler.
- **Option C:** *Defer.* Ship D with the allowlist explicitly empty. Build the trash view post-launch only if ops asks for it.
- **My recommendation: C.** Pre-launch we have ~0 deleted orders in prod (auto-delete only fires at 48h unpaid; pre-launch we have ~0 unpaid orders). The trash view solves a problem we don't yet have. Defer to month 2.

### Q3: Do we await `migrateForMobileApi` (A.1, ~30 min, ship today) or codify-and-delete (A.2, ~4 hours, ship within 30 days)?

- **Option A:** *Just A.1.* Ship the await today. Codify never; live with the boot path.
- **Option B:** *Skip A.1, jump straight to A.2.* Ship the codification migration 043 today, delete the boot path entirely, and the await question becomes moot.
- **Option C:** *Two-phase.* A.1 today (immediate race fix); A.2 within 30 days (eliminate the parent bug class).
- **My recommendation: C.** A.1 is a 1-line fix that closes the race. A.2 is the real cure but requires careful information_schema diffing to avoid prod surprise. Don't blend them; ship the cheap win first.

### Q4: Migration 044 (DROP `orders.urgent`) — ship now or never?

- **Option A:** *Ship now.* Once the boot path stops re-adding `urgent`, run `ALTER TABLE orders DROP COLUMN IF EXISTS urgent;` to clean prod. Cost: 15 min staging + prod.
- **Option B:** *Leave it.* Column is empty (default `false`); nothing reads it. A future migration that touches `orders.urgent` would get surprised, but the next 6 months of work doesn't go near it.
- **My recommendation: A.** Schema hygiene is cheap when the column is empty. Migrations are cheaper than cleanup retrospectives. Plus, having `orders.urgent` AND `orders.urgency_flag` in the schema is the kind of thing that confuses a future engineer reading `\d orders` in psql.

### Q5: For the soft-delete VIEW (D-Option-1), what name?

- **Option A:** `orders_active`. Additive — read sites switch to `FROM orders_active`. Forensic / mutation reads stay on `FROM orders`. (My recommendation.)
- **Option B:** `orders_visible`. Same shape, less precise name (a soft-deleted order is also "invisible" from a different angle).
- **Option C:** *Inverse rename — `orders` → `orders_all`, then `CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL`.* Existing queries auto-filter without code change. **HIGH BLAST RADIUS** — every migration, ORM tool, ad-hoc script, and DBA query is silently retargeted. Most "no code change" promises break in non-obvious places.
- **My recommendation: A.** Additive, low blast radius, explicit. The cost (touching 250 sites) is buying us a clearer mental model: `orders` = source of truth (mutations, forensic); `orders_active` = the live read view.

### Q6: Soft-delete adoption scope — sweep ALL 250 reads or just the SLA workers + dashboards?

- **Option A:** *All 250.* Three-day sweep, full coverage.
- **Option B:** *Just the highest-stakes 30:* SLA workers (12), patient dashboard (~6), doctor dashboard (~5), admin/superadmin orders list (~7). Half-day sweep. Acceptable for launch; remaining 220 sites run with the (rare today) bug pattern.
- **Option C:** *Subset + lint test:* sweep the highest-stakes 30 now; add the lint test from §6 (D-File-2) so any *new* read is forced to use `orders_active`. Existing un-migrated reads are tolerated for one milestone, then audited.
- **My recommendation: C.** Pre-launch the soft-delete population is essentially zero (no auto-deletes have fired in prod). The bug exists but its blast radius today is microscopic. Buy the high-stakes coverage for launch confidence; let the long tail follow.

---

## Out-of-scope notes

- **No source file was modified.** All diffs in §4 are illustrative.
- **No migration was run.** Migrations 043, 044, 045, 046 are *proposed* names.
- **The audit reference of `server.js:461`** for the un-awaited call is off-by-five; the actual call is at `:466`. Verified directly. The `:461` line is the `process.exit(1)` from the `migrate()` failure branch. (I'm flagging this for your awareness — no edit needed; the audit is a snapshot, this report is the working artifact.)
- **No new P3-DRIFT-N entries** — every drift symptom found during this scoping was already in the audit (DATA-1 through DATA-5). The most "interesting" peripheral discovery was that `doctor_specialties` is created by both `migrate_mobile_api.js` and migration 033, which collapses naturally into A.2's codification — no separate ticket.
