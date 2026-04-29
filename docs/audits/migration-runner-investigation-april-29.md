# Migration runner investigation — April 29, 2026 (evening)

**Trigger:** prod schema_migrations claims latest tracked migration is `012_website_intake_columns.sql` (ran 2026-04-16), but 13 newer files exist on disk and at least one expected post-012 table (`blocked_send_attempts`) is absent on prod even though tonight's deploy is on `20ae262` and is healthy.

**Scope:** read-only. No code, migration, or DB state was modified. The audit doc is the only file written.

**Working tree:** HEAD `20ae262` (tonight's audit-closure commit). 32 .sql files in `src/migrations/`.

---

## A. Migration files inventory

Sorted by filename (the order the runner uses).

| Filename | Bytes | First non-blank SQL statement | Primary affected object |
|---|---|---|---|
| `001_initial_tables.sql` | 5,628 | `CREATE TABLE IF NOT EXISTS …` (initial schema) | core tables (users, orders, services, etc.) |
| `002_column_additions.sql` | 22,496 | `DO $$ BEGIN IF NOT EXISTS … ALTER TABLE …` | column adds across many tables |
| `003_indexes.sql` | 7,258 | `CREATE INDEX IF NOT EXISTS …` | indexes |
| `004_video_consultation.sql` | 2,259 | `CREATE TABLE IF NOT EXISTS …` | `video_calls`, related |
| `005_messaging.sql` | 983 | `CREATE TABLE IF NOT EXISTS …` | `conversations`, `messages` |
| `006_referrals.sql` | 3,627 | `CREATE TABLE IF NOT EXISTS referral_codes …` | `referral_codes`, `referral_redemptions` |
| `007_case_intelligence.sql` | 3,813 | `DO $$ BEGIN IF NOT EXISTS … ALTER TABLE case_files ADD COLUMN file_size_bytes …` | adds **columns** to `case_files`. **Does NOT create a `case_intelligence` table** despite the filename. |
| `008_auto_assign_setting.sql` | 197 | `INSERT INTO admin_settings …` | admin_settings row |
| `009_intelligence_status_to_orders.sql` | 781 | `ALTER TABLE orders ADD COLUMN IF NOT EXISTS …` | adds intelligence_status to orders |
| `010_broadcast_system.sql` | 1,804 | `CREATE TABLE IF NOT EXISTS …` | broadcast tables |
| `011_services_unique_name.sql` | 1,117 | `ALTER TABLE services ADD CONSTRAINT …` | UNIQUE (specialty_id, name) on services |
| `012_website_intake_columns.sql` | 490 | `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` | website intake columns |
| `013_app_waitlist.sql` | 1,432 | `DO $$ BEGIN CREATE TABLE IF NOT EXISTS app_waitlist …` | `app_waitlist`, `app_analytics_events` |
| `014_doctor_assignments_accept_by_at.sql` | 189 | `ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS accept_by_at …` | `doctor_assignments.accept_by_at` |
| `015_otp_codes_table.sql` | 315 | `CREATE TABLE IF NOT EXISTS otp_codes …` | `otp_codes` (also created by `migrate_mobile_api.js` — see §D) |
| `016_urgency_tier.sql` | 676 | `DO $$ BEGIN IF NOT EXISTS … ALTER TABLE orders ADD COLUMN urgency_tier …` | `orders.urgency_tier` + backfill |
| `017_doctor_profile_fields.sql` | 3,833 | `DO $$ BEGIN IF NOT EXISTS … ALTER TABLE users ADD COLUMN name_ar …` | 12 new columns on `users` |
| `018_dedupe_specialties.sql` | 4,580 | `BEGIN; DELETE FROM services s WHERE …` | mass DELETE/UPDATE on `specialties`, `services`, `orders`, `appointments`; adds UNIQUE(name) |
| `019_addon_services.sql` | 7,148 | `BEGIN; CREATE TABLE IF NOT EXISTS addon_services …` | `addon_services`, `order_addons`, `addon_earnings` |
| `019b_remove_sla_addon.sql` | 1,587 | `BEGIN; DO $$ DECLARE offending INTEGER; BEGIN …` | DELETE from addon_services where id='sla_24hr' |
| `020_orders_paid_at.sql` | 1,131 | `BEGIN; ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ; …` | `orders.paid_at` + backfill |
| `021_orders_draft_step.sql` | 1,804 | `ALTER TABLE orders ADD COLUMN IF NOT EXISTS draft_step …` | `orders.draft_step` + backfill |
| `022_orders_soft_delete.sql` | 387 | `ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; …` | `orders.deleted_at` + index |
| `023_users_signature_url.sql` | 518 | `ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_url TEXT;` | `users.signature_url` |
| `024_blocked_send_attempts.sql` | 890 | `CREATE TABLE IF NOT EXISTS blocked_send_attempts …` | `blocked_send_attempts` (introduced by tonight's commit `35ca6d8`) |
| `025_email_campaigns_approval.sql` | 1,907 | `DO $$ BEGIN IF NOT EXISTS … ALTER TABLE email_campaigns ADD COLUMN approved_by TEXT NULL; …` | `email_campaigns.approved_by`, `email_campaigns.approved_at`, partial index. Introduced tonight (commit `9275d03`). User reports they ran this manually via Neon SQL editor earlier today. |
| `025_prescribed_medications_log.sql` | 2,587 | `CREATE TABLE IF NOT EXISTS prescribed_medications_log …` | `prescribed_medications_log`. **Filename collides with the email-campaigns 025** — see §B caveats. |
| `026_addon_commission_fix.sql` | 2,061 | `ALTER TABLE services ALTER COLUMN video_doctor_commission_pct SET DEFAULT 85; UPDATE services SET …` | services + addon_services commission_pct values |
| `027_services_urgency_multipliers.sql` | 1,420 | `ALTER TABLE services ADD COLUMN IF NOT EXISTS vip_multiplier …` | `services.vip_multiplier`, `services.urgent_multiplier`, `services.urgency_uplift_doctor_pct` |
| `028_refunds_table.sql` | 1,725 | `CREATE TABLE IF NOT EXISTS refunds …` | `refunds` |
| `030_orders_urgency_uplift_amount.sql` | 888 | `ALTER TABLE orders ADD COLUMN IF NOT EXISTS urgency_uplift_amount …` | `orders.urgency_uplift_amount`. **Note: there is no `029_*.sql` file.** Numbering gap. |
| `031_canonicalize_urgency_tier_vip.sql` | 643 | `UPDATE orders SET urgency_tier = 'vip' WHERE urgency_tier = 'fast_track';` | data fix on `orders.urgency_tier` |

**Filename anomalies:**
- **Two files at `025_*`** — `025_email_campaigns_approval.sql` and `025_prescribed_medications_log.sql`. JS sort order resolves this deterministically (alphabetical: `e` < `p`), so email_campaigns runs first. Both files have unique names so `schema_migrations.filename UNIQUE` doesn't collide.
- **No `029_*.sql`.** Numbering jumps from `028` to `030`. Cosmetic only — the runner doesn't enforce contiguous numbering.
- **`019b_*.sql`** — single-character suffix between `019` and `020`. Sort places it correctly (`b` > `_`).

---

## B. How the migration runner works

**Source:** `src/db.js` lines 14-46 (the `migrate()` function), invoked from `src/server.js:443-453`.

```js
async function migrate() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id SERIAL PRIMARY KEY, ' +
    'filename TEXT UNIQUE NOT NULL, ran_at TIMESTAMP DEFAULT NOW())'
  );
  var files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(function(f) { return f.endsWith('.sql'); })
    .sort();
  for (var i = 0; i < files.length; i++) {
    var filename = files[i];
    var existing = await queryOne(
      'SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]
    );
    if (existing) continue;
    var sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    await pool.query(sql);
    await execute(
      'INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]
    );
    logMajor('Migration: ' + filename);
  }
  await runDataFixups();
  await seedPricingData();
}
```

### File selection

- `fs.readdirSync(MIGRATIONS_DIR).filter(f.endsWith('.sql')).sort()`. JavaScript default `.sort()` is Unicode-codepoint comparison, equivalent to ASCII order for our filenames. Order is deterministic.

### Skip vs run

- For each file, run `SELECT 1 FROM schema_migrations WHERE filename = $1`.
- If it returns a row, `continue` (skip). The filename, not a hash, is the key.

### Execute order

- **Read SQL → `pool.query(sql)` → `INSERT INTO schema_migrations`.** Tracking row goes in **AFTER** successful execution.

### Transaction wrapping

- **There is NO transaction wrapping the SQL execution and the INSERT.** They are two separate `pool.query` calls. If the SQL succeeds but the INSERT fails (network blip), the migration is applied but not tracked. On the next boot the runner would try to run it again. The migrations are mostly idempotent (`IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_*`), so re-application is usually safe.
- **Inside individual files:** some migrations (`018`, `019`, `019b`, `020`) wrap their own bodies in `BEGIN; ... COMMIT;`. The pg client's `pool.query(sql)` runs all statements in the string sequentially in a single round-trip; the BEGIN/COMMIT inside the file is the only transaction boundary for that migration.

### Error handling

- **No try/catch inside `migrate()`.** Any throw from `pool.query(sql)` or `execute(INSERT)` propagates up.
- **`server.js:443-451` does the catch:** if `migrate()` rejects, `logFatal(...)` runs and `process.exit(1)` kills the process.
- **No silent swallowing.** Errors in `migrate()` itself are not caught locally.
- However, `migrateForMobileApi(pool)` at server.js:453-457 has its own try/catch that **does** swallow errors with a `console.error` only — that one fails silently if it errors.

### Halt behavior on mid-loop error

- If file N throws, the loop halts at that index. Files N+1 through end never run on that boot. Files 0 through N-1 that completed are tracked.
- `process.exit(1)` then kills the process. Render restarts; new boot starts at file 0 again, skips already-tracked, hits the same broken file, halts again — a deterministic crash-loop unless the underlying cause changes.

### Logging

- On success: `logMajor('Migration: ' + filename)` per file. After the loop: `logMajor('Database migration complete')` at server.js:446.
- On failure: `logFatal('DB migrate failed — refusing to start', err)`.
- Both go to stdout. `logFatal` ALSO writes to `error_logs` table per the logger module — so prod failures are persisted in DB if the DB connection is alive.

### Listener gating

- `src/server.js:443` defines `_dbReady = (async function initDatabase() { ... })()` (an IIFE returning a promise).
- `src/server.js:867` chains `_dbReady.then(...)` — and the **HTTP listener at `app.listen(PORT, ...)` lives at line 976, INSIDE that `.then()` block**.
- Therefore: the server only accepts requests after `migrate()` (and `migrateForMobileApi`, and the rest of the IIFE body) resolve. **`/healthz` returning 200 is sufficient evidence that `migrate()` completed without throwing on the boot that produced the response.**

---

## C. Per-file prediction if the runner re-runs each migration on prod **right now**

Predicate: ran fresh against prod's current state (post-tonight's deploy, latest tracked claimed = `012`, plus user's manual application of `025_email_campaigns_approval.sql`).

| File | Predicted outcome on prod | Rationale |
|---|---|---|
| 013_app_waitlist | **succeed** | Both CREATE TABLEs guarded by `EXCEPTION WHEN duplicate_table THEN NULL`. UNIQUE constraint guarded by `EXCEPTION WHEN duplicate_object`. Idempotent. |
| 014_doctor_assignments_accept_by_at | **succeed** | `ADD COLUMN IF NOT EXISTS`. `doctor_assignments` table existed since 001 — column add is no-op if already there. |
| 015_otp_codes_table | **succeed** | `CREATE TABLE IF NOT EXISTS`. `otp_codes` is also created by `migrate_mobile_api.js` (line 61), so the table likely exists. No-op safe. |
| 016_urgency_tier | **succeed** | `IF NOT EXISTS` column add + a backfill UPDATE that's WHERE-gated to `urgency_tier = 'standard' OR urgency_tier IS NULL`. Re-runnable. |
| 017_doctor_profile_fields | **succeed** | 12 column adds, all wrapped in `IF NOT EXISTS … ALTER TABLE users ADD COLUMN …`. Pure idempotent. |
| 018_dedupe_specialties | **likely succeed, possibly no-op** | Multi-step `BEGIN/COMMIT`. DELETE/UPDATE statements are WHERE-gated. UNIQUE constraint add wrapped in `IF NOT EXISTS … pg_constraint`. The mass UPDATEs of `orders.specialty_id`, `appointments.specialty_id`, `services.specialty_id` will be no-ops if the rows have already been canonicalized. **Risk:** if the prod data is in a transitional state (some `cardiology` rows, some `spec-cardiology`), the DELETE step could fail on a UNIQUE collision. Worth running a dry-run SELECT first. |
| 019_addon_services | **succeed** | All `CREATE TABLE IF NOT EXISTS` + INSERT … ON CONFLICT. Idempotent. |
| 019b_remove_sla_addon | **succeed unless prod has an order_addons row referencing 'sla_24hr'** | The migration begins by raising an exception if any `order_addons.addon_service_id = 'sla_24hr'` row exists. Per the file's own comment: "would block the operator and force them to clean those rows before proceeding." If prod has such rows, this would throw and halt the loop. |
| 020_orders_paid_at | **succeed** | `ADD COLUMN IF NOT EXISTS paid_at` + backfill UPDATE WHERE-gated to `payment_status='paid' AND paid_at IS NULL`. |
| 021_orders_draft_step | **succeed** | `ADD COLUMN IF NOT EXISTS` + backfill `WHERE draft_step = 0`. |
| 022_orders_soft_delete | **succeed** | `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`. |
| 023_users_signature_url | **succeed** | `ADD COLUMN IF NOT EXISTS`. |
| 024_blocked_send_attempts | **succeed (creates table, populates schema_migrations row)** | `CREATE TABLE IF NOT EXISTS` + 2 indexes `IF NOT EXISTS`. This is the table the user reports as missing. |
| 025_email_campaigns_approval | **succeed (no-op)** — user already applied it manually | All ALTER TABLE wrapped in `IF NOT EXISTS` checks; partial index `IF NOT EXISTS`. Will simply mark itself in schema_migrations on the next clean run. |
| 025_prescribed_medications_log | **succeed unless `prescriptions` table is missing** | `CREATE TABLE … REFERENCES prescriptions(id)` — requires `prescriptions` to exist. Prescriptions table is from 001/002; should exist. |
| 026_addon_commission_fix | **succeed** | UPDATE WHERE-gated; ALTER COLUMN SET DEFAULT idempotent. |
| 027_services_urgency_multipliers | **succeed** | `ADD COLUMN IF NOT EXISTS` × 3. |
| 028_refunds_table | **succeed** | `CREATE TABLE IF NOT EXISTS refunds`. |
| 030_orders_urgency_uplift_amount | **succeed** | `ADD COLUMN IF NOT EXISTS`. |
| 031_canonicalize_urgency_tier_vip | **succeed (data update)** | Simple `UPDATE orders SET urgency_tier='vip' WHERE urgency_tier='fast_track'`. |

**Highest-risk file: `019b_remove_sla_addon.sql`.** If any production `order_addons` row references `sla_24hr`, the DO block raises a deliberate exception. **Worth running first as a probe SELECT against Neon to determine if this is the file that's been blocking the loop:**
```sql
SELECT COUNT(*) FROM order_addons WHERE addon_service_id = 'sla_24hr';
-- expected: 0; if > 0, 019b will halt migrate() until those rows are reconciled
```

**Second-highest-risk file: `018_dedupe_specialties.sql`** if production `specialties` / `services` are in a partially-canonicalized state.

---

## D. Other code paths that create tables

Searched: `grep -rnE "CREATE TABLE( IF NOT EXISTS)?" src/`.

| File | Lines | Tables created | When it runs |
|---|---|---|---|
| `src/db.js` | 17 | `schema_migrations` | Top of `migrate()`, always. |
| `src/migrate_mobile_api.js` | 61, 71, 83, 98 | `otp_codes`, `order_timeline`, `payments`, `doctor_specialties` | At boot, after `migrate()`. **Wrapped in its own try/catch in server.js:453-457 that swallows errors with a `console.error` only.** Failures here do NOT halt boot. |
| `src/migrations/*` | various | (the schema migrations themselves) | Through `migrate()`. |

**Out-of-band: `migrate_mobile_api.js`.** This is a SECOND migration runner that creates 4 tables (`otp_codes`, `order_timeline`, `payments`, `doctor_specialties`) every boot via `CREATE TABLE IF NOT EXISTS`. It does NOT track to `schema_migrations`, so its results don't show up in the tracking table. `015_otp_codes_table.sql` was added later (commit history says it was added when the team noticed otp_codes was being created by both runners) to bring `otp_codes` into the standard flow — but `order_timeline`, `payments`, `doctor_specialties` are still mobile-api-only.

**Implication:** if today on prod you see `otp_codes` / `order_timeline` / `payments` / `doctor_specialties` tables but no schema_migrations entry for 015 yet, that's expected — `migrate_mobile_api.js` created them out-of-band on the Apr 16 (or earlier) boot, before 015 was even a file.

No seed scripts that ran during a deploy create tables. `seed_pricing_v2.js` and similar inside `scripts/` are manual-invoke only.

---

## E. Render deploy logs

**Status: UNVERIFIED — no access.** I have no direct read access to Render's deploy logs from this environment. The CLI-observable signals are:

| Signal | Value (post-tonight's deploy) |
|---|---|
| Production gitSha (`/__version`) | `20ae2620adf1ac479f5ce2371644e65fbe8cf8d7` (matches local HEAD) |
| Production startedAtIso | `2026-04-29T19:32:36.781Z` |
| Production uptimeSec at probe | 689 (not crash-looping; stable since ~11 min before this probe) |
| `/healthz` ok | true, db pool 1/1/0 |

**What this tells us:** the post-deploy process has been running uninterrupted for ~11 minutes. **Per the listener-gating logic (§B), this means `migrate()` resolved without throwing on tonight's boot.**

If `migrate()` resolved without throwing AND the runner iterates all 32 files AND the runner inserts into `schema_migrations` after each file's SQL completes — then 13 new rows should now exist in prod's `schema_migrations` (one for each of 013-024 + 025-031 minus the 25_email_campaigns one if user's manual SQL editor run had already inserted it, which it would not have since the SQL editor doesn't write to schema_migrations).

**This is the central contradiction.** The user's findings (latest tracked = 012, blocked_send_attempts absent) cannot all be true simultaneously with the observed prod state (uptime 689s, healthz green, gitSha = 20ae262) UNLESS one of the following is the case:

1. **The user's findings predate tonight's deploy.** They were verified earlier today (perhaps when prod was still on `33d4e99`, which did not contain `024` at all). The findings were accurate at the time of verification but may now be stale. Tonight's deploy may have closed the gap. Verifiable by re-running:
   ```sql
   SELECT filename, ran_at FROM schema_migrations ORDER BY id DESC LIMIT 10;
   SELECT to_regclass('public.blocked_send_attempts') IS NOT NULL AS exists;
   ```

2. **`migrate()` is somehow not iterating the new files.** If `MIGRATIONS_DIR` resolves differently in production (e.g., the dist is missing files), the runner might iterate only files 001-012 and exit cleanly. **Unlikely** because production uses `node src/server.js` directly without a build step, so the same files we have locally should be on prod's filesystem at `/opt/render/project/src/src/migrations/` or similar. Verifiable from Render's shell: `ls src/migrations/ | wc -l` should be 32.

3. **A pre-tonight deploy had been crash-looping at one of 013-024 since some date in late April.** The current HEAD on prod (20ae262) DELIVERED THE FIX implicitly because `migrate()` now would run the whole list — but only if migrate's halt-cause was not in tonight's commits. **Risk:** if the halt-cause is `019b_remove_sla_addon.sql`'s sla_24hr-row guard, AND prod has a stray sla_24hr row, then **tonight's deploy is also halting at 019b** — but the listener still bound somehow during a brief migrate window. To confirm, would need Render deploy logs showing the `[migrate]` lines or the `DB migrate failed — refusing to start` fatal log.

4. **Prior deploys ran a DIFFERENT migrate() that was buggy.** The current `migrate()` is what I read. If commits between Apr 16 and Apr 29 changed it, then prod was running a different (broken) version until tonight. `git log -- src/db.js` shows `bb963c5` (Apr 16) was the last modification to db.js, with commit message "db.js fixups." That commit predates the prod gap. If that commit broke migrate() and the gap has been silent since, then **tonight's deploy still has the same migrate() and would still be broken.** Reading the current migrate() code shows correct logic, so this hypothesis requires that the function I'm reading is wrong somehow or that my reading is wrong.

---

## Most likely root cause

**The two strongest hypotheses, ordered:**

1. **The user's findings predate tonight's deploy.** This is the simplest reconciliation with the observed healthy uptime + matching gitSha + listener-gated `app.listen`. **Action:** re-run the same Neon queries now (post-deploy). If `blocked_send_attempts` now exists and `schema_migrations` has 13 new rows, the gap closed itself when tonight's `migrate()` ran. The user's instruction to "trust" the findings is reasonable but the findings could simply be stale relative to deploy time.

2. **A long-running gap from late April was caused by `019b_remove_sla_addon.sql` halting the loop because at least one prod `order_addons` row has `addon_service_id='sla_24hr'`.** If the developer wrote the migration assuming the table was empty on prod (true for local dev) but a real order had used the `sla_24hr` add-on, the migration's intentional exception would crash migrate() on every boot. **Action:** before running the recovery, run the sla_24hr probe SELECT against Neon. If it returns > 0, that's the cause.

A third possibility worth a single-query check: run `SELECT current_user;` on Neon and confirm the role has `CREATE TABLE` / `ALTER TABLE` privileges. Render typically connects with the owner role, which has full DDL — but if the role was downgraded at some point, all migrations would fail at the first DDL statement and the post-Apr-16 silent-gap pattern would be explained.

## Recommended recovery sequence (do not execute — for user decision)

1. **Re-verify today** (read-only):
   ```sql
   SELECT filename, ran_at FROM schema_migrations ORDER BY id DESC LIMIT 20;
   SELECT to_regclass('public.blocked_send_attempts') IS NOT NULL AS blocked_table_exists;
   SELECT COUNT(*) FROM order_addons WHERE addon_service_id = 'sla_24hr';
   SELECT current_user, current_setting('is_superuser');
   ```
2. **If `blocked_send_attempts` now exists** — gap closed, no action needed. Update audit doc.
3. **If sla_24hr row count > 0** — clean those rows first, then trigger a server restart so `migrate()` picks up where it halted.
4. **If neither** — capture Render deploy logs from the last 4 deploys and look for the specific migration filename in the failure trace; that pinpoints which file is halting. With that, decide between fix-the-migration vs. backfill-schema_migrations-manually-and-skip.

Investigation complete. No code or DB modified.

---

# UPDATE — second pass after user verified Neon directly

User ran the four read-only Neon queries from §"Recommended recovery" and confirmed:

1. `schema_migrations` latest is still `id=12, filename=012_website_intake_columns.sql, ran_at=2026-04-16`. **Tonight's deploy did not advance it.**
2. `blocked_send_attempts` does not exist.
3. `order_addons` does not exist on prod (so `019b_remove_sla_addon.sql` would fail at "relation does not exist" before reaching its sla_24hr guard — eliminating that hypothesis).
4. `current_user=neondb_owner, current_database=neondb` — full DDL privileges, on the production database.

Both first-pass hypotheses are wrong. The prod migration runner has not advanced past 012 since 2026-04-16, and tonight's deploy did not change that, despite the listener being healthy and `/__version` returning the new gitSha.

## A. server.js IIFE — exact lines (verified at HEAD `20ae262`)

```
442 // Database initialization
443 var _dbReady = (async function initDatabase() {
444   try {
445     await migrate();
446     logMajor('Database migration complete');
447   } catch (err) {
448     logFatal('DB migrate failed — refusing to start', err);
449     process.exit(1);
450   }
451
452   try {
453     var { migrateForMobileApi } = require('./migrate_mobile_api');
454     migrateForMobileApi(pool);
455   } catch (err) {
456     console.error('[migrate] Mobile API migration failed:', err.message);
457   }
```

`git blame`: lines 444, 445, 447–450 are from `05aa4997` (2026-02-22) — the migrate try/catch hasn't been touched since February. Line 446 (the success log) is from `e1978c4e` (Mar 23). The structure is fail-fast: any throw from `migrate()` is caught at line 447, fatally logged at 448, and `process.exit(1)` is called at 449. No swallowing. **A migration error WOULD crash the boot.**

The mobile-API runner at lines 452–457 has its own try/catch that swallows with `console.error` — but it runs AFTER the migrate() block, so it can't mask migrate() failures.

## B. db.js migrate() — exact code (verified at HEAD `20ae262`, `git blame` shows last touched by `3b8ae6b` on 2026-03-23)

```
14 async function migrate() {
15   // Ensure the tracking table exists
16   await pool.query(
17     'CREATE TABLE IF NOT EXISTS schema_migrations (id SERIAL PRIMARY KEY, filename TEXT UNIQUE NOT NULL, ran_at TIMESTAMP DEFAULT NOW())'
18   );
19
20   // Read all .sql files, sorted by filename
21   var files = fs.readdirSync(MIGRATIONS_DIR)
22     .filter(function(f) { return f.endsWith('.sql'); })
23     .sort();
24
25   for (var i = 0; i < files.length; i++) {
26     var filename = files[i];
27
28     // Check if already ran
29     var existing = await queryOne(
30       'SELECT 1 FROM schema_migrations WHERE filename = $1',
31       [filename]
32     );
33     if (existing) continue;
34
35     // Read and execute the SQL file
36     var sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
37     await pool.query(sql);
38
39     // Record it
40     await execute(
41       'INSERT INTO schema_migrations (filename) VALUES ($1)',
42       [filename]
43     );
44     logMajor('Migration: ' + filename);
45   }
46
47   await runDataFixups();
48   await seedPricingData();
49 }
```

Per-file error handling: **none.** Any throw from `pool.query(sql)` (line 37) or `execute(INSERT)` (line 40) propagates out of `migrate()`. There is no per-file try/catch. There is no swallow at the function boundary.

If the loop completes without throwing, `migrate()` resolves. The for loop iterates over `files`. If `files` is empty, the loop is a no-op and `migrate()` resolves immediately. **`fs.readdirSync(MIGRATIONS_DIR)` on a missing directory THROWS (ENOENT) — does NOT return empty.** So the only way for the loop to be a no-op is if the directory exists but contains zero `.sql` files.

## C. Render deploy logs

UNVERIFIED — no Render API access from this environment. The user can pull these via `render logs` CLI or the Render dashboard. Search terms: `Migration:`, `Database migration complete`, `DB migrate failed`, the literal filenames `013_app_waitlist`, `024_blocked_send_attempts`. Whichever appear in the actual deploy log will pinpoint the mechanism.

## D. Local schema_migrations — fully advanced

```
local: max_id=36  max_ran_at=2026-04-29T16:11:58.416Z  total=32
local: tracked since id>12: 013_app_waitlist.sql, 014_doctor_assignments_accept_by_at.sql,
015_otp_codes_table.sql, 016_urgency_tier.sql, 017_doctor_profile_fields.sql,
018_dedupe_specialties.sql, 019_addon_services.sql, 019b_remove_sla_addon.sql,
020_orders_paid_at.sql, 021_orders_draft_step.sql, 022_orders_soft_delete.sql,
023_users_signature_url.sql, 024_blocked_send_attempts.sql,
025_prescribed_medications_log.sql, 026_addon_commission_fix.sql,
027_services_urgency_multipliers.sql, 028_refunds_table.sql,
030_orders_urgency_uplift_amount.sql, 031_canonicalize_urgency_tier_vip.sql,
025_email_campaigns_approval.sql
```

**Local migrate() works correctly.** All 32 files tracked. Latest insertion 2026-04-29 16:11 UTC (this evening, when I ran the migration locally to verify 025).

**The runner code is fine. The issue is environmental, prod-specific.**

## E. Env-var guards — none

`grep -nE "RUN_MIGRATIONS|SKIP_MIGRATIONS|DISABLE_MIGRATIONS|process\.env.*[Mm]igrat" src/server.js src/db.js src/migrate_mobile_api.js` returns **zero matches**. There is no env-var guard that can disable migration runs.

`grep -rnE "migrate\(\)|await migrate" src/` returns exactly two sites: the definition at `src/db.js:14` and the call at `src/server.js:445`. No alternate migrate() definitions, no conditional gating.

## F. Code history since 2026-04-16

Commits touching `src/db.js`, `src/server.js`, or `src/migrate_mobile_api.js` since 2026-04-16:

```
9275d03  2026-04-29  feat(campaigns): add human-approval gate to email_campaigns cron
                     (server.js — modified the email_campaigns cron SELECT only)
64704ec  2026-04-29  feat(payouts): wire SLA breach refund hookup
                     (server.js — added issueBreachRefundSafe import)
54d5246  2026-04-26  feat(patient-portal): v2 migration — wizard, V2 case detail, …
                     (server.js — patient-portal route additions)
f0ab3ad  2026-04-24  feat(addons): phase 2 — abstraction + migration + tests
                     (server.js, migrations 019/019b)
e0ded52  2026-04-23  chore(demo): populate full profile data + photo for Dr. Ahmed
                     (server.js)
cce0855  2026-04-21  feat: replace WhatsApp OTP with Twilio Verify
                     (server.js)
3983c03  2026-04-21  feat: convert index.html to EJS
                     (server.js)
2abae80  2026-04-21  fix: use pg-boss singleton for SLA sweep
                     (server.js)
beeb6c7  2026-04-21  fix: disable legacy sla_worker.js
                     (server.js)
a1aec74  2026-04-17  feat: route OTP delivery through WhatsApp Cloud API
                     (server.js)
bb963c5  2026-04-16  chore: db.js fixups (runDataFixups specialty list)
                     (db.js — UNRELATED to migrate())
```

`git blame` on the migrate try/catch (server.js:444-450) and on migrate() body (db.js:14-49) shows neither has been touched since March. **The migration runner has been the SAME code throughout the gap window (Apr 16 → today).**

## The reconciliation

These four facts are individually verifiable but pairwise contradictory if interpreted naively:

1. The migrate() runner code is correct; it works locally; it has not been modified since Mar 23.
2. The IIFE catch at server.js:447-450 makes `process.exit(1)` unconditional on any migrate() error. The HTTP listener at server.js:976 only fires inside `_dbReady.then(...)` and is the ONLY `app.listen` site.
3. Production listener has been up for 689+ s post-tonight's-deploy, gitSha matches local HEAD, `/healthz` is green.
4. Production schema_migrations has not advanced since 2026-04-16; `blocked_send_attempts` does not exist.

The ONLY way (1)+(2)+(3)+(4) are simultaneously true is if **`migrate()` is being called and resolving cleanly without doing the work.** Per the runner code, that requires the for loop at db.js:25 to iterate zero times. Which requires `fs.readdirSync(MIGRATIONS_DIR)` to return an empty array.

There is, however, a much more likely reconciliation that does NOT require any of those facts to be wrong:

### The most likely mechanism: **the Render `DATABASE_URL` points to a different database than the user is querying via Neon's SQL editor.**

If Render's prod app is connected to "DB X" (some Neon database) and the user has been verifying findings against "DB Y" (a different Neon database — possibly an older/staging instance, possibly the right one but on a different connection string), then:

- The local `migrate()` runs against local Postgres → fully advances local `schema_migrations`. ✓ (matches §D)
- Production `migrate()` on every Render deploy runs against DB X → advances DB X's `schema_migrations` and creates `blocked_send_attempts` in DB X. ✓ (matches the "listener is up" observation in §3)
- User queries DB Y in Neon SQL editor → sees DB Y's stale `schema_migrations` from 2026-04-16. ✓ (matches §4)
- User runs `025_email_campaigns_approval.sql` manually against DB Y → DB Y now has those columns, but the running production app (writing to DB X) doesn't see them. The /admin/campaigns/:id/approve endpoint, if hit, would write to DB X, where `approved_by` may or may not exist depending on whether DB X's migrate() has applied 025 yet.

This is consistent with EVERY observation. It also gives an immediate diagnostic:

- **Compare the `DATABASE_URL` env var on Render's dashboard against the connection string used in the Neon SQL editor session.** If they differ — either fully or just on the database name / endpoint — that is the answer.

There are several plausible ways the prod app could end up on a different DB without anyone noticing:

1. Multiple Neon projects/branches exist; Render is pointed at one (perhaps a dev branch, perhaps an old prod branch), and the SQL editor has been on another the whole time.
2. Neon "branched" the prod DB at some point (Neon supports branching) and the prod app was redirected to the branch but the SQL editor remained on the parent.
3. A previous-deploy env-var change on Render swapped DATABASE_URL and the app has been writing to a fresh DB ever since (which would explain why DB X's schema_migrations might also start at 012 if it was created from a snapshot, or might have all 32 if it was clean and migrate() ran the full set).

### Verifications that disambiguate (read-only, the user can run)

1. **Render dashboard:** read the value of `DATABASE_URL` env var (Render → Service → Environment).
2. **Compare hostnames:** does the hostname/database in that string match the Neon SQL editor's project + branch + database?
3. **Cross-check from the running app:** Neon allows querying the connections currently active. Run on the SQL editor session you've been using:
   ```sql
   SELECT pid, application_name, client_addr, client_hostname, backend_start, query
   FROM pg_stat_activity
   WHERE datname = current_database()
     AND state IN ('idle', 'active');
   ```
   If the production Render service is connected to THIS database, you'll see Render's IPs and `application_name` like `node-postgres`. If you see no Render-originating connections, the prod app is connecting somewhere else.

If the DATABASE_URL hypothesis is wrong, the next likeliest mechanism is:

### Alternative: Render's deployed filesystem is missing `src/migrations/`

If the prod filesystem at `/opt/render/project/src/src/migrations/` is empty or absent, `fs.readdirSync` would either throw (which would crash boot) or — if the empty result is somehow produced — the loop would iterate zero times and migrate() would resolve cleanly.

For `fs.readdirSync` to NOT throw and return empty, the directory has to exist but contain no `.sql` files. There's no obvious way that happens via Render's defaults (no `.dockerignore`, no `.renderignore`, no `render.yaml`, no build command that would strip files), but it could happen if a Render build hook or a manual filesystem action removed the files post-build.

**Verifications:** Render shell access (`render ssh` or the dashboard's shell) → `ls -la /opt/render/project/src/src/migrations/ | head`. If empty, that's the answer. If full, the DATABASE_URL hypothesis is the next thing to check.

## Updated recommendation

Stop trying to fix code. The runner is fine. Investigate the **environment delta between local and Render**. Specifically:

1. Read Render's `DATABASE_URL`. Compare to Neon SQL editor. (90 seconds.)
2. If they match, SSH to Render and `ls src/migrations/`. (60 seconds.)
3. Whichever check fails, that is the root cause.

Until one of those is verified, any fix to the migration runner code, the migration files, or the schema_migrations table itself is a fix without a confirmed cause and could make things worse.

---

# RESOLUTION — wrong database (2026-04-29 evening)

The dual-database hypothesis at the end of this investigation was correct in spirit but wrong on the specifics: it is not a Neon-vs-Neon mismatch — **production is on Supabase, not on Neon at all.** A Neon database with similar schema and data exists and has been frozen since 2026-04-16 (the cutover date). Every "production" SQL query in this investigation was directed at the stale Neon database; the live Supabase database was never queried until the user re-verified tonight via the Supabase SQL editor.

## What's actually true on production (verified on Supabase)

| Check | Result | Implication for this investigation |
|---|---|---|
| `schema_migrations` head | `id=32, filename=025_email_campaigns_approval.sql, ran_at=2026-04-29 19:32:39` | The migration runner has been working correctly all along. Migrations 022-031 all applied. Tonight's auto-deploy ran 024-031 cleanly. |
| `blocked_send_attempts` | exists | Migration 024 ran successfully on Supabase via tonight's deploy. The "table doesn't exist on prod" finding was an artifact of querying the wrong database. |
| `order_addons` | exists | The "019b would fail at relation-does-not-exist" branch of analysis was reasoning from wrong data. |
| email_campaigns `approved_by` + `approved_at` | both present | Migration 025 also ran cleanly tonight. |
| Services catalog `doctor_fee/base_price` distribution | uniform 20% across all 92 services | The 19 inverted rows were local-only (never on prod), confirming B4 was correctly downgraded to false positive. |

## What's true and what's wrong in this document

- **The runner-code analysis (§A, §B, §F) is correct and stands.** `migrate()` is fail-fast, single-defined, env-var-guard-free, and unchanged since March. The IIFE catch at server.js:447-450 unconditionally calls `process.exit(1)` on migrate failure. The single `app.listen` is gated on `_dbReady.then(...)`. All of that was right.
- **The pre-resolution hypotheses were wrong because they assumed Neon = prod.** Specifically:
  - "User's findings predate tonight's deploy" — wrong, but for a different reason than I thought. The user verified at the right time; they just verified the wrong database.
  - "019b crash-loops on a stray sla_24hr row" — moot. `order_addons` exists on Supabase and migrate() did process 019b cleanly. Eliminated by Supabase data, not by the Neon data the user re-verified.
  - "bb963c5 introduced a subtle bug in db.js" — wrong. The bb963c5 change was only to `runDataFixups()` (the specialty visibility list), did not touch `migrate()`, and prod's migrate() has been working continuously.
- **The final hypothesis ("Render is connected to a different Postgres database than the one being verified") was correct.** The framing of "different Neon project / branch" was off — the actual answer is "different provider entirely (Supabase, not Neon)" — but the diagnostic shape ("compare Render's `DATABASE_URL` to the SQL editor's connection") would have surfaced the truth as soon as it was run.
- **No code changes are needed.** The migration runner is healthy. Production is on the correct DB. Tonight's deploy applied all 13 missing migrations on Supabase.

## What still needs follow-up (separate task tomorrow per user)

- Find where `DATABASE_URL` is set on the Mac mini and confirm whether it points to Neon or Supabase. If Neon, that's the source of tonight's confusion. **Identify only — do not change yet.**
- Decide whether to decommission the Neon database, keep it as a frozen snapshot for forensics, or sync it back to parity with Supabase.

This investigation is closed.

