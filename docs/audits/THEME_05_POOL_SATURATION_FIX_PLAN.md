# Theme 5 — Pool Saturation Under Concurrent Payments: Fix Plan

**Date:** 2026-05-07
**Author:** Claude Opus 4.7 (1M context)
**Working tree HEAD:** `269f2e2` (Theme 3 fix shipped)
**Sources:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` § findings PERF-P0-1 / PERF-P0-2 / PERF-P0-3; verified directly against the live `269f2e2` codebase for this scoping.

> Scoping document only. **No source files have been modified. No migrations or load tests have been run.** Diffs in §4 are *proposed*, not applied.

---

## 1. Executive summary

The first paid order in production today acquires a `pg.Pool` client for `markCasePaid`'s `withTransaction` and holds it through the entire post-payment ceremony — `transitionCase`, three `logCaseEvent` writes, a `triggerNotification`, `dispatchSlaReminders`, and a final `getCase`. The held client is correct (it's the row-lock owner). The bug is that **every helper called inside the transaction ignores the `client` argument and re-acquires from the module-level pool.** A single payment therefore consumes one held slot plus ~12 transient slots during its ~150 ms window — peak 2 slots concurrent. With `pool.max=10`, **five simultaneous payments saturate the pool**, queue request handlers behind a 15 s `connectionTimeoutMillis`, and trip the SLA-sweep flakiness the audit caught.

Two compounding configuration gaps make this worse: the pool has **no `statement_timeout`** (a runaway query holds its slot indefinitely), and **`pg-boss` falls back to `DATABASE_URL`** (the Supabase pgbouncer pooler) when `DATABASE_URL_DIRECT` is unset — so background-job long-poll connections can sit on the same 15-slot pgbouncer budget the request pool depends on, and pg-boss `LISTEN/NOTIFY` + advisory-lock semantics misbehave on pgbouncer transaction-mode.

Threading `client` through `markCasePaid`'s helpers reduces peak slot use per payment from 2 → 1, doubling concurrent-payment capacity. Adding `statement_timeout=30000` caps the worst case. Hard-failing on missing `DATABASE_URL_DIRECT` re-isolates pg-boss from the request pool. None of the four sub-issues touch schema. Estimated effort: ~1 day.

---

## 2. Current state

### Sub-issue A — `markCasePaid` txn client not threaded through helpers

**Location:** `src/case_lifecycle.js:1332-1404`

**Verbatim handler shape:**

```js
async function markCasePaid(caseId) {
  await ensureColumnCache();

  return await withTransaction(async (client) => {
    // Lock the row for the duration of this transaction.
    const existing = await client.query(
      `SELECT * FROM ${CASE_TABLE} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [caseId]
    ).then(r => r.rows[0]);
    if (!existing) throw new Error('Case not found');
    /* …idempotency/urgent-window guards… */

    const slaHours = resolveSlaHoursForCase(existing);
    const paidAt = existing.paid_at || nowIso();
    await transitionCase(caseId, CASE_STATUS.PAID, {           // ← pool, not client
      sla_hours: slaHours,
      paid_at: paidAt,
      deadline_at: null
    });

    try {
      await execute(                                            // ← pool, not client
        `UPDATE notifications SET cancelled_at = COALESCE(cancelled_at, $1)
          WHERE template LIKE 'payment_reminder_%'
            AND response->>'case_id' = $2`,
        [nowIso(), String(caseId)]
      );
    } catch (e) { /* best-effort */ }

    await logCaseEvent(caseId, 'PAYMENT_CONFIRMED', {           // ← pool
      sla_hours: slaHours, urgency_tier: existing.urgency_tier || 'standard'
    });
    await logCaseEvent(caseId, 'CASE_READY_FOR_ASSIGNMENT');    // ← pool
    await triggerNotification(caseId, 'payment_confirmation', { // ← pool (logCaseEvent under)
      sla_hours: slaHours, urgency_tier: existing.urgency_tier || 'standard'
    });

    try { await dispatchSlaReminders(caseId); }                 // ← pool (cascade)
    catch (e) { /* do not block payment flow */ }

    return await getCase(caseId);                               // ← pool
  });
}
```

**Helper-by-helper accounting** (every callee inside the txn):

| Call site | Helper | Signature | Accepts `client`? | Pass `client`? | Pool ops |
|---|---|---|---|---|---|
| `:1340` | `client.query(SELECT … FOR UPDATE)` | (text, params) | yes (it IS the txn client) | ✓ | 0 fresh (uses held) |
| `:1370` | `transitionCase(caseId, status, data)` (`:1211`) | `(caseId, nextStatus, data = {})` | **no** | n/a | 4 fresh (see below) |
| `:1379` | module-level `execute(UPDATE notifications …)` | `(sql, params)` against `pool` | **no** | n/a | 1 fresh |
| `:1390` | `logCaseEvent(caseId, 'PAYMENT_CONFIRMED', meta)` (`:1122`) | `(caseId, eventType, payload)` | **no** | n/a | 1 fresh |
| `:1391` | `logCaseEvent(caseId, 'CASE_READY_FOR_ASSIGNMENT')` | same | **no** | n/a | 1 fresh |
| `:1392` | `triggerNotification(caseId, 'payment_confirmation', meta)` (`:1135`) | `(caseId, type, payload)` | **no** | n/a | 1 fresh (cascades to `logCaseEvent`) |
| `:1397` | `dispatchSlaReminders(caseId)` (`:257`) | `(caseIdOrRow, opts = {})` | **no** | n/a | ~3 fresh on the common short-circuit path; up to ~24 fresh if all reminder thresholds fire |
| `:1402` | `getCase(caseId)` (`:1139`) | `(caseIdOrParams)` | **no** | n/a | 1 fresh |

`transitionCase` itself fans out to four module-level helpers, none of which accept `client`:

| Inner call | File:line | Pool ops |
|---|---|---|
| `ensureColumnCache()` | `:101` | 0 fresh on hot path (cached after first boot) |
| `getCase(caseId)` (existing-row fetch at `:1213`) | `:1139` | 1 fresh |
| `updateCase(caseId, updates)` | `:1180` | 1 fresh |
| `logCaseEvent(caseId, 'status:paid', {from})` | `:1122` | 1 fresh |
| `getCase(caseId)` (return-row fetch at `:1291`) | `:1139` | 1 fresh |

**Quantification** (single payment, common-case happy path, no SLA reminders fire):

| Phase | Held slots | Transient slots in flight |
|---|---:|---:|
| `withTransaction(client)` opens, `BEGIN`, `SELECT FOR UPDATE` | 1 (txn) | 0 |
| `transitionCase` body (4 module pool ops, sequential) | 1 (txn) | 1 (rotating) |
| `execute(UPDATE notifications)` | 1 (txn) | 1 |
| `logCaseEvent` × 3 | 1 (txn) | 1 |
| `dispatchSlaReminders` short-circuit | 1 (txn) | 1 |
| `getCase` final | 1 (txn) | 1 |
| `COMMIT`, release | 0 | 0 |

**Peak concurrent slot use per payment: 2** (the held txn client + one rotating transient pool query). Over the ~150 ms duration of the transaction, **~12 fresh pool checkouts** happen serially.

**git blame:** the `withTransaction` wrapper was introduced 2026-05-06 (`7fb8a12`, Theme 1 / `markCasePaid` row-lock hardening). The same commit added the `deleted_at IS NULL` filter inline. The bug was inherited at that point — the helpers were already pool-bound and the wrapper was added on top without threading.

### Sub-issue B — No `statement_timeout` on the request pool

**Location:** `src/pg.js:42-48`

**Verbatim:**

```js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: PG_POOL_MAX,                          // 10
  idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS, // 30000
  connectionTimeoutMillis: PG_POOL_CONNECT_TIMEOUT_MS // 15000
});
```

No `statement_timeout`, no `query_timeout`. The recent comment in the file (`:32-37`) explicitly raised `connectionTimeoutMillis` from 5 s → 15 s to absorb pool-acquire stalls under request-burst contention — that masks the symptom but doesn't bound the runtime of any individual query. A query that hangs (a missing-index scan over `order_events`, a `LIKE '%foo%'` on a large table, a lock wait, a network blip while the result is being streamed) holds the slot for as long as it takes — possibly indefinitely.

**Recommended default: `statement_timeout=30000` (30 s).** Above any legitimate OLTP query in this codebase; below the 60-second wall most upstream proxies (Render edge, Cloudflare) cap at. The recently introduced superadmin LIKE-CTE in `src/routes/superadmin.js:914-960` is the only real candidate for exceeding 30 s, and it's a known finding (PERF-P1 from the Theme 1 audit) that needs an index, not a longer timeout.

### Sub-issue C — `pg-boss` `DATABASE_URL_DIRECT` silent fallback to `DATABASE_URL`

**Location:** `src/job_queue.js:13-29`

**Verbatim:**

```js
async function startJobQueue() {
var connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!connectionString) {
    logMajor('[job-queue] DATABASE_URL not set — skipping pg-boss');
    return;
  }

  boss = new PgBoss({
    connectionString: connectionString,
    /* … retryLimit, retryDelay, expireInSeconds, retentionDays,
       archiveCompletedAfterSeconds, monitorStateIntervalSeconds … */
  });
  /* boss.on('error', …) and await boss.start(); */
}
```

`DATABASE_URL_DIRECT` is **not in `.env.example`** (verified: `grep -n DATABASE_URL_DIRECT .env.example` returns only the line for `DATABASE_URL`). The audit's full env-var inventory at `COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md:5210` confirms it as one of the 28 vars "in code, NOT in .env.example (silent risk)". Whether it is currently set in Render's runtime environment is **not visible from this scoping** — see §8 OQ-1.

**Why it matters:**

1. `DATABASE_URL` on Render → Supabase resolves to the **pgbouncer pooler** (`aws-1-us-east-1.pooler.supabase.com:6543`, transaction-mode pooling).
2. pg-boss's design relies on three semantics that pgbouncer transaction-mode breaks:
   - **`LISTEN`/`NOTIFY`** — pg-boss subscribes to per-queue channels for low-latency job dispatch. Notifications across pgbouncer transaction-mode are silently dropped because the listening connection isn't pinned to one backend.
   - **Postgres advisory locks** — pg-boss uses `pg_advisory_lock` to enforce cross-instance singleton crons (e.g. the SLA sweep). Advisory locks are session-scoped; transaction-mode pgbouncer hands the same logical "session" to whichever backend is free, so the lock can be acquired by one instance and "owned by" another — i.e. effectively no lock.
   - **Long-poll worker connections** — `boss.work(...)` keeps a connection open per worker. On pgbouncer this counts against the same 15-slot Supabase Free budget the request pool draws from.
3. The audit captured this exact concern at `PERF-P0-2`: "Loses cross-instance singleton guarantee for the SLA sweep (the entire reason it was migrated to pg-boss); plus pg-boss long-poll connections eat the same 15-slot Supabase budget."

**Where the architecture intends this to land:** `src/pg.js:25-30` already documents the model:
> Supabase Free pgbouncer transaction-mode caps client connections at 15 per project; running a single Render instance with **max=10 leaves headroom for pg-boss direct (port 5432, separate pool)**, Supabase internal connections, and burst spikes.

So the canonical state is: pg-boss connects via direct port 5432 (`DATABASE_URL_DIRECT`), separate pool. The fall-through `||` defeats that without warning.

### Sub-issue D — Pool `max=10` ceiling and Supabase tier limits

**Location:** `src/pg.js:38-48` (already shown).

**Current ceiling:** `PG_POOL_MAX=10` per process. With one Render instance running `SLA_MODE=primary`, the request pool draws 10 of the 15 transaction-mode pgbouncer slots. The remaining 5 are reserved for pg-boss direct connections (sub-issue C — assuming `DATABASE_URL_DIRECT` is set), Supabase internal heartbeats, and burst.

**Concurrent-payment math:**

| Scenario | Peak slots per payment | Pool max | Concurrent payments before saturation | Headroom for other request handlers when at saturation |
|---|---:|---:|---:|---|
| Today (sub-issue A unfixed) | 2 (1 held txn + 1 rotating module-pool query) | 10 | **5** | Zero |
| After A is fixed (txn client threaded) | 1 (held txn only) | 10 | **10** | Zero (other handlers must wait for a payment to commit) |
| After A is fixed AND `pool.max` raised to 12 (Supabase Pro tier with higher cap) | 1 | 12 | 12 | 0 |
| After A is fixed AND a separate read-only pool is added for dashboards (out of scope here) | 1 | 10 | 10 | All non-payment reads on the read pool |

The fix at A doubles realistic concurrent-payment capacity at the existing Supabase Free ceiling. Beyond ~10/sec, the bottleneck moves to the Supabase plan itself — see OQ-3.

**Other long-running connection holders identified in this scoping:**

| Site | What it holds, how long | Why it's a co-saturator |
|---|---|---|
| `server.js:1019-1101` `runSlaReminderJob` (two `withTransaction` blocks at `:1031` and `:1057`) | One client held across `for (var ri = 0; ri < reminderOrders.length; ri++)` and `for (var bi = 0; bi < breachOrders.length; bi++)` loops; each iteration calls `queueNotification(...)` and `logOrderEvent(...)` which are **module-pool**, plus an `await issueBreachRefundSafe(o.id)` which makes an outbound Paymob HTTP call (1–5 s each) **inside the held transaction** | Same anti-pattern as `markCasePaid`. With ~10 in-flight orders during a sweep, 1 held + 1 transient + sometimes a multi-second Paymob round-trip = 2 slots held for the whole sweep duration (often >1 s). Fires every 5 min in primary mode. |
| `case_lifecycle.js:457-504` `dispatchUnpaidCaseReminders` sweep mode (no caseId arg) | Top-level `await queryAll(SELECT *)` with no LIMIT, then `for (const r of rows) await dispatchUnpaidCaseReminders(r, …)`. Each per-row call does `UPDATE orders SET status='expired_unpaid'`, `UPDATE orders SET deleted_at`, `queueNotification(…)` — all module-pool. | 200-row sweeps at 4 pool ops each = 800 sequential checkouts during the sweep; each is short (<50 ms) but creates a steady drumbeat of pool churn that intersects with the request path and amplifies any concurrent `markCasePaid`. |
| `routes/exports.js` `/superadmin/exports/orders.csv` (PERF-P1 from audit) | `SELECT * FROM orders_active` with no LIMIT, materialised into a buffer, then streamed as CSV | A single export of N=10k orders holds one slot for several seconds. Anyone exporting during a payment burst directly cannibalises a payment's slot. |
| `routes/superadmin.js:914-960` LIKE-CTE over `order_events` (PERF-P1 from audit) | `WHERE event_payload LIKE '%request%'` with no `event_payload` index | Long-running query holds slot — exactly the case `statement_timeout` (sub-issue B) is meant to bound. |

These four are the known co-saturators. None of them are fixed in this Theme 5 scope — Theme 5 is the four sub-issues only — but they multiply the marginal cost of *not* fixing sub-issue A.

---

## 3. Root cause

Two related but distinct architectural drifts:

**Drift 1 (sub-issues A + D-list):** the codebase has two overlapping conventions for talking to Postgres — `pool.query(...)` via the module-level `queryOne` / `queryAll` / `execute` helpers, and `client.query(...)` inside `withTransaction(async (client) => …)`. A handler that opens a transaction is supposed to thread `client` through every helper it calls so the transaction is the unit of consistency. None of `transitionCase`, `getCase`, `updateCase`, `logCaseEvent`, `triggerNotification`, or `dispatchSlaReminders` were ever rewritten to accept and prefer a passed-in `client`. So every transaction in the codebase is half-pool and half-txn — **the helpers' work isn't even part of the transaction the caller thinks it's in.** That's a correctness concern in addition to the pool-saturation concern: the SELECT FOR UPDATE row-lock at `markCasePaid:1340` doesn't extend to the `transitionCase` UPDATE that follows, because that UPDATE runs on a different connection and is therefore in a different transaction.

(In practice the lock still protects against double-marking-paid because the `SELECT FOR UPDATE` on case X serializes any *second* `markCasePaid(X)` call. But the rest of the transaction's writes — `transitionCase`'s UPDATE, the notification cancellation, the case_events inserts — are independent auto-commits riding alongside. If the txn rolls back, those side effects do not.)

**Drift 2 (sub-issues B + C):** pool/connection-string configuration was last touched piecemeal — `connectionTimeoutMillis` was raised under contention pressure, `DATABASE_URL_DIRECT` was added with a fall-through to keep dev working — without ever being audited as one defensive set. The pool is missing `statement_timeout`, the env var that would isolate pg-boss from the request pool isn't documented or enforced, and there's no boot-time assertion that the runtime is in the configuration the architecture comment in `pg.js` claims it is.

Both drifts are quiet today because production has run zero paid orders since the SLA-sweep reorganisation. The first concurrent-payment spike on launch day surfaces both at once.

---

## 4. Fix plan

### Sub-issue A — Thread `client` through the `markCasePaid` helper chain

Rewrite the affected helpers to accept an optional `client`. When present, use it; when absent, fall through to the existing module-level `queryOne` / `queryAll` / `execute` (i.e. the pool). This keeps the existing 100-plus call sites that don't open a transaction working unchanged.

**Files to touch:**

1. `src/case_lifecycle.js` — modify `getCase`, `updateCase`, `logCaseEvent`, `triggerNotification`, `transitionCase`, `dispatchSlaReminders`, `closeOpenDoctorAssignments`. For each, accept an optional `client` and route queries through it when present. Then modify `markCasePaid` to thread `client` to every callee.

**Proposed pattern (illustrative):**

```diff
-async function getCase(caseIdOrParams) {
+async function getCase(caseIdOrParams, client) {
   const caseId = /* …same as today… */;
   if (!caseId) return null;
+  if (client) {
+    const r = await client.query(
+      `SELECT * FROM ${CASE_TABLE} WHERE id = $1 AND deleted_at IS NULL`,
+      [caseId]
+    );
+    return r.rows[0] || null;
+  }
   return await queryOne(`SELECT * FROM ${CASE_TABLE} WHERE id = $1 AND deleted_at IS NULL`, [caseId]);
 }
```

```diff
-async function updateCase(caseId, fields) {
+async function updateCase(caseId, fields, client) {
   /* …same column-list construction… */
-  await execute(`UPDATE ${CASE_TABLE} SET ${sets} WHERE id = $${values.length}`, values);
+  if (client) {
+    await client.query(`UPDATE ${CASE_TABLE} SET ${sets} WHERE id = $${values.length}`, values);
+  } else {
+    await execute(`UPDATE ${CASE_TABLE} SET ${sets} WHERE id = $${values.length}`, values);
+  }
 }
```

```diff
-async function logCaseEvent(caseId, eventType, payload = null) {
+async function logCaseEvent(caseId, eventType, payload = null, client) {
   try {
     const meta = payload ? JSON.stringify(payload) : null;
-    await execute(`INSERT INTO case_events (...) VALUES (...)`, [...]);
+    if (client) {
+      await client.query(`INSERT INTO case_events (...) VALUES (...)`, [...]);
+    } else {
+      await execute(`INSERT INTO case_events (...) VALUES (...)`, [...]);
+    }
   } catch (e) { /* optional table */ }
 }
```

```diff
-async function transitionCase(caseId, nextStatus, data = {}) {
+async function transitionCase(caseId, nextStatus, data = {}, client) {
   await ensureColumnCache();
-  const existing = await getCase(caseId);
+  const existing = await getCase(caseId, client);
   /* …assertions, deadline math… */
-    await closeOpenDoctorAssignments(caseId);
+    await closeOpenDoctorAssignments(caseId, client);
   }
   const updates = { status: desiredStatus, updated_at: now, ...data };
-  await updateCase(caseId, updates);
-  await logCaseEvent(caseId, `status:${updates.status}`, { from: currentStatus });
-  return await getCase(caseId);
+  await updateCase(caseId, updates, client);
+  await logCaseEvent(caseId, `status:${updates.status}`, { from: currentStatus }, client);
+  return await getCase(caseId, client);
 }
```

```diff
 async function markCasePaid(caseId) {
   await ensureColumnCache();
   return await withTransaction(async (client) => {
     const existing = /* …SELECT FOR UPDATE on client… */;
     /* …idempotency / urgent-window guards… */
-    await transitionCase(caseId, CASE_STATUS.PAID, {sla_hours, paid_at, deadline_at: null});
+    await transitionCase(caseId, CASE_STATUS.PAID, {sla_hours, paid_at, deadline_at: null}, client);
     try {
-      await execute(`UPDATE notifications SET cancelled_at = …`, [...]);
+      await client.query(`UPDATE notifications SET cancelled_at = …`, [...]);
     } catch (e) {}
-    await logCaseEvent(caseId, 'PAYMENT_CONFIRMED', {sla_hours, urgency_tier});
-    await logCaseEvent(caseId, 'CASE_READY_FOR_ASSIGNMENT');
-    await triggerNotification(caseId, 'payment_confirmation', {sla_hours, urgency_tier});
+    await logCaseEvent(caseId, 'PAYMENT_CONFIRMED', {sla_hours, urgency_tier}, client);
+    await logCaseEvent(caseId, 'CASE_READY_FOR_ASSIGNMENT', null, client);
+    await triggerNotification(caseId, 'payment_confirmation', {sla_hours, urgency_tier}, client);
-    try { await dispatchSlaReminders(caseId); } catch (e) {}
+    try { await dispatchSlaReminders(caseId, {}, client); } catch (e) {}
-    return await getCase(caseId);
+    return await getCase(caseId, client);
   });
 }
```

`dispatchSlaReminders` is the longest callee. It calls `getCase`, `updateCase`, `transitionCase`, plus a `queueSlaReminder` helper that itself does pool inserts. The same opt-in `client` pattern threads end-to-end. Most of `dispatchSlaReminders`'s execution skips on `markCasePaid`'s short-circuit anyway (case isn't `IN_REVIEW` yet), but threading the client keeps the txn semantics clean for the path that does fire.

**`queueNotification`/`logOrderEvent`/`triggerNotification` cousins outside `case_lifecycle.js`:** the runSlaReminderJob co-saturator (server.js:1019-1101) uses these. Threading `client` there is the exact same pattern and should be done as a follow-up, but it is **out of scope for Theme 5** per the brief — Theme 5 is the four named sub-issues only. Track as `P2-PERF-FOLLOW-UP` when filed.

**Risk:**

- `transitionCase` and `getCase` have ~80 call sites combined across the codebase; changing the signature to accept an optional final positional `client` is backwards-compatible (existing callers pass undefined → fall through to pool). Verified via grep that no caller relies on `arguments.length` or rest params.
- The optional-positional-arg pattern is the cheapest non-invasive option. An object-arg refactor (`{ client }`) would be cleaner but touches every call site and is high-risk pre-launch.
- The `dispatchSlaReminders` cascade calls `transitionCase` for un-breach scenarios. Threading client through means the un-breach UPDATE happens inside the original `markCasePaid` txn — that's a behavior change worth noting (today it's a separate auto-commit) but it's the *correct* behavior; the alternative is a partial commit on rollback.

**Estimated time:** 3 hours (mechanical, ~6 functions × careful diff + one module-pool helper rewrite + tests).

### Sub-issue B — Set `statement_timeout` on the request pool

Configure `statement_timeout` on every connection the pool hands out. The `pg` library's `Pool` constructor doesn't take this directly, but the `pool.on('connect', client => …)` hook does, and so does the connection string's `?options` query parameter.

**Recommended: hook approach** — keeps the env var as the single source of truth and survives the connection string being changed for other reasons (pgbouncer mode flips, pool key rotation).

`src/pg.js:42-52` proposed diff:

```diff
+var PG_STATEMENT_TIMEOUT_MS = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS, 10) || 30000;
+
 const pool = new Pool({
   connectionString: process.env.DATABASE_URL,
   ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
   max: PG_POOL_MAX,
   idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS,
   connectionTimeoutMillis: PG_POOL_CONNECT_TIMEOUT_MS
 });

+// Cap any single query at PG_STATEMENT_TIMEOUT_MS. Defends the pool from a
+// single runaway query holding a slot indefinitely. Configured per-connection
+// so future pool reconnects pick up the same setting.
+pool.on('connect', function (client) {
+  client.query('SET statement_timeout = ' + PG_STATEMENT_TIMEOUT_MS).catch(function (err) {
+    logMajor('Failed to SET statement_timeout on new pool client: ' + err.message);
+  });
+});
+
 pool.on('error', (err) => {
   logMajor('Unexpected PG pool error: ' + err.message);
 });
```

**Why 30000 ms (30 s):**

- The longest legitimate OLTP query in this codebase is the superadmin dashboard composite (`src/routes/superadmin.js:1240+` — multiple aggregates joined to specialties), measured at <2 s on a 1 k-order test fixture.
- The known PERF-P1 outliers (`order_events` `LIKE '%request%'` CTE, full-table CSV export) need indexes / streaming, not a longer timeout. A 30 s cap forces those to either be optimized or fall outside the request path.
- 30 s is below the 60 s wall most upstream proxies (Render edge, Cloudflare) cap at, so a query that times out at 30 s on Postgres surfaces a clean 500 to the client rather than the proxy disconnecting first with a 504.

**Risk:**

- The CSV export (`src/routes/exports.js`) and the superadmin LIKE-CTE will start 500'ing under load. Both are P1-known-slow in the audit; this fix surfaces them rather than masking them. Mitigation: scope a follow-up to add the index / move the CSV export to streaming; for the immediate launch, both are admin-only paths (low blast radius).
- `pg-boss`'s connection (sub-issue C) is a *separate* pool and is not affected by this change.
- Setting `statement_timeout` after the connection is checked out (per-connect hook) means the very first query on a new connection runs without the cap. Tradeoff is small: it's bounded by `connectionTimeoutMillis=15000`, so worst case the *first* query gets 15 s, every subsequent query gets 30 s. To eliminate even that, we could put `?options=-c%20statement_timeout%3D30000` on the connection string — but that pins the timeout in the URL, which is what we'd be moving away from in OQ-2.

**Estimated time:** 30 minutes (small diff, plus a regression test).

### Sub-issue C — Hard-fail at boot if `DATABASE_URL_DIRECT` is missing in production/staging

Three coupled changes:

**Change C1 — `src/job_queue.js:13-18`** — fail loud when the var is missing in non-dev:

```diff
 async function startJobQueue() {
-var connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
-  if (!connectionString) {
-    logMajor('[job-queue] DATABASE_URL not set — skipping pg-boss');
-    return;
-  }
+  var directUrl = process.env.DATABASE_URL_DIRECT;
+  var fallbackUrl = process.env.DATABASE_URL;
+  var mode = String(process.env.MODE || '').trim();
+  var nodeEnv = String(process.env.NODE_ENV || '').trim();
+  var isProd = mode === 'production' || mode === 'staging' ||
+               nodeEnv === 'production' || nodeEnv === 'staging';
+
+  if (isProd && !directUrl) {
+    // pg-boss requires session-mode (LISTEN/NOTIFY, advisory locks).
+    // DATABASE_URL on Render → Supabase is the pgbouncer transaction-mode
+    // pooler; running pg-boss against it silently breaks cross-instance
+    // singletons and steals slots from the request pool.
+    var msg = '[job-queue] DATABASE_URL_DIRECT must be set in ' + (mode || nodeEnv) +
+              ' (pg-boss requires direct port-5432 connections, not pgbouncer)';
+    logFatal(msg);
+    throw new Error(msg);
+  }
+
+  var connectionString = directUrl || fallbackUrl;
+  if (!connectionString) {
+    logMajor('[job-queue] DATABASE_URL not set — skipping pg-boss');
+    return;
+  }
+  if (!directUrl) {
+    logMajor('[job-queue] DATABASE_URL_DIRECT not set — falling back to DATABASE_URL ' +
+             '(dev only). Cross-instance singletons + LISTEN/NOTIFY may misbehave.');
+  }
```

**Change C2 — `bootCheck.js`** — surface the missing env at boot rather than at first job dispatch (which can be 5+ minutes after `app.listen`):

Pattern matches the existing `JWT_SECRET` / `DATABASE_URL` / `ANTHROPIC_API_KEY` validation in `server.js:51-68`. Add `DATABASE_URL_DIRECT` to the conditional block guarded on production/staging.

**Change C3 — `.env.example`** — document the var:

```diff
+# pg-boss requires a direct (port 5432) Postgres connection because
+# LISTEN/NOTIFY and advisory locks don't work over pgbouncer
+# transaction-mode pooling. On Render+Supabase, copy the "Session
+# pooler" connection string from the Supabase dashboard
+# (Project Settings → Database → Session) into this var. REQUIRED
+# when MODE is production or staging.
+DATABASE_URL_DIRECT=
+
 # ── Database (PostgreSQL) ───────────────────────────────────────────
 DATABASE_URL=postgresql://user:password@localhost:5432/tashkheesa
 PG_SSL=false                            # Set to true on Render/production
```

**Risk:**

- If `DATABASE_URL_DIRECT` is currently unset on Render production, the next deploy with this change **will fail to boot** until it's set. This is by design — fail-loud is the entire point — but the deploy needs to happen with the env var ready. See OQ-1 for the runbook.
- A fresh dev clone without `DATABASE_URL_DIRECT` continues to work via the fallback (with a single warning log line).

**Estimated time:** 1 hour (small per-file change + one runbook step + a regression test).

### Sub-issue D — Document the math; no code change

The pool ceiling itself is correct for Supabase Free + single Render instance. The limiting factor is **the per-payment slot pattern**, not the ceiling. After A is fixed, the `max=10` ceiling supports 10 concurrent payments — which is well above the launch-day projected peak. No change to `PG_POOL_MAX` is recommended in this PR.

What is recommended for D is:

- **Add a runtime-observable assertion** that the pool config matches the architectural intent. Specifically: at boot, log `[pool] configured: max=N idle=Mms connect=Pms statement=Qms` so operations can verify what's actually loaded. The existing logger at `src/pg.js:50` only fires on errors.
- **Add a boot-time warning if `PG_POOL_MAX × instance_count > 14`**, which catches the "second Render instance accidentally enabled" foot-gun. We don't know the instance count at boot from inside the process, so this is a `logMajor` reminder rather than an assertion.

**Proposed diff to `src/pg.js`:**

```diff
+logMajor(
+  '[pool] configured: max=' + PG_POOL_MAX +
+  ' idle=' + PG_POOL_IDLE_TIMEOUT_MS + 'ms' +
+  ' connect=' + PG_POOL_CONNECT_TIMEOUT_MS + 'ms' +
+  ' statement=' + PG_STATEMENT_TIMEOUT_MS + 'ms'
+);
+if (PG_POOL_MAX > 12) {
+  logMajor('[pool] WARNING: max=' + PG_POOL_MAX +
+           ' is close to Supabase Free 15-slot ceiling. Reduce if running >1 Render instance.');
+}
```

**Risk:** none — pure observability.

**Estimated time:** 15 min.

---

## 5. Verification steps

> Run only after the fix is deployed to staging. Local equivalents in §6 run pre-deploy.

### Sub-issue A — concurrent-payment load test

The marquee proof. Drive 10 simultaneous Paymob webhooks at staging and observe slot-use stays linear in (concurrent payments) instead of (concurrent payments × 2).

**Setup (one-time on staging):**

1. Create 10 unpaid `orders` rows pointing at the staging seed-doctor / seed-service. Capture their UUIDs.
2. For each order, generate a valid Paymob HMAC for an "approved" callback payload. The HMAC helper at `src/services/paymob-hmac.js` is already in tests/core/paymob-hmac.test.js; reuse to forge the signed bodies.

**Test run:**

```bash
# Fire 10 webhooks in parallel, wait for all to return.
for ID in $TEN_ORDER_IDS; do
  ( curl -s -X POST "$STAGING/payments/callback" \
       -H 'Content-Type: application/json' \
       -d "$(./scripts/forge-paymob-callback.sh "$ID")" \
       -o /tmp/paymob-$ID.out -w "%{http_code} %{time_total}s\n" ) &
done
wait
```

**Pre-fix expectations (today, sub-issue A unfixed):**

- First 5 callbacks: 200, ~150 ms each.
- Callbacks 6-10: queue on pool acquire. Some return 200 after a 1-3 s delay; some 500 with a `connect timeout` after 15 s.
- During the run, every other request handler (e.g. `/healthz`, `/dashboard`) sees 200-2000 ms latency or transient 500.
- Render logs: pool stats reach `total: 10, idle: 0, waiting: 5+` mid-run.

**Post-fix expectations (Theme 5 deployed):**

- All 10 callbacks: 200, ~100 ms each (parallel-bounded by pool max=10, but each holds only 1 slot).
- Other handlers: no observable latency impact.
- Render logs: pool stats reach `total: 10, idle: 0, waiting: 0` peak.

**Pool stats endpoint:** the existing `/healthz` returns `pool: {total, idle, waiting}`. Sample it once per second during the test:

```bash
while true; do
  date +%H:%M:%S.%3N
  curl -s "$STAGING/healthz" | grep -oE '"pool":\{[^}]+\}'
  sleep 1
done | tee /tmp/pool-trace.log
```

**DB-side spot check (run on staging psql):**

```sql
-- Confirm all 10 orders ended up in the canonical paid lifecycle
SELECT id, status, payment_status, paid_at, sla_hours, deadline_at
  FROM orders WHERE id IN ($TEN_ORDER_IDS);
-- Expect: status = 'paid', payment_status = 'paid', paid_at = <within last min>,
-- sla_hours set, deadline_at NULL (set at acceptance)

-- Confirm exactly one PAYMENT_CONFIRMED event per order (idempotency)
SELECT case_id, COUNT(*) FROM case_events
  WHERE event_type = 'PAYMENT_CONFIRMED' AND case_id IN ($TEN_ORDER_IDS)
  GROUP BY case_id HAVING COUNT(*) > 1;
-- Expect: zero rows.
```

### Sub-issue B — `statement_timeout` enforcement

Run a deliberately slow query through a request handler and confirm Postgres kills it at 30 s.

```bash
# Pick a route that runs an arbitrary read. The /superadmin LIKE-CTE is
# convenient and known-slow under load.
curl -i --max-time 60 "$STAGING/superadmin/events?q=request" \
     -b "ops_auth=<staging-ops-cookie>"
# expect: 500 within ~30s (statement timeout) rather than 60s+ proxy timeout.
```

Render logs should show:
```
[pg pool error] canceling statement due to statement timeout
```

DB-side: `SELECT * FROM pg_stat_activity WHERE state = 'active' AND query_start < NOW() - INTERVAL '30 seconds'` should return zero rows during the test.

### Sub-issue C — `pg-boss` direct-connection enforcement

```bash
# Step 1: confirm the deployed instance saw DATABASE_URL_DIRECT at boot.
# The Render runtime log should show `[job-queue] pg-boss started` WITHOUT
# the new "[job-queue] DATABASE_URL_DIRECT not set — falling back" warning.
ssh-or-render-log | grep -E "\\[job-queue\\]"
# expect: "pg-boss started" alone, no warning.

# Step 2: confirm pg-boss is using a session-mode connection (port 5432,
# not 6543). On Render, capture pg_stat_activity from a psql session:
SELECT pid, application_name, client_port, state
  FROM pg_stat_activity
 WHERE application_name LIKE '%pg-boss%' OR application_name LIKE '%pgboss%';
# expect: client_port should reflect a connection to the direct host
# (5432-side), not the pooler.

# Step 3: cross-instance singleton — start a second Render instance briefly
# (or rely on prod already being multi-instance) and trigger:
SELECT * FROM pgboss.schedule WHERE name = 'sla-sweep';
# Then watch the logs: only ONE instance should run the sweep at the
# scheduled minute, not both.
```

If staging is single-instance only, the multi-instance singleton check is moved to the production verification step.

### Sub-issue D — pool config visibility

```bash
# Boot log should now include the [pool] configured line.
ssh-or-render-log | grep -E "\\[pool\\] configured"
# expect: "[pool] configured: max=10 idle=30000ms connect=15000ms statement=30000ms"

# Sample /healthz once steady-state to confirm pool peer is happy.
curl -s "$STAGING/healthz" | jq .pool
# expect: {"total":N,"idle":M,"waiting":0} with M close to 10 under no load.
```

---

## 6. What to add to the test suite

Test runner: `tests/run.js` (zero-deps, function-style assertions; same as Themes 1 + 3).

### A — `tests/core/theme5-marknostalking-paid-uses-single-client.test.js`

DB integration. Insert one paid-eligible order; instrument the pool to count fresh checkouts during a `markCasePaid` call; assert count is **exactly 1** (the txn client) — i.e. no module-level helper bypassed the threading.

Mechanism: monkey-patch `pool.connect` to bump a counter, run `markCasePaid(testId)`, restore patch, assert count.

```js
// Pseudo-shape (full file lives in tests/core/):
const { pool } = require('../../src/pg');
const { markCasePaid } = require('../../src/case_lifecycle');

const original = pool.connect.bind(pool);
let connects = 0;
pool.connect = async function () { connects += 1; return original(); };

await markCasePaid(testCaseId);

assert.strictEqual(connects, 1,
  'markCasePaid acquired ' + connects + ' pool clients; expected exactly 1 (the txn client)');
```

### B — `tests/core/theme5-statement-timeout.test.js`

DB integration. Run `SELECT pg_sleep(35)` against the request pool; assert it raises `statement timeout` within ~30-31 s, not 35 s.

```js
const { pool } = require('../../src/pg');
const start = Date.now();
let err = null;
try { await pool.query("SELECT pg_sleep(35)"); }
catch (e) { err = e; }
const elapsed = Date.now() - start;
assert.ok(err, 'expected pg_sleep(35) to throw under statement_timeout=30000');
assert.ok(/statement timeout|canceling statement/i.test(err.message),
  'expected timeout error, got: ' + err.message);
assert.ok(elapsed < 33000, 'timeout fired too late (' + elapsed + 'ms)');
```

### C — `tests/core/theme5-pg-boss-direct-required.test.js`

Source-level lint + smoke. Two assertions:

1. `src/job_queue.js` contains the new fail-fast block (regex-grep for `DATABASE_URL_DIRECT must be set`).
2. `.env.example` documents `DATABASE_URL_DIRECT` (regex-grep for the var name in the env example).

Optionally a heavier integration: spawn the server with `MODE=production` and `DATABASE_URL_DIRECT` deliberately unset, assert it exits non-zero with the expected fatal message in stderr. Pattern matches `tests/core/no-mobile-api-boot-script.test.js` from Theme 1.

### D — `tests/core/theme5-pool-config-logged.test.js`

Source-level. Assert the new `logMajor('[pool] configured: …')` line is present in `src/pg.js`. Optional integration: boot the server, capture the first 100 log lines, assert the pool-configured line is among them.

### Cross-cutting regression — `tests/core/theme5-no-pool-leak-during-payment.test.js`

Drive `markCasePaid` once, then read `pool.totalCount` and `pool.idleCount`. After the call returns, `idleCount` should equal whatever it was before the call (no leaked clients). Catches regressions in `withTransaction` finally-release.

---

## 7. Rollback plan

Each sub-issue is independently revertable.

| Sub-issue | Files touched | Rollback method | Side effects of rollback |
|---|---|---|---|
| A | `src/case_lifecycle.js` (~6 helper signatures + `markCasePaid` body) | `git revert <sha>` | Returns to today's behavior: peak 2 slots/payment, ~5-payment saturation. No DB impact. |
| B | `src/pg.js` (1 `pool.on('connect', …)` block + 1 env-parse line) | `git revert <sha>` | Pool returns to no-statement-timeout. Slow queries can hold slots indefinitely again. No DB impact. |
| C | `src/job_queue.js`, `src/bootCheck.js`, `.env.example` | `git revert <sha>` | Reverts to the silent fallback. **Caveat:** if `DATABASE_URL_DIRECT` was newly set on Render in advance of the deploy, leave it set; reverting the code keeps the var harmlessly unused. |
| D | `src/pg.js` (1 `logMajor` block) | `git revert <sha>` | Loses the boot-time pool-config visibility log. Zero functional impact. |

**Cross-cutting:** none of the four sub-issues alter schema, migrations, or stored data. Rollback is purely code+env-level.

**Fast-rollback drill** (if a launch-day disaster happens):

1. **Symptom:** post-deploy `markCasePaid` throws something we didn't anticipate (e.g. a helper signature mismatch from a missed call site).
2. **Action:** `git revert <theme-5-commit>` → push to `main`. Render redeploys. Pool returns to today's pattern. Triage offline.

---

## 8. Open questions for Ziad

### OQ-1: Is `DATABASE_URL_DIRECT` currently set on Render production and staging?

I cannot inspect Render env from this scoping. The fix at sub-issue C will **fail-fast at boot** in production/staging if the var is missing. Three sequencings:

- **A — Set env first, then ship code.** Set `DATABASE_URL_DIRECT` on Render staging + production *before* this PR is merged. The deploy proceeds normally; the fail-fast block is dormant insurance.
- **B — Ship code first, then set env.** Production boot fails until the env is set. Brief outage.
- **C — Defer C entirely from this PR.** Ship A+B+D only; track C as a follow-up after Ziad confirms the env state.

**My recommendation: A.** It's a 30-second Render dashboard change with zero downtime, done before the PR merges. Procedure: Supabase dashboard → Project Settings → Database → "Session pooler" connection string → copy → Render → Environment → add as `DATABASE_URL_DIRECT` → save (Render auto-redeploys with the unchanged code). Then merge the Theme 5 PR.

### OQ-2: `statement_timeout` value — 30 s is the recommended default. Comfortable, or different?

Options and tradeoffs:

- **A — 30 s (recommended).** Above all known legitimate OLTP queries; below upstream proxy walls; surfaces PERF-P1 outliers cleanly.
- **B — 60 s.** Matches the Render edge wall. Lower regression risk for the CSV export and the LIKE-CTE; higher pool-saturation risk (a runaway query holds for an extra 30 s).
- **C — 15 s.** Aggressive — tightens the bound but might flake on a slow Supabase pgbouncer hand-off under load.
- **D — Tunable via `PG_STATEMENT_TIMEOUT_MS` env (always exposed)**, default 30 s. (This is what my proposed diff already does — the env var is the override.)

**My recommendation: A with the env-var escape hatch (D).** If we hit an edge case, we can ratchet without a redeploy.

### OQ-3: Should we raise `PG_POOL_MAX` above 10 now, or leave it at 10 and revisit if traffic warrants?

After sub-issue A is fixed, a single Render instance at `max=10` supports 10 concurrent payments. Pre-launch volume projections (clarify if you have a number) likely don't exceed that. But the Supabase Free 15-slot cap means we're 5 slots away from the ceiling.

- **A — Leave at 10.** Simple. Headroom for pg-boss + Supabase internal heartbeats. Revisit only if `/healthz` shows `waiting > 0` with any frequency.
- **B — Raise to 12 now.** Tighter on Supabase Free (would need to drop to 10 again if a second Render instance starts, which the audit's `WORKER-P0` notification-worker fix may eventually require). Slightly more burst headroom.
- **C — Move to Supabase Pro and raise to 20.** Real fix; out of scope for Theme 5 budget but worth noting.

**My recommendation: A.** Theme 5 is the pattern fix, not the ceiling. Re-tune in a follow-up after we see real launch-week traffic.

### OQ-4: Co-saturator helpers (`runSlaReminderJob`, `dispatchUnpaidCaseReminders`, etc.) — fold the same threading fix into Theme 5, or a separate follow-up PR?

The same antipattern exists at four other sites (§2 sub-issue D). The brief explicitly scopes Theme 5 to the four named sub-issues. But A's fix introduces a new convention (helpers accept optional `client`); leaving the co-saturators on the old convention is debt that compounds.

- **A — Fold them into Theme 5.** Larger PR (~12 files, ~1.5 days) but the convention lands in one place.
- **B — File `P2-PERF-FOLLOW-UP` and address in a Theme 6.** Smaller Theme 5 PR; convention drift for ~1 sprint.
- **C — Hybrid: fold in `runSlaReminderJob` (server.js — directly co-saturates with payments since it touches the same orders rows under load), defer the others.**

**My recommendation: B.** Theme 5 lands narrow and reviewable. The co-saturators are P2-not-P0 (they don't directly conflict with the payment path the way `markCasePaid` does — they hit different orders), and their mitigation will be the same fix replicated mechanically.

### OQ-5: For the load-test in §5, is there a non-production staging environment we can hammer with 10 concurrent Paymob webhooks, or do we need to rehearse against prod?

Theme 5's value is mostly proven by the per-payment slot-count test (single client, no fresh checkouts), which runs locally. The 10-concurrent-webhook drill is the **end-to-end load proof**, and it requires a running server with the pgbouncer + pool + pg-boss path live. Options:

- **A — Run against production at low traffic.** Use 10 disposable test orders and watch `/healthz` pool stats. Risk: production logs noise.
- **B — Run against staging IF staging exists at parity.** Cleaner, but staging may diverge in pool size or instance count.
- **C — Skip the live drill; rely on the local single-client test (§6 A) + production observability after deploy.** Cheapest; closest to what we did for Themes 1 + 3.

**My recommendation: C** for the immediate launch, with **A** as an optional dress rehearsal if Ziad has a 10-minute window.

---

## Out-of-scope notes

- **No source file was modified.** All diffs in §4 are illustrative.
- **No load test was run, no migration was executed.**
- **Two unrelated findings surfaced during this scoping but are NOT new — already in the audit:**
  - `runSlaReminderJob` makes outbound HTTP calls (`issueBreachRefundSafe`) inside `withTransaction`. Already audit `WORKER-P0`.
  - `routes/exports.js` and `routes/superadmin.js` LIKE-CTE are co-saturators. Already audit `PERF-P1`.

  No new `P3-POOL-N` entries were added to the audit doc.
- **No critical race surfaced.** The `SELECT FOR UPDATE` at `case_lifecycle.js:1340` correctly serializes any second `markCasePaid(X)` for the same case-id. Pool saturation degrades latency/throughput; it does not introduce a double-pay path. (No top-of-report ALERT block needed.)

For full audit context: `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` § PERF-P0-1, PERF-P0-2, PERF-P0-3.
