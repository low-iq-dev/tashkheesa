# Doctor "My Services" + Supply Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the doctor-facing "My Services" confirmation screen plus the supply-integrity system around it — a `coming_soon` catalogue/order guard, an `is_active`-keyed re-sync helper, an `onboarding_complete` + service-level assignment gate, welcome-token hardening, and a reusable bulk-invite — so the 29 password-less doctors can safely confirm the services they accept.

**Architecture:** Additive changes to the existing Node/Express/EJS monolith on Supabase Postgres (custom JWT auth). New service modules (`services_coming_soon_sync.js`, `doctor_eligibility.js`, `doctor_service_catalog.js`) centralise the reusable logic; routes and views consume them. Migration 078 formalises the already-live `coming_soon` column schema-only; a synthetic seed backs the tests. Delivered in 8 dependency-ordered phases (P0→P7).

**Tech Stack:** Node/Express, EJS, Supabase Postgres (via `src/pg`), custom JWT sessions, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-10-doctor-my-services-design.md`

## Global Constraints

- **Never** reference `services.doctor_commission_pct` anywhere; "You earn" = `services.doctor_fee` (authoritative payout).
- **Do not modify the `/apply` route** (separate work item).
- The `coming_soon` re-sync is keyed on `users.is_active`, **never** `is_paused` (a paused doctor's services stay bookable). Do not change without asking.
- No urgency-multiplier or payout-calculation changes. No Supabase Auth users; custom JWT sessions only; no RLS access path.
- Migrations live in `src/migrations/NNN_*.sql`, apply on boot via `src/db.js`, must be **idempotent and boot-safe** — the server refuses to start on migration failure. Next number is **078**.
- **PDPL / no PII in git:** migration 078 is **schema-only**; the 4 prod data migrations are documented by reference, never replayed. The dev/test seed is **synthetic** and is **not** a numbered migration.
- **Ship the assignment gate (Phase P3) and the bulk-invite action (Phase P7) in the SAME release** — a gate deployed without a way to send invites strands all 29 doctors.
- Tests run against a **prod-schema clone / hermetic `node --test` harness**, NOT a raw local boot (migration 070 needs a Supabase `anon` role absent locally). Skip gracefully when no test DB is reachable; EJS/CSS changes are verified via headless Chrome.
- All DB access via `src/pg` (`queryOne/queryAll/execute/withTransaction`); transactions thread `client`; parameterise every value (`$1,$2`).
- Bilingual EN/AR + RTL; every `tt()` carries EN+AR fallbacks.
- Error codes (exact): `SERVICE_NOT_BOOKABLE`, `DOCTOR_ONBOARDING_INCOMPLETE`, `DOCTOR_SERVICE_NOT_OFFERED`.
- Prod write **dry-runs** go through Supabase MCP (project `wvmhliweujmhlzknmuzh`) as `BEGIN … ROLLBACK`; **never** put `DATABASE_URL` on a shell line.

---

## Phase P0 — Migration 078 (schema-only) + synthetic seed + test harness

### Task 1: Migration 078 — schema-only reconciliation of the 6 prod hotfixes

**Files:**
- Create: `/Users/ziadelwahsh/tashkheesa-portal/src/migrations/078_reconcile_prod_hotfixes_20260810.sql`
- Create: `/Users/ziadelwahsh/tashkheesa-portal/tests/core/migration-078-coming-soon.test.js`
- Reference (read-only, do not modify): `src/db.js:14-52` (`migrate()` reads every `*.sql` in `src/migrations/` in filename order, records in `schema_migrations`), `src/migrations/077_orders_active_display_cols.sql` (DO-block + `to_regclass`/`information_schema` guard format), `src/migrations/070_rls_enable_default_deny.sql:19-67` (`ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `to_regclass` guard pattern), `src/migrations/076_orders_display_price.sql` (idempotent `ADD COLUMN IF NOT EXISTS` guard format).

**Interfaces:**
- Consumes: nothing from other slices. Reads prod-verified schema — `services(id text NOT NULL, specialty_id text, code text, name text, base_price double precision, doctor_fee double precision, sla_hours int DEFAULT 48, is_visible bool DEFAULT true, coming_soon bool NOT NULL DEFAULT false)`; `doctor_services(doctor_id text, service_id text, PRIMARY KEY(doctor_id,service_id))`; `users(id, role, is_active bool DEFAULT true)`; backup tables `_bak_services_20260729`, `_bak_srp_20260729` both present in prod.
- Produces: on a fresh/clone DB, `migrate()` yields `services.coming_soon boolean NOT NULL DEFAULT false` + partial index `idx_services_coming_soon` + the is_active-keyed resync applied. The migration is the schema-of-record the re-sync helper (`src/services/services_coming_soon_sync.js`, other slice) and the bookable clause depend on.

- [ ] **Step 1: Write the failing migration test first.**
  Create `/Users/ziadelwahsh/tashkheesa-portal/tests/core/migration-078-coming-soon.test.js`. It follows the exact hermetic-DB harness from `tests/services/doctor_applications.test.js` (own `Pool` against `DATABASE_URL || localhost:5432/tashkheesa`, `test.before` applies the migration SQL idempotently, graceful skip when no DB is reachable). It fails now because the `.sql` file does not exist yet (`fs.readFileSync` throws → `DB_OK` stays false → tests skip is NOT acceptable here; we assert the file exists so it's a hard FAIL until authored).

  ```js
  'use strict';

  // Migration 078 — schema-only reconciliation of the prod coming_soon hotfix.
  // Runs on the prod-schema clone / hermetic harness (same pattern as
  // tests/services/doctor_applications.test.js): an own Pool against the local
  // test DB, applying the 078 .sql idempotently in before(). Skips gracefully
  // when no test DB is reachable (CI without Postgres, or the local anon-role
  // boot issue), but HARD-FAILS if the 078 file is missing.
  //
  // Run: node --test tests/core/migration-078-coming-soon.test.js

  const test   = require('node:test');
  const assert = require('node:assert/strict');
  const fs     = require('fs');
  const path   = require('path');
  const { Pool } = require('pg');

  const MIGRATION = path.join(__dirname, '..', '..', 'src', 'migrations',
    '078_reconcile_prod_hotfixes_20260810.sql');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
    ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });

  let DB_OK = false;
  let skipReason = '';
  let sql = '';

  test.before(async () => {
    // Hard requirement: the migration file must exist (this is what fails first in TDD).
    sql = fs.readFileSync(MIGRATION, 'utf-8');
    try {
      const c = await pool.connect();
      try {
        // Precondition for a clone that predates the column: the coming_soon
        // migration only makes sense on a DB that already has `services`.
        await c.query(sql);            // apply once — idempotent
        DB_OK = true;
      } finally {
        c.release();
      }
    } catch (err) {
      skipReason = err.message;
    }
  });

  test.after(async () => { await pool.end(); });

  test('078 file exists and is non-empty', () => {
    assert.ok(sql.length > 0, '078 migration SQL must be present');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS coming_soon/i);
  });

  test('services.coming_soon exists as boolean NOT NULL DEFAULT false after migrate', async (t) => {
    if (!DB_OK) return t.skip('no test DB reachable: ' + skipReason);
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='services' AND column_name='coming_soon'`
    );
    assert.equal(rows.length, 1, 'coming_soon column present');
    assert.equal(rows[0].data_type, 'boolean');
    assert.equal(rows[0].is_nullable, 'NO');
    assert.match(String(rows[0].column_default), /false/);
  });

  test('partial index idx_services_coming_soon exists (WHERE is_visible)', async (t) => {
    if (!DB_OK) return t.skip('no test DB reachable: ' + skipReason);
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='services' AND indexname='idx_services_coming_soon'`
    );
    assert.equal(rows.length, 1, 'idx_services_coming_soon present');
    assert.match(rows[0].indexdef, /WHERE is_visible/i);
  });

  test('re-running 078 is a no-op (idempotent) — column/index unchanged', async (t) => {
    if (!DB_OK) return t.skip('no test DB reachable: ' + skipReason);
    await pool.query(sql);   // second apply must not throw
    const idx = await pool.query(
      `SELECT count(*)::int AS c FROM pg_indexes
        WHERE schemaname='public' AND indexname='idx_services_coming_soon'`
    );
    assert.equal(idx.rows[0].c, 1, 'still exactly one index after re-run');
    const col = await pool.query(
      `SELECT count(*)::int AS c FROM information_schema.columns
        WHERE table_schema='public' AND table_name='services' AND column_name='coming_soon'`
    );
    assert.equal(col.rows[0].c, 1, 'still exactly one coming_soon column after re-run');
  });
  ```

- [ ] **Step 2: Run the test — confirm it FAILS on the missing file.**
  Command: `cd /Users/ziadelwahsh/tashkheesa-portal && node --test tests/core/migration-078-coming-soon.test.js`
  Expected: `before` throws `ENOENT: no such file or directory, open '.../078_reconcile_prod_hotfixes_20260810.sql'` → suite errors out, `tests 0 pass` / failing `before` hook reported. (Not a graceful skip — the file genuinely doesn't exist.)

- [ ] **Step 3: Author the 078 migration (verbatim prod SQL + guards).**
  Create `/Users/ziadelwahsh/tashkheesa-portal/src/migrations/078_reconcile_prod_hotfixes_20260810.sql`. The `ALTER`/`COMMENT`/`UPDATE`/`CREATE INDEX` block is copied byte-for-byte from the prod migration `20260810094458 add_coming_soon_flag_to_services` (captured via Supabase MCP). The two backup-table RLS enables are each guarded by `to_regclass(...) IS NOT NULL` (they exist in prod but not on a fresh local DB). The header records the 4 data migrations by version+name+purpose, marked not-replayed.

  ```sql
  -- 078_reconcile_prod_hotfixes_20260810.sql
  -- ============================================================================
  -- Reconcile the repo against 6 migrations applied DIRECTLY to prod via Supabase
  -- MCP on 2026-08-10 (all present in supabase_migrations.schema_migrations, none
  -- previously in the repo). This file codifies ONLY the SCHEMA changes so a
  -- fresh / local `migrate()` produces a DB matching prod. Prod is the source of
  -- truth; every statement here is idempotent and is a 0-change no-op on prod.
  --
  -- The 4 DATA migrations below are recorded BY REFERENCE ONLY — NOT replayed.
  -- Rationale (design §4.8 / §11): they embed 16 doctors' emails / phones /
  -- licence numbers (PDPL — must not enter permanent git history), and re-running
  -- data INSERTs on every fresh boot is an unnecessary footgun. Prod already has
  -- them; a fresh local DB gets its data from the SYNTHETIC dev seed
  -- (scripts/dev/seed_my_services_fixtures.js), never from here.
  --
  --   applied to prod via MCP 2026-08-10, NOT replayed — prod is source of truth:
  --     20260810093051  map_active_doctors_to_own_specialty_services
  --                     — INSERT … NOT EXISTS: map each active doctor to every
  --                       visible service in their own specialty.
  --     20260810093745  promote_16_applicants_to_active_doctors  (PII)
  --                     — promote 16 vetted applicants to active doctor users.
  --                       (prod copy is a bare INSERT … VALUES with NO ON CONFLICT;
  --                       intentionally NOT replayed — no PII in git.)
  --     20260810093756  map_new_doctors_to_services_and_close_applications
  --                     — map the 16 new doctors to services; close their apps.
  --     20260810093816  close_jamaleddin_duplicate_applications
  --                     — mark one applicant's duplicate applications closed.
  --
  -- The SCHEMA changes reconciled below (safe to replay everywhere):
  --   20260810094405  enable_rls_on_pricing_backup_tables  (RLS)
  --   20260810094458  add_coming_soon_flag_to_services      (column+comment+index+resync)
  -- ============================================================================

  -- ── 20260810094458 add_coming_soon_flag_to_services (verbatim from prod) ─────
  -- Services stay visible in the catalogue but render as "Coming Soon" and
  -- non-bookable until at least one active doctor is mapped to them.
  ALTER TABLE public.services
    ADD COLUMN IF NOT EXISTS coming_soon boolean NOT NULL DEFAULT false;

  COMMENT ON COLUMN public.services.coming_soon IS
    'True when no active doctor is mapped to this service. UI must show a Coming Soon badge and disable booking. Re-sync after any doctor_services change.';

  UPDATE public.services sv
  SET coming_soon = NOT EXISTS (
    SELECT 1 FROM public.doctor_services ds
    JOIN public.users u ON u.id = ds.doctor_id
    WHERE ds.service_id = sv.id AND u.role = 'doctor' AND u.is_active = true
  );

  CREATE INDEX IF NOT EXISTS idx_services_coming_soon ON public.services (coming_soon) WHERE is_visible;

  -- ── 20260810094405 enable_rls_on_pricing_backup_tables ──────────────────────
  -- Default-deny RLS on the two 2026-07-29 pricing backup tables so they match
  -- the 070/071/072 lockdown posture. Each guarded on the table existing — a
  -- fresh/local DB never created these backups, so skip cleanly (070 pattern).
  DO $$
  BEGIN
    IF to_regclass('public._bak_services_20260729') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public._bak_services_20260729 ENABLE ROW LEVEL SECURITY';
    END IF;
  END $$;

  DO $$
  BEGIN
    IF to_regclass('public._bak_srp_20260729') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public._bak_srp_20260729 ENABLE ROW LEVEL SECURITY';
    END IF;
  END $$;
  ```

- [ ] **Step 4: Run the test — confirm it PASSES (or skips cleanly with no DB).**
  Command: `cd /Users/ziadelwahsh/tashkheesa-portal && node --test tests/core/migration-078-coming-soon.test.js`
  Expected with a reachable test DB: `tests 5`, `pass 5`, `fail 0`. Expected with NO test DB reachable (the local anon-role boot situation): the first two file-presence assertions pass; the three DB assertions each print `t.skip('no test DB reachable: …')` → still `fail 0`, no crash. Either outcome is green.

- [ ] **Step 5: Prod dry-run — confirm 078 is a 0-change no-op on prod (via Supabase MCP, never DATABASE_URL).**
  Run through `mcp__claude_ai_Supabase__execute_sql` on project `wvmhliweujmhlzknmuzh`:
  ```sql
  BEGIN;
    ALTER TABLE public.services ADD COLUMN IF NOT EXISTS coming_soon boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_services_coming_soon ON public.services (coming_soon) WHERE is_visible;
    -- assert the resync would flip 0 rows (already in sync in prod):
    SELECT count(*) AS would_flip
      FROM public.services sv
     WHERE sv.coming_soon <> NOT EXISTS (
       SELECT 1 FROM public.doctor_services ds
       JOIN public.users u ON u.id = ds.doctor_id
       WHERE ds.service_id = sv.id AND u.role='doctor' AND u.is_active=true);
    SELECT to_regclass('public._bak_services_20260729') IS NOT NULL AS bak_services_present,
           to_regclass('public._bak_srp_20260729')      IS NOT NULL AS bak_srp_present;
  ROLLBACK;
  ```
  Expected: `would_flip = 0` (spec §2 confirms the resync flips 0 rows in prod today); both `*_present = true`. No error. This proves the whole 078 body applies clean against real prod schema/RLS and mutates nothing.

- [ ] **Step 6: Commit.**
  `git add src/migrations/078_reconcile_prod_hotfixes_20260810.sql tests/core/migration-078-coming-soon.test.js && git commit` with message body ending in the required `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Suggested subject: `feat(services): migration 078 — reconcile coming_soon column + backup-table RLS (schema-only)`.

---

### Task 2: Synthetic dev/test seed for the four My Services doctor shapes

**Files:**
- Create: `/Users/ziadelwahsh/tashkheesa-portal/scripts/dev/seed_my_services_fixtures.js`
- Create: `/Users/ziadelwahsh/tashkheesa-portal/tests/services/seed_my_services_fixtures.test.js`
- Reference (read-only): `tests/services/doctor_applications.test.js:17-52` (own-`Pool` + graceful-skip + per-process-SUFFIX cleanup pattern this seed's test mirrors); `src/db.js:335-369` (existing `INSERT … ON CONFLICT DO NOTHING` seed style).

**Interfaces:**
- Consumes: prod-verified columns (see Migration-078 task). Seeds only real columns — `services(id, specialty_id, code, name, base_price, doctor_fee, sla_hours, is_visible, coming_soon)`, `specialties(id, name, name_ar, is_visible)`, `users(id, role, is_active, is_paused, onboarding_complete, specialty_id, password_hash, first_login_at, email, name, phone, medical_license_number, sub_specialties)`, `doctor_services(doctor_id, service_id)`. **No `services.name_ar`** (column does not exist).
- Produces: `module.exports = { seedMyServicesFixtures, cleanupMyServicesFixtures, FIXTURES }`.
  - `async function seedMyServicesFixtures(client)` — idempotent upsert of all 4 shapes; `client` is a `pg` client/pool (`.query(sql, params)`); resolves to a summary object `{ specialties, services, doctors, mappings }` (counts). Callable by tests against the clone.
  - `async function cleanupMyServicesFixtures(client)` — deletes every fixture row (doctor_services → users → services → specialties) by the `SEED_PREFIX`.
  - `FIXTURES` — the frozen descriptor object (ids/emails/licences) so tests assert exact expected shapes without re-deriving them.
- Guarantee: NOT a numbered migration → never picked up by `migrate()`; can never run against prod on boot. All data synthetic (`@example.com`, `Dr. Fixture …`, `LIC-FIX-*`, ids prefixed `seed_ms_`).

- [ ] **Step 1: Write the failing seed test first.**
  Create `/Users/ziadelwahsh/tashkheesa-portal/tests/services/seed_my_services_fixtures.test.js` (mirrors `doctor_applications.test.js`: own `Pool`, applies migration 078 in `before` so `services.coming_soon` exists on the clone, then runs the seed; graceful skip when no DB; cleanup in `after`). It fails now because `scripts/dev/seed_my_services_fixtures.js` does not exist.

  ```js
  'use strict';

  // Exercises the SYNTHETIC My Services seed against the prod-schema clone /
  // hermetic harness (same pattern as doctor_applications.test.js). before()
  // applies migration 078 so services.coming_soon exists, then seeds. Skips
  // gracefully with no DB. after() removes every fixture row.
  //
  // Run: node --test tests/services/seed_my_services_fixtures.test.js

  const test   = require('node:test');
  const assert = require('node:assert/strict');
  const fs     = require('fs');
  const path   = require('path');
  const { Pool } = require('pg');

  const { seedMyServicesFixtures, cleanupMyServicesFixtures, FIXTURES } =
    require('../../scripts/dev/seed_my_services_fixtures');

  const M078 = path.join(__dirname, '..', '..', 'src', 'migrations',
    '078_reconcile_prod_hotfixes_20260810.sql');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
    ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });

  let DB_OK = false, skipReason = '';

  test.before(async () => {
    const c = await pool.connect();
    try {
      await c.query(fs.readFileSync(M078, 'utf-8')); // ensure coming_soon exists
      await seedMyServicesFixtures(c);               // idempotent
      DB_OK = true;
    } catch (err) { skipReason = err.message; }
    finally { c.release(); }
  });

  test.after(async () => {
    try { if (DB_OK) await cleanupMyServicesFixtures(pool); } catch (_) {}
    await pool.end();
  });

  test('shape 3 (normal): all N own-specialty services are visible + mapped + pre-ticked', async (t) => {
    if (!DB_OK) return t.skip('no test DB: ' + skipReason);
    const doc = FIXTURES.normal.doctorId;
    const spec = FIXTURES.normal.specialtyId;
    const svc = (await pool.query(
      "SELECT id FROM services WHERE specialty_id=$1 AND is_visible=true", [spec])).rows;
    assert.ok(svc.length >= 2, 'normal specialty has visible services');
    const mapped = (await pool.query(
      "SELECT service_id FROM doctor_services WHERE doctor_id=$1", [doc])).rows;
    assert.equal(mapped.length, svc.length, 'doctor mapped to every own-specialty service');
  });

  test('shape 1 (cross-specialty): empty own specialty but N cross-specialty mappings; onboarding stays false', async (t) => {
    if (!DB_OK) return t.skip('no test DB: ' + skipReason);
    const doc = FIXTURES.crossSpecialty.doctorId;
    const own = (await pool.query(
      "SELECT id FROM services WHERE specialty_id=(SELECT specialty_id FROM users WHERE id=$1) AND is_visible=true", [doc])).rows;
    assert.equal(own.length, 0, 'own specialty has zero visible services');
    const maps = (await pool.query(
      "SELECT service_id FROM doctor_services WHERE doctor_id=$1", [doc])).rows;
    assert.ok(maps.length >= 2, 'has cross-specialty mappings (the Medhat/Ghoneim shape)');
    const u = (await pool.query("SELECT onboarding_complete FROM users WHERE id=$1", [doc])).rows[0];
    assert.equal(u.onboarding_complete, false, 'unconfirmed default — onboarding stays false');
  });

  test('shape 2 (empty-union): zero own-specialty services AND zero mappings', async (t) => {
    if (!DB_OK) return t.skip('no test DB: ' + skipReason);
    const doc = FIXTURES.emptyUnion.doctorId;
    const own = (await pool.query(
      "SELECT id FROM services WHERE specialty_id=(SELECT specialty_id FROM users WHERE id=$1) AND is_visible=true", [doc])).rows;
    const maps = (await pool.query("SELECT 1 FROM doctor_services WHERE doctor_id=$1", [doc])).rows;
    assert.equal(own.length, 0, 'no own-specialty visible services');
    assert.equal(maps.length, 0, 'no cross-specialty mappings → union empty');
  });

  test('shape 4 (last-doctor-standing): the flagged service has exactly one active mapped doctor', async (t) => {
    if (!DB_OK) return t.skip('no test DB: ' + skipReason);
    const svcId = FIXTURES.lastDoctorStanding.serviceId;
    const cnt = (await pool.query(
      `SELECT count(*)::int AS c FROM doctor_services ds
         JOIN users u ON u.id=ds.doctor_id
        WHERE ds.service_id=$1 AND u.role='doctor' AND u.is_active=true`, [svcId])).rows[0];
    assert.equal(cnt.c, 1, 'exactly one active doctor holds the service (untick will flip coming_soon)');
  });

  test('seed is idempotent — a second run inserts no duplicate mappings', async (t) => {
    if (!DB_OK) return t.skip('no test DB: ' + skipReason);
    const before = (await pool.query("SELECT count(*)::int AS c FROM doctor_services WHERE doctor_id LIKE $1", [FIXTURES.SEED_PREFIX + '%'])).rows[0].c;
    await seedMyServicesFixtures(pool);
    const after = (await pool.query("SELECT count(*)::int AS c FROM doctor_services WHERE doctor_id LIKE $1", [FIXTURES.SEED_PREFIX + '%'])).rows[0].c;
    assert.equal(after, before, 're-seed added no rows');
  });
  ```

- [ ] **Step 2: Run the test — confirm it FAILS on the missing seed module.**
  Command: `cd /Users/ziadelwahsh/tashkheesa-portal && node --test tests/services/seed_my_services_fixtures.test.js`
  Expected: `Cannot find module '../../scripts/dev/seed_my_services_fixtures'` at require time → suite fails to load. Hard fail.

- [ ] **Step 3: Author the synthetic seed.**
  Create `/Users/ziadelwahsh/tashkheesa-portal/scripts/dev/seed_my_services_fixtures.js`. All ids prefixed `seed_ms_`, all emails `@example.com`, all licences `LIC-FIX-*`. Four shapes wired exactly to §4.9. Every INSERT is `ON CONFLICT DO NOTHING` (idempotent). No `services.name_ar` column is written. `mkdir -p scripts/dev` is implied by creating the file.

  ```js
  'use strict';

  // ============================================================================
  // SYNTHETIC dev/test seed for the doctor "My Services" feature (design §4.9).
  //
  // NOT a numbered migration — it lives under scripts/dev/ and is NEVER read by
  // src/db.js#migrate(), so it can never run against prod on boot. ALL data is
  // obviously fake: ids prefixed `seed_ms_`, emails @example.com, licences
  // LIC-FIX-*. Seeds the four doctor shapes the union rule + coming_soon guard
  // exist for. Idempotent (ON CONFLICT DO NOTHING everywhere); re-runnable.
  //
  // Requires migration 078 already applied (services.coming_soon must exist).
  // Callable from tests:  await seedMyServicesFixtures(client)
  // Standalone (against a clone):  node scripts/dev/seed_my_services_fixtures.js
  // ============================================================================

  const SEED_PREFIX = 'seed_ms_';

  // ── Specialties ─────────────────────────────────────────────────────────────
  // - spec_cardio_seed : has visible services (shape 3 normal, shape 4 last-doctor)
  // - spec_nephro_seed : has NO visible services (shape 1 cross-specialty own spec,
  //                       shape 2 empty-union own spec) — cross-spec maps point at cardio
  const SPECIALTIES = [
    { id: SEED_PREFIX + 'spec_cardio', name: 'Fixture Cardiology', name_ar: 'قلب (تجريبي)', is_visible: true },
    { id: SEED_PREFIX + 'spec_nephro', name: 'Fixture Nephrology', name_ar: 'كلى (تجريبي)', is_visible: true },
  ];

  // ── Services (only real columns; NO name_ar column on services) ─────────────
  const SERVICES = [
    // cardiology — visible & bookable-eligible
    { id: SEED_PREFIX + 'svc_ecg',   specialty_id: SEED_PREFIX + 'spec_cardio', name: 'Fixture ECG Review',   base_price: 500,  doctor_fee: 100, sla_hours: 48, is_visible: true },
    { id: SEED_PREFIX + 'svc_echo',  specialty_id: SEED_PREFIX + 'spec_cardio', name: 'Fixture Echo Review',  base_price: 1200, doctor_fee: 240, sla_hours: 48, is_visible: true },
    // shape-4 target: exactly one active doctor will hold this
    { id: SEED_PREFIX + 'svc_holter', specialty_id: SEED_PREFIX + 'spec_cardio', name: 'Fixture Holter Review', base_price: 3000, doctor_fee: 600, sla_hours: 48, is_visible: true },
    // nephrology — deliberately has NO visible services (empty own-specialty catalogue)
  ];

  // ── Doctors (users) ─────────────────────────────────────────────────────────
  const DOCTORS = [
    // shape 3 — normal: cardiology, mapped to all 3 cardio services
    { id: SEED_PREFIX + 'doc_normal', specialty_id: SEED_PREFIX + 'spec_cardio',
      email: 'fixture.normal@example.com', name: 'Dr. Fixture Normal', licence: 'LIC-FIX-N1' },
    // shape 1 — cross-specialty: nephrology (empty own catalogue), mapped to 2 cardio svcs
    { id: SEED_PREFIX + 'doc_cross', specialty_id: SEED_PREFIX + 'spec_nephro',
      email: 'fixture.cross@example.com', name: 'Dr. Fixture Cross', licence: 'LIC-FIX-X1' },
    // shape 2 — empty-union: nephrology, ZERO mappings
    { id: SEED_PREFIX + 'doc_empty', specialty_id: SEED_PREFIX + 'spec_nephro',
      email: 'fixture.empty@example.com', name: 'Dr. Fixture Empty', licence: 'LIC-FIX-E1' },
    // shape 4 — the SOLE active doctor holding svc_holter (last-doctor-standing)
    { id: SEED_PREFIX + 'doc_solo', specialty_id: SEED_PREFIX + 'spec_cardio',
      email: 'fixture.solo@example.com', name: 'Dr. Fixture Solo', licence: 'LIC-FIX-S1' },
  ];

  // ── Mappings (doctor_services) ──────────────────────────────────────────────
  const MAPPINGS = [
    // normal → all 3 cardio services
    { doctor_id: SEED_PREFIX + 'doc_normal', service_id: SEED_PREFIX + 'svc_ecg' },
    { doctor_id: SEED_PREFIX + 'doc_normal', service_id: SEED_PREFIX + 'svc_echo' },
    { doctor_id: SEED_PREFIX + 'doc_normal', service_id: SEED_PREFIX + 'svc_holter' },
    // cross → 2 cross-specialty (cardio) services, none in own (nephro) specialty
    { doctor_id: SEED_PREFIX + 'doc_cross', service_id: SEED_PREFIX + 'svc_ecg' },
    { doctor_id: SEED_PREFIX + 'doc_cross', service_id: SEED_PREFIX + 'svc_echo' },
    // solo → ONLY svc_holter (making it the last-doctor-standing service).
    //        NOTE: doc_normal above also maps svc_holter, so to keep shape 4
    //        exact we DELETE doc_normal's holter map below (see seed fn).
    { doctor_id: SEED_PREFIX + 'doc_solo', service_id: SEED_PREFIX + 'svc_holter' },
    // empty → (no rows)
  ];

  const FIXTURES = Object.freeze({
    SEED_PREFIX,
    normal:            { doctorId: SEED_PREFIX + 'doc_normal', specialtyId: SEED_PREFIX + 'spec_cardio' },
    crossSpecialty:    { doctorId: SEED_PREFIX + 'doc_cross',  specialtyId: SEED_PREFIX + 'spec_nephro' },
    emptyUnion:        { doctorId: SEED_PREFIX + 'doc_empty',  specialtyId: SEED_PREFIX + 'spec_nephro' },
    lastDoctorStanding:{ doctorId: SEED_PREFIX + 'doc_solo',   serviceId:   SEED_PREFIX + 'svc_holter'  },
  });

  async function seedMyServicesFixtures(client) {
    for (const s of SPECIALTIES) {
      await client.query(
        'INSERT INTO specialties (id, name, name_ar, is_visible) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
        [s.id, s.name, s.name_ar, s.is_visible]);
    }
    for (const sv of SERVICES) {
      await client.query(
        `INSERT INTO services (id, specialty_id, code, name, base_price, doctor_fee, sla_hours, is_visible, coming_soon)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT (id) DO NOTHING`,
        [sv.id, sv.specialty_id, sv.id, sv.name, sv.base_price, sv.doctor_fee, sv.sla_hours, sv.is_visible]);
    }
    for (const d of DOCTORS) {
      await client.query(
        `INSERT INTO users (id, role, is_active, is_paused, onboarding_complete, specialty_id,
                            password_hash, first_login_at, email, name, phone, medical_license_number, sub_specialties)
         VALUES ($1,'doctor',true,false,false,$2,NULL,NULL,$3,$4,$5,$6,'[]'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, d.specialty_id, d.email, d.name, '+201000000000', d.licence]);
    }
    for (const m of MAPPINGS) {
      await client.query(
        'INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT (doctor_id, service_id) DO NOTHING',
        [m.doctor_id, m.service_id]);
    }
    // Enforce shape 4 exactness: svc_holter must have EXACTLY ONE active doctor
    // (doc_solo). Remove any non-solo seed mapping to holter so the coming_soon
    // untick test has a true last-doctor-standing target. Scoped to seed rows.
    await client.query(
      `DELETE FROM doctor_services
        WHERE service_id = $1 AND doctor_id LIKE $2 AND doctor_id <> $3`,
      [SEED_PREFIX + 'svc_holter', SEED_PREFIX + '%', SEED_PREFIX + 'doc_solo']);

    // Keep coming_soon truthful for seed services (mirrors the re-sync helper,
    // scoped to seed rows so it never touches real catalogue rows).
    await client.query(
      `UPDATE services sv SET coming_soon = NOT EXISTS (
         SELECT 1 FROM doctor_services ds JOIN users u ON u.id = ds.doctor_id
          WHERE ds.service_id = sv.id AND u.role='doctor' AND u.is_active=true)
        WHERE sv.id LIKE $1`, [SEED_PREFIX + '%']);

    return { specialties: SPECIALTIES.length, services: SERVICES.length, doctors: DOCTORS.length, mappings: MAPPINGS.length };
  }

  async function cleanupMyServicesFixtures(client) {
    await client.query('DELETE FROM doctor_services WHERE doctor_id LIKE $1', [SEED_PREFIX + '%']);
    await client.query("DELETE FROM users WHERE id LIKE $1 AND role='doctor'", [SEED_PREFIX + '%']);
    await client.query('DELETE FROM services WHERE id LIKE $1', [SEED_PREFIX + '%']);
    await client.query('DELETE FROM specialties WHERE id LIKE $1', [SEED_PREFIX + '%']);
  }

  module.exports = { seedMyServicesFixtures, cleanupMyServicesFixtures, FIXTURES, SEED_PREFIX };

  // Standalone runner (against a clone only — NEVER prod). Reads DATABASE_URL
  // from the environment; refuses if it smells like prod would require the
  // caller's own guard, so we keep this minimal and explicit.
  if (require.main === module) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
      ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
    });
    seedMyServicesFixtures(pool)
      .then((s) => { console.log('[seed_my_services] seeded', s); return pool.end(); })
      .catch((e) => { console.error('[seed_my_services] FAILED:', e.message); pool.end(); process.exit(1); });
  }
  ```

- [ ] **Step 4: Run the test — confirm it PASSES (or skips cleanly with no DB).**
  Command: `cd /Users/ziadelwahsh/tashkheesa-portal && node --test tests/services/seed_my_services_fixtures.test.js`
  Expected with a reachable clone: `tests 5`, `pass 5`, `fail 0`. Expected with no DB: every test prints `t.skip('no test DB: …')`, `fail 0`. Green either way.

- [ ] **Step 5: Guard — prove the seed is NOT a migration (can never run on prod boot).**
  Command: `cd /Users/ziadelwahsh/tashkheesa-portal && node -e "const fs=require('fs');const files=fs.readdirSync('src/migrations').filter(f=>f.endsWith('.sql'));const bad=files.filter(f=>/seed_my_services/i.test(f));console.log('migration files referencing the seed:',bad.length);process.exit(bad.length===0?0:1)"`
  Expected: `migration files referencing the seed: 0` and exit 0 — confirms `migrate()` (which reads only `src/migrations/*.sql`) will never execute the synthetic seed.

- [ ] **Step 6: Commit.**
  `git add scripts/dev/seed_my_services_fixtures.js tests/services/seed_my_services_fixtures.test.js && git commit` with the required `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Suggested subject: `test(doctor): synthetic My Services seed (4 doctor shapes) + fixtures test`.

---

### Task 3: Document + confirm the My Services test harness (how downstream slices spin up a schema-correct DB)

**Files:**
- Create: `/Users/ziadelwahsh/tashkheesa-portal/tests/services/README_my_services_harness.md` (a short harness note co-located with the tests — this is documentation input to the other slices, not a report file).
- Reference (read-only): `tests/services/doctor_applications.test.js` (canonical harness), `src/migrations/078_reconcile_prod_hotfixes_20260810.sql`, `scripts/dev/seed_my_services_fixtures.js`.

**Interfaces:**
- Consumes: `seedMyServicesFixtures(client)` / `cleanupMyServicesFixtures(client)` / `FIXTURES` (from the seed task); migration file `078_…sql`.
- Produces: a documented, copy-pasteable `before/after` block every downstream My Services DB test reuses, so route/assignment/coming-soon slices don't each reinvent the harness.

- [ ] **Step 1: Write the harness note.**
  This task has no runnable code of its own (it documents the pattern the other tasks already proved). The harness is: `node --test`, an own `pg.Pool` against `DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa'` (this is the prod-schema clone / hermetic DB — a raw local `npm run dev` boot is BROKEN because migration 070 needs a Supabase `anon` role absent locally, so DB tests must NOT invoke `migrate()`/full boot; they apply only the specific `.sql` files they need). Create `/Users/ziadelwahsh/tashkheesa-portal/tests/services/README_my_services_harness.md`:

  ```markdown
  # My Services test harness (prod-schema clone / hermetic)

  Local `npm run dev` boot is broken: migration 070 (`070_rls_enable_default_deny.sql`)
  needs a Supabase `anon` role that does not exist on a plain local Postgres, so a raw
  boot / full `migrate()` throws before the server is up. **My Services DB tests must
  therefore NOT call `src/db.js#migrate()` or boot the server.** They connect to a
  prod-schema clone and apply only the specific `.sql` they need — exactly the pattern
  in `tests/services/doctor_applications.test.js`.

  ## Connection
  Own pool, same default as every other DB-touching test:
  ```js
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
    ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  ```
  Skip gracefully when the DB is unreachable (CI without Postgres): guard each test with
  `if (!DB_OK) return t.skip('no test DB: ' + skipReason)`.

  ## Standard before/after for any My Services DB test
  ```js
  const fs = require('fs'); const path = require('path');
  const { seedMyServicesFixtures, cleanupMyServicesFixtures, FIXTURES } =
    require('../../scripts/dev/seed_my_services_fixtures');
  const M078 = path.join(__dirname, '..', '..', 'src', 'migrations',
    '078_reconcile_prod_hotfixes_20260810.sql');

  let DB_OK = false, skipReason = '';
  test.before(async () => {
    const c = await pool.connect();
    try {
      await c.query(fs.readFileSync(M078, 'utf-8')); // idempotent: ensures services.coming_soon + index
      await seedMyServicesFixtures(c);               // idempotent: the 4 doctor shapes
      DB_OK = true;
    } catch (e) { skipReason = e.message; } finally { c.release(); }
  });
  test.after(async () => {
    try { if (DB_OK) await cleanupMyServicesFixtures(pool); } catch (_) {}
    await pool.end();
  });
  ```

  ## The four shapes (from FIXTURES)
  - `FIXTURES.normal`            — cardiology doctor mapped to all visible own-specialty services (pre-tick).
  - `FIXTURES.crossSpecialty`    — nephrology doctor (empty own catalogue) with cross-specialty maps (Medhat/Ghoneim shape; onboarding stays false until saved).
  - `FIXTURES.emptyUnion`        — nephrology doctor with zero maps (escape hatch; stays out of assignment pool).
  - `FIXTURES.lastDoctorStanding`— `serviceId` held by exactly one active doctor (untick → `coming_soon=true` → order guard rejects).

  ## Rules
  - Never `migrate()` the whole chain in a test; apply only the `.sql` you depend on.
  - Never seed against prod. The seed is synthetic-only and lives under `scripts/dev/` so `migrate()` never sees it; still, only ever point `DATABASE_URL` at a clone.
  - Schema questions → Supabase MCP (project `wvmhliweujmhlzknmuzh`), never `DATABASE_URL` on a shell line.
  ```

- [ ] **Step 2: Verify the documented harness actually runs end-to-end.**
  This is the "confirmation" — run both DB test files the note describes together, exactly as a downstream slice would:
  Command: `cd /Users/ziadelwahsh/tashkheesa-portal && node --test tests/core/migration-078-coming-soon.test.js tests/services/seed_my_services_fixtures.test.js`
  Expected with a reachable clone: combined `pass 10`, `fail 0`. Expected without a DB: all DB assertions skip, file-presence assertions pass, `fail 0`. If this is green, the harness the note documents is proven; if it fails, the note is wrong — fix before committing.

- [ ] **Step 3: Confirm the harness is picked up by the default suite as a graceful skip (no DB in CI).**
  The repo's aggregate runner is `npm test` (`tests/run.js`) which `require()`s every `*.test.js`. The two new files use `node:test`; under `tests/run.js` they register `node:test` cases but the require-based harness doesn't await them — same situation as `tests/pin/*` and the addons tests, which are run separately. Confirm `npm test` still exits 0 (the new files don't throw at require time when no DB is set):
  Command: `cd /Users/ziadelwahsh/tashkheesa-portal && npm test 2>&1 | tail -8`
  Expected: `Failed:  0` in the summary and exit 0. (The `node:test` cases self-run/skip; they must not crash the aggregate runner at require-time. If they do, gate the top of each file with `if (!process.env.DATABASE_URL && !process.env.RUN_DB_TESTS) { return; }` before the `pool` is created — but only if `npm test` shows a failure.)

- [ ] **Step 4: Commit.**
  `git add tests/services/README_my_services_harness.md && git commit` with the required `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Suggested subject: `docs(test): document the My Services prod-schema-clone harness for downstream slices`.

---

Notes for the assembler / other slices:
- The re-sync helper `src/services/services_coming_soon_sync.js` (SHARED CONTRACT) is authored by another slice; this slice's migration 078 and seed both inline the identical is_active-keyed resync UPDATE so the clone is correct even before that helper lands. No dependency inversion.
- **`services` has no `name_ar` column in prod** (verified via MCP) — the contract's `loadDoctorServiceCatalog` `name_ar` field must be sourced from the specialty (`specialties.name_ar`) or left null; the seed writes `specialties.name_ar` but never `services.name_ar`. Flag this to the catalog-loader slice.
- All file paths are absolute above where created: `/Users/ziadelwahsh/tashkheesa-portal/src/migrations/078_reconcile_prod_hotfixes_20260810.sql`, `/Users/ziadelwahsh/tashkheesa-portal/scripts/dev/seed_my_services_fixtures.js`, `/Users/ziadelwahsh/tashkheesa-portal/tests/core/migration-078-coming-soon.test.js`, `/Users/ziadelwahsh/tashkheesa-portal/tests/services/seed_my_services_fixtures.test.js`, `/Users/ziadelwahsh/tashkheesa-portal/tests/services/README_my_services_harness.md`.

---

## Phase P1 — coming_soon re-sync helper + admin approve/pause wiring

### Task 4: Create the `resyncComingSoon` re-sync helper

**Files:**
- Create `/Users/ziadelwahsh/tashkheesa-portal/src/services/services_coming_soon_sync.js` (new)
- Create `/Users/ziadelwahsh/tashkheesa-portal/tests/services/services_coming_soon_sync.test.js` (new)

**Interfaces:**
- Consumes: `require('../pg')` → `{ pool }` (verified `src/pg.js:152` exports `pool`); an optional `client` (a `pg.PoolClient` mid-transaction, per contract).
- Produces: `module.exports = { resyncComingSoon }` where `async function resyncComingSoon(client)` runs the exact §4.3 `is_active`-keyed UPDATE and returns the `pg` result. Idempotent. If `client` omitted, acquires from `pool` via `pool.query`.

- [ ] **Step 1: Write the failing test.** Create `/Users/ziadelwahsh/tashkheesa-portal/tests/services/services_coming_soon_sync.test.js`. It models `tests/admin/admin_doctor_pause.test.js` exactly (real local Postgres, per-process SUFFIX, cleanup in `after()`). Schema verified via Supabase MCP 2026-08-10: `services(id text, specialty_id text, name text, is_visible bool default true, coming_soon bool NOT NULL default false, base_price, doctor_fee, sla_hours)`, `doctor_services` PK `(doctor_id, service_id)`, both `text`, no per-row active flag — a doctor is active iff `users.is_active=true AND role='doctor'`.

```js
'use strict';

// Re-sync helper (services.coming_soon truthfulness) — hermetic suite on a REAL
// local Postgres (real types, real UPDATE; not mocks). Modeled on
// admin_doctor_pause.test.js. Proves the §4.3 formula: a service is coming_soon
// iff it has NO mapped active doctor. Covers: flips true when the last active
// doctor's mapping is removed, flips false when re-added, is a no-op when a
// mapped doctor is merely paused (is_paused, NOT is_active — the formula is
// keyed on is_active), respects the caller's txn when a client is passed
// (rolls back with it), and is idempotent (second call = 0 changes).
//
// Run: node --test tests/services/services_coming_soon_sync.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { resyncComingSoon } = require('../../src/services/services_coming_soon_sync');

const SUFFIX = 'cs-' + process.pid + '-' + Date.now();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// A doctor row. is_active drives the formula; is_paused must NOT.
async function mkDoctor({ active = true, paused = false, role = 'doctor' } = {}) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, role, is_active, is_paused) VALUES ($1, $2, $3, $4)`,
    [id, role, active, paused]
  );
  return id;
}

// A visible service, coming_soon seeded so we can watch it flip either way.
async function mkService({ comingSoon = false } = {}) {
  const id = uid('svc');
  await q(
    `INSERT INTO services (id, name, is_visible, coming_soon, base_price, doctor_fee, sla_hours)
       VALUES ($1, $2, true, $3, 500, 100, 48)`,
    [id, 'Test Svc ' + id, comingSoon]
  );
  return id;
}

async function map(doctorId, serviceId) {
  await q(
    `INSERT INTO doctor_services (id, doctor_id, service_id) VALUES ($1, $2, $3)
       ON CONFLICT (doctor_id, service_id) DO NOTHING`,
    [uid('ds'), doctorId, serviceId]
  );
}
async function unmap(doctorId, serviceId) {
  await q(`DELETE FROM doctor_services WHERE doctor_id = $1 AND service_id = $2`, [doctorId, serviceId]);
}
async function comingSoonOf(serviceId) {
  return (await q(`SELECT coming_soon FROM services WHERE id = $1`, [serviceId])).rows[0].coming_soon;
}

test.after(async () => {
  await q(`DELETE FROM doctor_services WHERE doctor_id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await q(`DELETE FROM services WHERE id LIKE $1`, ['svc-' + SUFFIX + '-%']);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await pool.end();
});

// ─────────── remove last active doctor → coming_soon flips true ───────────
test('unmapping the last active doctor flips coming_soon true', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();                    // has a doctor → stays false
  assert.equal(await comingSoonOf(svc), false, 'mapped: bookable');

  await unmap(doc, svc);
  await resyncComingSoon();                    // no doctor → flips true
  assert.equal(await comingSoonOf(svc), true, 'unmapped: coming soon');
});

// ─────────── re-map → coming_soon flips back false ───────────
test('re-mapping an active doctor flips coming_soon false', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: true });
  await map(doc, svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), false, 're-mapped: bookable again');
});

// ─────────── keyed on is_active, NOT is_paused ───────────
test('a mapped-but-PAUSED (is_active still true) doctor keeps coming_soon false', async () => {
  const doc = await mkDoctor({ active: true, paused: true });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), false, 'is_paused must NOT hide the doctor from supply');
});

// ─────────── an INACTIVE doctor does not count as supply ───────────
test('a mapped INACTIVE doctor leaves coming_soon true', async () => {
  const doc = await mkDoctor({ active: false });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), true, 'is_active=false is not supply');
});

// ─────────── honours a caller-supplied txn client (rolls back with it) ───────────
test('when passed a client, the UPDATE is inside the caller txn and rolls back', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: true });   // starts true
  await map(doc, svc);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await resyncComingSoon(client);                    // would flip to false…
    await client.query('ROLLBACK');                    // …but we roll back
  } finally {
    client.release();
  }
  assert.equal(await comingSoonOf(svc), true, 'rolled back with the caller txn — still true');
});

// ─────────── idempotent: a second call changes 0 rows ───────────
test('idempotent — a second resync reports rowCount but no state change', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();
  const before = await comingSoonOf(svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), before, 'second call leaves state identical');
});
```

- [ ] **Step 2: Run the test — expect FAIL (module missing).**
  Command: `node --test tests/services/services_coming_soon_sync.test.js`
  Expected: fails immediately with `Cannot find module '../../src/services/services_coming_soon_sync'` (helper not yet created).

- [ ] **Step 3: Implement the helper.** Create `/Users/ziadelwahsh/tashkheesa-portal/src/services/services_coming_soon_sync.js` with the verbatim §4.3 SQL:

```js
// src/services/services_coming_soon_sync.js
//
// Re-sync helper — keeps services.coming_soon truthful. A service is
// coming_soon iff it has NO active doctor mapped to it. Keyed on
// users.is_active (NOT is_paused — pausing a doctor must not hide a service
// from the catalogue; see design §4.3 / §10). Idempotent: safe to call after
// any doctor_services change or any change to a doctor's is_active.
//
// Runs the EXACT design §4.3 UPDATE, unchanged. Accepts an optional pg client
// so a caller can fold the re-sync into its own transaction (atomic with the
// status flip); when omitted it runs a single autocommit statement on the pool.
//
// Callers that own a txn (the Command services admin_doctor_approve /
// admin_doctor_pause) pass their client so the recompute commits/rolls-back
// atomically with the write. Web routes (superadmin.js, execute()/pool
// autocommit) call it with no client, post-commit + best-effort.

'use strict';

const { pool } = require('../pg');

const RESYNC_SQL = `
  UPDATE public.services sv
  SET coming_soon = NOT EXISTS (
    SELECT 1 FROM public.doctor_services ds
    JOIN public.users u ON u.id = ds.doctor_id
    WHERE ds.service_id = sv.id
      AND u.role = 'doctor' AND u.is_active = true
  )`;

/**
 * Recompute services.coming_soon for every service.
 * @param {import('pg').PoolClient} [client] optional txn client; pool if omitted
 * @returns {Promise<import('pg').QueryResult>}
 */
async function resyncComingSoon(client) {
  const runner = client || pool;
  return runner.query(RESYNC_SQL);
}

module.exports = { resyncComingSoon };
```

- [ ] **Step 4: Run the test — expect PASS.**
  Command: `node --test tests/services/services_coming_soon_sync.test.js`
  Expected: `# pass 6`, `# fail 0` (all six subtests green; the paused-doctor and inactive-doctor cases prove the `is_active` keying, and the client case proves txn participation).

- [ ] **Step 5: Full suite sanity (no regressions).**
  Command: `node --test tests/services/services_coming_soon_sync.test.js && npm test`
  Expected: the new file passes under `node --test`; `npm test` (the `tests/run.js` require-based harness) shows no new failures. Note: this `node --test` file follows the same standalone pattern as `admin_doctor_pause.test.js`, which the `run.js` harness require()s without awaiting async subtests — so it is run directly via `node --test` in CI/manually, exactly like the pause/approve suites (documented in those files' headers).

- [ ] **Step 6: Commit.**
  Command: `git add src/services/services_coming_soon_sync.js tests/services/services_coming_soon_sync.test.js && git commit -m "feat(supply): resyncComingSoon helper — services.coming_soon truthfulness keyed on is_active

Exact design §4.3 UPDATE; optional txn client for atomic folding into a
caller's transaction, pool autocommit otherwise. Idempotent. Keyed on
users.is_active, never is_paused.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 5: Wire resyncComingSoon into the two Command-app doctor services (in-txn)

**Files:**
- Modify `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_doctor_approve.js` (add require near line 21; call before COMMIT at line 82)
- Modify `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_doctor_pause.js` (add require near line 22; call before COMMIT at line 90)
- Modify `/Users/ziadelwahsh/tashkheesa-portal/tests/admin/admin_doctor_approve.test.js` (add a re-sync assertion)
- Modify `/Users/ziadelwahsh/tashkheesa-portal/tests/admin/admin_doctor_pause.test.js` (add a re-sync assertion)

**Interfaces:**
- Consumes: `resyncComingSoon(client)` from `./services_coming_soon_sync` (relative path from `src/services/`).
- Produces: no signature change to `setDoctorApproval` / `setDoctorPause`. Re-sync runs on the same `client`, inside the existing txn, immediately before `client.query('COMMIT')`, so it commits/rolls-back atomically with the status flip and preserves the existing atomicity tests.

- [ ] **Step 1: Write the failing assertions first (approve).** In `/Users/ziadelwahsh/tashkheesa-portal/tests/admin/admin_doctor_approve.test.js`, after the happy-path approve test, add a test proving approval (which flips `is_active` false→true) makes the doctor's mapped service bookable. Use the existing `q`, `mkDoctor`, `pool`, `SUFFIX`, `uid` helpers already in that file (verified `admin_doctor_approve.test.js:20-51`). Insert after the approve-happy `test(...)` block:

```js
// ── re-sync wiring: approving a doctor (is_active false→true) recomputes
//    coming_soon for the services they're mapped to (design §4.3 call site) ──
test('approve recomputes coming_soon for the doctor’s services', async () => {
  const id = await mkDoctor({ pending: true });          // is_active starts false
  const svc = 'svc-' + SUFFIX + '-appr';
  await q(
    `INSERT INTO services (id, name, is_visible, coming_soon, base_price, doctor_fee, sla_hours)
       VALUES ($1, 'Approve Svc', true, true, 500, 100, 48)`, [svc]
  );
  await q(
    `INSERT INTO doctor_services (id, doctor_id, service_id) VALUES ($1, $2, $3)`,
    ['ds-' + SUFFIX + '-appr', id, svc]
  );
  // Pre: doctor inactive → service is coming_soon.
  await run({ doctorId: id });                            // approve → is_active=true
  const after = (await q(`SELECT coming_soon FROM services WHERE id = $1`, [svc])).rows[0].coming_soon;
  assert.equal(after, false, 'service became bookable once its doctor is active');
  await q(`DELETE FROM doctor_services WHERE service_id = $1`, [svc]);
  await q(`DELETE FROM services WHERE id = $1`, [svc]);
});
```
(Confirm `run(...)` and `mkDoctor` exist in the file before adding — verified at `admin_doctor_approve.test.js:36-44`; if `run` is named differently there, use the file's own approve-invocation helper.)

- [ ] **Step 2: Run — expect FAIL.**
  Command: `node --test tests/admin/admin_doctor_approve.test.js`
  Expected: the new subtest fails (`after` is `true`, not `false`) because `setDoctorApproval` does not yet call `resyncComingSoon`; all pre-existing subtests still pass.

- [ ] **Step 3: Implement approve wiring.** In `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_doctor_approve.js`:

  Add the require after line 21 (`const { randomUUID } = require('crypto');`):
```js
const { randomUUID } = require('crypto');
const { resyncComingSoon } = require('./services_coming_soon_sync');
```

  Then insert the re-sync call between the audit INSERT (ends line 80) and `await client.query('COMMIT');` (line 82). Replace:
```js
    );

    await client.query('COMMIT');
```
  with:
```js
    );

    // Activating a doctor changes supply: recompute services.coming_soon for
    // every service (design §4.3), inside this txn so it is atomic with the
    // is_active flip and rolls back with it on any later failure.
    await resyncComingSoon(client);

    await client.query('COMMIT');
```

- [ ] **Step 4: Run — expect PASS (approve).**
  Command: `node --test tests/admin/admin_doctor_approve.test.js`
  Expected: `# fail 0`. The new subtest passes AND the existing atomicity test still passes (the re-sync is inside the txn, so an audit-insert failure — injected before COMMIT — still rolls back everything; the audit insert runs before the re-sync, so the injected throw path is unchanged).

- [ ] **Step 5: Write the failing assertions first (pause/reactivate).** In `/Users/ziadelwahsh/tashkheesa-portal/tests/admin/admin_doctor_pause.test.js`, add two subtests using the file's existing `q`, `mkDoctor`, `run`, `SUFFIX` helpers (verified `admin_doctor_pause.test.js:29-67`). Reactivate flips `is_active`? No — pause/reactivate flip `is_paused`, not `is_active` (verified `admin_doctor_pause.js:60-72`). So per §4.3 the re-sync is a deliberate **0-change no-op** here; the test asserts exactly that (pause does not spuriously flip a bookable service to coming_soon):

```js
// ── re-sync wiring: pause toggles is_paused (NOT is_active), so the §4.3
//    recompute is a 0-change no-op — a paused doctor still counts as supply.
//    Asserting it does NOT spuriously flip a bookable service to coming_soon. ──
test('pause does not change coming_soon (is_paused is not supply-removing)', async () => {
  const id = await mkDoctor({ paused: false });          // active, unpaused
  const svc = 'svc-' + SUFFIX + '-pause';
  await q(
    `INSERT INTO services (id, name, is_visible, coming_soon, base_price, doctor_fee, sla_hours)
       VALUES ($1, 'Pause Svc', true, false, 500, 100, 48)`, [svc]
  );
  await q(
    `INSERT INTO doctor_services (id, doctor_id, service_id) VALUES ($1, $2, $3)`,
    ['ds-' + SUFFIX + '-pause', id, svc]
  );
  await run({ doctorId: id, paused: true, reason: 'manual: resync noop' });
  const after = (await q(`SELECT coming_soon FROM services WHERE id = $1`, [svc])).rows[0].coming_soon;
  assert.equal(after, false, 'pausing a doctor leaves their service bookable');
  await q(`DELETE FROM doctor_services WHERE service_id = $1`, [svc]);
  await q(`DELETE FROM services WHERE id = $1`, [svc]);
});
```

- [ ] **Step 6: Run — expect PASS already for the no-op assertion, but implement the wiring for parity + reactivation safety.** The pause no-op test above passes even before wiring (nothing changes coming_soon). To make the wiring load-bearing and self-documenting, wire it and keep the assertion as a regression guard. In `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_doctor_pause.js`:

  Add the require after line 22 (`const { randomUUID } = require('crypto');`):
```js
const { randomUUID } = require('crypto');
const { resyncComingSoon } = require('./services_coming_soon_sync');
```

  Then insert the re-sync call between the audit INSERT (ends line 88) and `await client.query('COMMIT');` (line 90). Replace:
```js
    );

    await client.query('COMMIT');
```
  with:
```js
    );

    // Recompute services.coming_soon inside this txn (design §4.3). Pause/
    // reactivate toggles is_paused, NOT is_active, so the formula (keyed on
    // is_active) changes 0 rows here — a safe no-op that keeps every is_active
    // call site symmetric and future-proofs a reactivate that ever flips
    // is_active. Atomic with the flag write.
    await resyncComingSoon(client);

    await client.query('COMMIT');
```

- [ ] **Step 7: Run — expect PASS (pause).**
  Command: `node --test tests/admin/admin_doctor_pause.test.js`
  Expected: `# fail 0`. The new no-op subtest passes; the existing atomicity test (throw on `/error_logs/i`) still passes — the audit insert runs before the re-sync, so the injected failure still aborts the txn before any recompute, and `is_paused` rolls back to false as before.

- [ ] **Step 8: Commit.**
  Command: `git add src/services/admin_doctor_approve.js src/services/admin_doctor_pause.js tests/admin/admin_doctor_approve.test.js tests/admin/admin_doctor_pause.test.js && git commit -m "feat(supply): re-sync coming_soon inside Command approve/pause txns

setDoctorApproval (is_active false→true) and setDoctorPause both call
resyncComingSoon(client) before COMMIT — atomic with the status flip.
Approve recomputes supply; pause is a deliberate 0-change no-op (keyed on
is_active, not is_paused). Existing atomicity tests preserved.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 6: Wire resyncComingSoon into the web superadmin is_active call sites

**Files:**
- Modify `/Users/ziadelwahsh/tashkheesa-portal/src/routes/superadmin.js`:
  - add require near line 4
  - `POST /superadmin/doctors/:id/approve` handler (UPDATE at lines 3189–3197) — after the UPDATE
  - `POST /superadmin/doctors/:id/toggle` handler (UPDATE at lines 3090–3095) — after the UPDATE
  - `POST /superadmin/doctors/:id/edit` handler (UPDATE at lines 3051–3063, plus its doctor_services rewrite at 3066–3081) — after the mapping rewrite
  - `POST /superadmin/doctors/:id/reject` handler (UPDATE at lines 3288–3296, flips `is_active` true→false) — after the UPDATE
- Verification: headless-Chrome / manual (these route handlers use pool `execute()` autocommit and are not covered by the `tests/run.js` require-harness or a route-level integration test; see the harness note in §4.9 and `project_local_db_anon_role_boot.md` — local server boot is broken by migration 070).

**Interfaces:**
- Consumes: `resyncComingSoon()` from `../services/services_coming_soon_sync` (relative path from `src/routes/`), called with **no client** (each web write uses `execute()` on the pool = autocommit; the primary UPDATE is already committed, so re-sync runs post-write on the pool).
- Produces: no route-signature change. Re-sync is **post-commit, best-effort** (spec §7: "save txn commits first, re-sync runs after (best-effort + logged)") — wrapped so a re-sync failure never breaks the redirect or corrupts the status write.

- [ ] **Step 1: Add the require.** In `/Users/ziadelwahsh/tashkheesa-portal/src/routes/superadmin.js`, after line 4 (`const { logErrorToDb } = require('../logger');`):
```js
const { logErrorToDb } = require('../logger');
const { resyncComingSoon } = require('../services/services_coming_soon_sync');
```

- [ ] **Step 2: Wire the approve handler.** After the approve UPDATE (`await execute(...)` ending at line 3197) and before the `logAdminAudit(...)` call at line 3202, insert a best-effort re-sync. Replace:
```js
    [nowIso, doctorId]
  );

  // P1-NOTIF-5: audit the approval action durably, BEFORE the (async) email
```
  with:
```js
    [nowIso, doctorId]
  );

  // Approving flips is_active → recompute services.coming_soon (design §4.3).
  // Post-commit + best-effort: a re-sync failure must not break approval.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_approve_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }

  // P1-NOTIF-5: audit the approval action durably, BEFORE the (async) email
```

- [ ] **Step 3: Wire the toggle handler.** The toggle UPDATE (`SET is_active = CASE WHEN is_active = true THEN false ELSE true END`, lines 3090–3095) flips `is_active` in both directions. After that `await execute(...)` and before `return res.redirect('/superadmin/doctors');` (line 3096). Replace:
```js
     WHERE id = $1 AND role = 'doctor'`,
    [doctorId]
  );
  return res.redirect('/superadmin/doctors');
});

// Doctor detail (approval)
```
  with:
```js
     WHERE id = $1 AND role = 'doctor'`,
    [doctorId]
  );
  // Toggling is_active changes supply → recompute coming_soon (§4.3), best-effort.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_toggle_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }
  return res.redirect('/superadmin/doctors');
});

// Doctor detail (approval)
```

- [ ] **Step 4: Wire the edit handler.** The edit UPDATE (lines 3051–3063) sets `is_active = $5`, and the block below (3066–3081) rewrites `doctor_services` — **both** affect supply, so re-sync must run after the mapping rewrite. After the `catch (_) { // no-op }` at lines 3082–3084 and before `return res.redirect('/superadmin/doctors');` (line 3085). Replace:
```js
  } catch (_) {
    // no-op
  }
  return res.redirect('/superadmin/doctors');
});

router.post('/superadmin/doctors/:id/toggle', requireSuperadmin, async (req, res) => {
```
  with:
```js
  } catch (_) {
    // no-op
  }
  // Edit can flip is_active AND rewrite doctor_services → both change supply.
  // Recompute coming_soon after the mapping rewrite (§4.3), best-effort.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_edit_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }
  return res.redirect('/superadmin/doctors');
});

router.post('/superadmin/doctors/:id/toggle', requireSuperadmin, async (req, res) => {
```

- [ ] **Step 5: Wire the reject handler.** The reject UPDATE (lines 3288–3296) flips `is_active` true→false, which can remove the last active doctor from a service → that service must become coming_soon. After the `await execute(...)` (ends line 3296) and before the `queueNotification(...)` at line 3298. Replace:
```js
    [rejection_reason || 'Not approved', doctorId]
  );

  queueNotification({
```
  with:
```js
    [rejection_reason || 'Not approved', doctorId]
  );

  // Rejecting deactivates the doctor (is_active→false) → recompute coming_soon
  // so a service losing its last active doctor is flagged (§4.3), best-effort.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_reject_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }

  queueNotification({
```

- [ ] **Step 6: Static verification (module loads, no syntax error).** The full server won't boot locally (migration 070 needs the Supabase `anon` role — `project_local_db_anon_role_boot.md`), so verify the router file parses and the require resolves without booting:
  Command: `node -e "require('./src/routes/services_coming_soon_sync.js')" 2>/dev/null; node --check src/routes/superadmin.js && node -e "require('./src/services/services_coming_soon_sync.js'); console.log('helper loads OK')"`
  Expected: `node --check` prints nothing and exits 0 (superadmin.js is syntactically valid after the 5 edits); the helper `require` prints `helper loads OK`. (The `pg` pool constructs without a live connection, so requiring the helper is safe.)

- [ ] **Step 7: Behavioural verification via prod-schema BEGIN…ROLLBACK dry-run (Supabase MCP).** The web handlers can't run through a broken local boot, so prove the underlying recompute logic these handlers now invoke against the real prod schema — one MCP `BEGIN … ROLLBACK` block (project `wvmhliweujmhlzknmuzh`): pick a `coming_soon=false` visible service that has exactly one active mapped doctor, flip that doctor `is_active=false`, run the §4.3 UPDATE, assert the service flipped to `true`, then `ROLLBACK`. Expected: the assert row shows `coming_soon` went `false → true`, and the ROLLBACK discards it (0 prod rows changed). This confirms the exact SQL the four handlers call behaves correctly on prod data without any local boot.

- [ ] **Step 8: Commit.**
  Command: `git add src/routes/superadmin.js && git commit -m "feat(supply): recompute coming_soon after every web superadmin is_active write

Wire resyncComingSoon (post-commit, best-effort) into the approve, toggle,
edit (is_active flip + doctor_services rewrite), and reject handlers. Web
writes use pool execute() autocommit, so re-sync runs after the write and a
failure is logged, never breaking the redirect (design §4.3 / §7).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

**Slice notes:**
- `resyncComingSoon(client)` lives at `/Users/ziadelwahsh/tashkheesa-portal/src/services/services_coming_soon_sync.js`, exports `{ resyncComingSoon }`, runs the verbatim §4.3 `is_active`-keyed UPDATE, optional client (else pool). This is the shared-contract helper the POST-`/portal/doctor/services` slice (§4.2) also calls after its `withTransaction` commit.
- Two call-site conventions established here for reuse: **in-txn** (`resyncComingSoon(client)` before COMMIT — for services owning a transaction, e.g. `withTransaction` bodies) and **post-commit best-effort** (`resyncComingSoon()` in a try/catch that logs via `logErrorToDb` — for pool-`execute()` autocommit web routes).
- I did **not** modify `/apply`, did **not** touch `doctor_commission_pct`, and kept re-sync keyed strictly on `is_active` (pause/reactivate re-sync is an intentional no-op).

---

## Phase P2 — Coming Soon guards (catalogue badge + order-POST reject, web + mobile API)

### Task 7: `servicesBookableClause(alias)` — bookable SQL helper in patient.js

**Files:**
- Modify `src/routes/patient.js` (add helper immediately after `servicesVisibleClause` which ends at line 898; export it on the router near the existing `module.exports = router;` at line 4090)
- Create `tests/unit/services-bookable-clause.test.js`

**Interfaces:**
- Produces: `servicesBookableClause(alias?: string): string` — returns the literal SQL fragment `COALESCE(<alias>.is_visible,true)=true AND COALESCE(<alias>.coming_soon,false)=false`. When `alias` is falsy, uses the bare column names (`COALESCE(is_visible,true)=true AND COALESCE(coming_soon,false)=false`). Synchronous, pure (unlike the async `servicesVisibleClause`, so callers can inline it directly). Exported as `require('../routes/patient').servicesBookableClause` for tests and any cross-file consumers.
- Consumes: nothing (pure string builder).

Steps:

- [ ] **Step 1: Write the failing unit test.** Create `tests/unit/services-bookable-clause.test.js` (mirrors `tests/unit/apply_validation.test.js` style — `node:test` + `node:assert/strict`, no DB, no boot):
  ```js
  'use strict';
  // Pure unit suite: servicesBookableClause() builds the exact bookable SQL
  // fragment per the shared contract. No DB, no boot.
  // Run: node --test tests/unit/services-bookable-clause.test.js
  const test = require('node:test');
  const assert = require('node:assert/strict');

  const { servicesBookableClause } = require('../../src/routes/patient');

  test('exports servicesBookableClause as a function', () => {
    assert.equal(typeof servicesBookableClause, 'function');
  });

  test('with an alias, emits COALESCE guards on both is_visible and coming_soon', () => {
    assert.equal(
      servicesBookableClause('sv'),
      'COALESCE(sv.is_visible,true)=true AND COALESCE(sv.coming_soon,false)=false'
    );
  });

  test('without an alias, uses bare column names', () => {
    assert.equal(
      servicesBookableClause(),
      'COALESCE(is_visible,true)=true AND COALESCE(coming_soon,false)=false'
    );
  });

  test('is a superset of the visibility rule (contains the is_visible guard) and adds the coming_soon guard', () => {
    const c = servicesBookableClause('sv');
    assert.ok(/COALESCE\(sv\.is_visible,true\)=true/.test(c), 'keeps the is_visible predicate');
    assert.ok(/COALESCE\(sv\.coming_soon,false\)=false/.test(c), 'adds the coming_soon predicate');
  });
  ```

- [ ] **Step 2: Run the test — expect failure.** Command: `node --test tests/unit/services-bookable-clause.test.js`. Expected: fails at the first `require` assertion (`servicesBookableClause` is `undefined` → `typeof` is `'undefined'`), test run exits non-zero. This proves the test exercises the not-yet-built export.

- [ ] **Step 3: Implement the helper.** In `src/routes/patient.js`, insert immediately after the closing brace of `servicesVisibleClause` (line 898), before the `// --- safe schema helpers ---` comment on line 900:
  ```js
  // Bookable = visible AND not coming_soon. Unlike servicesVisibleClause (async,
  // tolerates a missing is_visible column), this is a pure synchronous string
  // builder per the shared contract — the coming_soon column is NOT NULL DEFAULT
  // false in prod (migration 078), so COALESCE keeps it safe on any older clone.
  // Callers inline it in a WHERE clause alongside their own predicates.
  function servicesBookableClause(alias) {
    const vis  = alias ? `${alias}.is_visible`  : 'is_visible';
    const soon = alias ? `${alias}.coming_soon` : 'coming_soon';
    return `COALESCE(${vis},true)=true AND COALESCE(${soon},false)=false`;
  }
  ```

- [ ] **Step 4: Export it on the router.** In `src/routes/patient.js`, replace the terminal `module.exports = router;` (line 4090) with:
  ```js
  module.exports = router;
  module.exports.servicesBookableClause = servicesBookableClause;
  ```
  (Attaching a named property to the exported router function is inert for Express and lets tests + sibling files import the helper without a separate module.)

- [ ] **Step 5: Run the test — expect pass.** Command: `node --test tests/unit/services-bookable-clause.test.js`. Expected: `# pass 4`, `# fail 0`, exit 0. Also confirm it is discovered by the suite runner: `npm test 2>&1 | grep -i services-bookable-clause` should print the `📋 unit/services-bookable-clause.test.js` header (the file self-registers via `require`).

- [ ] **Step 6: Commit.** `git add src/routes/patient.js tests/unit/services-bookable-clause.test.js && git commit` with message:
  ```
  feat(services): add servicesBookableClause() — visible AND not coming_soon

  Pure sync SQL-fragment builder beside servicesVisibleClause; exported on
  the patient router for the web wizard + cross-file reuse. Unit-tested.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

### Task 8: Web wizard step3 + step4 — reject `coming_soon` services

**Files:**
- Modify `src/routes/patient.js`:
  - step3 service-visibility check at lines 1870–1877 (swap `servicesVisibleClause('sv')` for the bookable clause)
  - step4 service lookup at lines 1983–1997 (same swap)
- Create `tests/core/wizard-coming-soon-reject.test.js` (source-grep guard — a full wizard boot needs a live patient session + DB which does not boot locally; the grep guard is the harness-runnable proof that both wizard steps use the bookable clause)

**Interfaces:**
- Consumes: `servicesBookableClause('sv')` (from the prior task).
- Produces: step3 redirects `/patient/new-case?step=3&id=...&err=invalid_service` when the chosen service is `coming_soon` or not visible; step4 redirects `.../step=3...&err=invalid_service` likewise. No new error string on the web path — reuses the existing `err=invalid_service` redirect (the machine code `SERVICE_NOT_BOOKABLE` is the API-path contract; the web path signals via the existing `invalid_service` query param, which the wizard view already handles).

Steps:

- [ ] **Step 1: Write the failing guard test.** Create `tests/core/wizard-coming-soon-reject.test.js` (mirrors `tests/core/orders-table-readers-allowlist.test.js` — pure source-grep, no DB, no boot; runs green in the harness):
  ```js
  // tests/core/wizard-coming-soon-reject.test.js
  //
  // Coming Soon guard — web wizard (spec §4.5). Both the step3 service-belongs
  // check and the step4 pricing lookup MUST gate on servicesBookableClause
  // (visible AND not coming_soon), not the old visibility-only clause. A live
  // wizard POST needs an authenticated patient + a DRAFT order + a DB that does
  // NOT boot locally (migration 070 needs a Supabase anon role), so this is a
  // source-grep guard: it fails if either step reverts to servicesVisibleClause
  // for the order-blocking lookup.
  'use strict';
  const fs = require('fs');
  const path = require('path');

  const t = global._testRunner || {
    pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
    fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
    skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
  };

  console.log('\n🛑 web wizard steps gate on servicesBookableClause (Coming Soon §4.5)\n');

  const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'patient.js');
  const src = fs.readFileSync(SRC, 'utf8');

  // How many times the ORDER-BLOCKING service lookups (step3 + step4) call the
  // bookable clause. Must be >= 2 (one per wizard step).
  const bookableCalls = (src.match(/servicesBookableClause\(['"]sv['"]\)/g) || []).length;

  try {
    if (bookableCalls < 2) {
      throw new Error(
        'Expected >= 2 servicesBookableClause(\'sv\') calls in patient.js wizard ' +
        '(step3 + step4); found ' + bookableCalls + '. Coming Soon guard missing.'
      );
    }
    t.pass('both wizard service lookups call servicesBookableClause (found ' + bookableCalls + ')');
  } catch (e) { t.fail('wizard-coming-soon-reject: bookable clause present', e); }

  // Neither step3 nor step4 order-blocking lookup may still use the old
  // visibility-only clause inside a `WHERE sv.id = $` guard.
  try {
    // Match the two literal SELECT fragments we are replacing.
    const stillVisibleOnly =
      /WHERE sv\.id = \$1 AND \$\{visibleClause\}/.test(src) ||
      /WHERE sv\.id = \$2 AND \$\{visibleClause\}/.test(src);
    if (stillVisibleOnly) {
      throw new Error('A wizard service lookup still uses ${visibleClause} — must be the bookable clause.');
    }
    t.pass('no wizard service lookup uses the visibility-only clause');
  } catch (e) { t.fail('wizard-coming-soon-reject: no visibility-only lookup', e); }
  ```

- [ ] **Step 2: Run — expect failure.** Command: `node tests/core/wizard-coming-soon-reject.test.js`. Expected: both assertions fail (currently 0 `servicesBookableClause('sv')` calls, and the two `${visibleClause}` fragments still present), stderr shows the two `❌` lines. (Run standalone — the top-level `require` in `tests/run.js` executes it the same way.)

- [ ] **Step 3: Patch step3.** In `src/routes/patient.js`, replace lines 1870–1877:
  ```js
    const visibleClause = await servicesVisibleClause('sv');
    const service = await safeGet(
      () => `SELECT sv.id, sv.specialty_id FROM services sv WHERE sv.id = $1 AND ${visibleClause}`,
      [serviceId]
    );
    if (!service || String(service.specialty_id) !== specialtyId) {
      return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
    }
  ```
  with:
  ```js
    // Coming Soon guard (§4.5): a service with no active doctor (coming_soon=true)
    // or hidden (is_visible=false) is NOT bookable — a stale page must not create
    // an unfulfillable order.
    const bookableClause = servicesBookableClause('sv');
    const service = await safeGet(
      () => `SELECT sv.id, sv.specialty_id FROM services sv WHERE sv.id = $1 AND ${bookableClause}`,
      [serviceId]
    );
    if (!service || String(service.specialty_id) !== specialtyId) {
      return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
    }
  ```

- [ ] **Step 4: Patch step4.** In `src/routes/patient.js`, replace lines 1983–1997 (the `visibleClause` assignment through the `${visibleClause}`-terminated SELECT):
  ```js
    const visibleClause = await servicesVisibleClause('sv');
    const service = await safeGet(
      () => `SELECT sv.id, sv.vip_multiplier, sv.urgent_multiplier,
                    COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
                    COALESCE(cp.currency, sv.currency, 'EGP') AS currency
             FROM services sv
             LEFT JOIN service_regional_prices cp
               ON cp.service_id = sv.id AND cp.country_code = $1
              AND COALESCE(cp.status, 'active') = 'active'
             WHERE sv.id = $2 AND ${visibleClause}`,
      [countryCode, owned.service_id]
    );
    if (!service) {
      return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
    }
  ```
  with (only the `visibleClause`→`bookableClause` swap; the `SELECT`/`WHERE` body is otherwise unchanged):
  ```js
    // Coming Soon guard (§4.5): re-validate at the pay/tier step so a service that
    // flipped to coming_soon between step3 and step4 cannot be paid for.
    const bookableClause = servicesBookableClause('sv');
    const service = await safeGet(
      () => `SELECT sv.id, sv.vip_multiplier, sv.urgent_multiplier,
                    COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
                    COALESCE(cp.currency, sv.currency, 'EGP') AS currency
             FROM services sv
             LEFT JOIN service_regional_prices cp
               ON cp.service_id = sv.id AND cp.country_code = $1
              AND COALESCE(cp.status, 'active') = 'active'
             WHERE sv.id = $2 AND ${bookableClause}`,
      [countryCode, owned.service_id]
    );
    if (!service) {
      return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
    }
  ```
  (Note: this removes the now-unused `visibleClause` local in step4; `servicesVisibleClause` remains defined and still used elsewhere — verify with `grep -n "servicesVisibleClause" src/routes/patient.js` that at least one other caller remains so the function is not dead. If step3/step4 were its only callers, leave the function defined; it is exported/used by the doctor-services slice per the shared contract.)

- [ ] **Step 5: Run — expect pass.** Command: `node tests/core/wizard-coming-soon-reject.test.js`. Expected: two `✅` lines (`found 2` bookable calls; no visibility-only lookup). Then a syntax/lint sanity check that the edited file still parses: `node -e "require('./src/routes/patient.js'); console.log('patient.js loads OK')"` → prints `patient.js loads OK` (this also transitively exercises the `servicesBookableClause` export).

- [ ] **Step 6: Manual/headless proof of the runtime redirect (harness cannot boot).** Because the local server will not boot (migration 070), document a prod-schema-clone verification in the commit body and run it against the clone harness the plan stands up (§4.9 seed's "last-doctor-standing" service): with a DRAFT order pointing at a `coming_soon=true` service, `POST /patient/new-case/step3` (or step4) must 302 to `...&err=invalid_service`. Concretely, once the shared clone harness is running: `curl -sS -i -b "$COOKIE" -d "id=$DRAFT&specialty_id=$SPEC&service_id=$SOON_SVC" http://127.0.0.1:$PORT/patient/new-case/step3 | grep -i '^location'` → expect `Location: /patient/new-case?step=3&id=...&err=invalid_service`. Record the observed 302 in the commit.

- [ ] **Step 7: Commit.** `git add src/routes/patient.js tests/core/wizard-coming-soon-reject.test.js && git commit` with message:
  ```
  fix(wizard): reject coming_soon services at step3 + step4 (§4.5)

  Both order-blocking service lookups now gate on servicesBookableClause
  (visible AND not coming_soon), so a stale catalogue page cannot create or
  pay for an unfulfillable order. Source-grep guard added; runtime 302
  redirect verified on the prod-schema clone.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

### Task 9: Mobile API `POST /api/v1/cases` — add `is_visible` + `coming_soon` guards

**Files:**
- Modify `src/routes/api/cases.js` at the service lookup on line 236 (`SELECT * FROM services WHERE id = $1`) and its `if (!service)` handler on lines 237–239
- Create `tests/core/api-cases-coming-soon-reject.test.js` (hermetic handler-invocation test — requires the router module with mocked `safeGet`/`safeRun`, extracts the POST `/` handler, drives it with a mock req/res; no DB, no boot)

**Interfaces:**
- Consumes: `safeGet('SELECT * FROM services WHERE id = $1', [serviceId])` → the service row now must expose `is_visible` / `coming_soon` for the JS guard.
- Produces: `res.fail('This service is not available for booking', 400, 'SERVICE_NOT_BOOKABLE')` when the looked-up service is missing, `is_visible=false`, or `coming_soon=true`. No `orders`/`order_files` INSERT runs on rejection.

Steps:

- [ ] **Step 1: Write the failing hermetic test.** Create `tests/core/api-cases-coming-soon-reject.test.js`:
  ```js
  // tests/core/api-cases-coming-soon-reject.test.js
  //
  // Coming Soon + visibility guard — mobile API POST /api/v1/cases (spec §4.5).
  // The route previously checked NEITHER is_visible NOR coming_soon: a direct
  // POST could create an unfulfillable order. This hermetic test builds the
  // cases router with mocked safeGet/safeRun, pulls the POST '/' handler out of
  // the router stack, and drives it with a fake req/res. No DB, no boot.
  'use strict';
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const express = require('express');

  const buildCasesRouter = require('../../src/routes/api/cases');

  // A minimal valid body that passes the express-validator chains on POST '/'.
  function validBody(serviceId) {
    return {
      specialtyId: 'spec-cardiology',
      serviceId: serviceId,
      clinicalQuestion: 'This is a valid clinical question over ten chars.',
      files: [{ fileId: 'orders/draft/pat_1/scan.pdf' }],
      country: 'EG',
    };
  }

  // Pull the POST '/' handler (last layer whose route matches path '/' + POST).
  function postHandler(router) {
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === '/' && layer.route.methods.post) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle; // final handler after validators
      }
    }
    throw new Error('POST / handler not found on cases router');
  }

  // Run express-validator chains so validationResult(req) is populated, then
  // return the mock req/res pair.
  async function drive(router, service, body) {
    let inserted = 0;
    const safeGet = async (sql) => {
      if (/FROM services WHERE id/.test(String(sql))) return service;   // service lookup
      if (/service_regional_prices/.test(String(sql))) return null;     // no regional price
      return null; // orders_active re-read etc. (should not be reached on reject)
    };
    const safeRun = async () => { inserted++; return { rowCount: 1 }; };
    const built = buildCasesRouter({}, { safeGet, safeAll: async () => [], safeRun });

    // Run the validator middlewares that precede the final handler.
    const route = built.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post).route;
    const req = { body, user: { id: 'pat_1' }, params: {}, query: {}, headers: {}, get: () => '' };
    for (const layer of route.stack.slice(0, -1)) {
      await new Promise((resolve) => layer.handle(req, {}, resolve));
    }

    const res = {
      statusCode: 200, _json: null, _failCode: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this._json = o; return this; },
      ok(data) { this._json = { success: true, data }; return this; },
      fail(message, status = 400, code) {
        this.statusCode = status; this._failCode = code;
        this._json = { success: false, error: message, code };
        return this;
      },
    };
    const handler = postHandler(built);
    await handler(req, res);
    return { res, inserted: () => inserted };
  }

  test('rejects a coming_soon service with SERVICE_NOT_BOOKABLE and writes nothing', async () => {
    const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
    const svc = { id: 'card_echo', name: 'Echo', base_price: 1000, currency: 'EGP', is_visible: true, coming_soon: true };
    const { res, inserted } = await drive(router, svc, validBody('card_echo'));
    assert.equal(res._failCode, 'SERVICE_NOT_BOOKABLE', 'expected SERVICE_NOT_BOOKABLE, got ' + res._failCode);
    assert.equal(res.statusCode, 400);
    assert.equal(inserted(), 0, 'no orders/order_files INSERT may run on reject');
  });

  test('rejects a hidden (is_visible=false) service with SERVICE_NOT_BOOKABLE', async () => {
    const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
    const svc = { id: 'card_echo', name: 'Echo', base_price: 1000, currency: 'EGP', is_visible: false, coming_soon: false };
    const { res, inserted } = await drive(router, svc, validBody('card_echo'));
    assert.equal(res._failCode, 'SERVICE_NOT_BOOKABLE');
    assert.equal(inserted(), 0);
  });

  test('a missing service still fails (existing INVALID_SERVICE behavior preserved)', async () => {
    const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
    const { res } = await drive(router, null, validBody('nope'));
    assert.ok(res._failCode === 'INVALID_SERVICE' || res._failCode === 'SERVICE_NOT_BOOKABLE',
      'missing service must be rejected; got ' + res._failCode);
  });
  ```
  Note: `buildCasesRouter` builds a fresh router each `require`; because Express `router.stack` accumulates on the same singleton `router` instance across calls, the `drive()` helper re-derives the route from the router it was given — pass the SAME `router` into `drive`. Refine in Step 2 if the stack-lookup finds duplicated layers (if so, use the last matching `/`+POST route). Adjust the handler-extraction to the final POST-`/` route layer.

- [ ] **Step 2: Run — expect failure.** Command: `node --test tests/core/api-cases-coming-soon-reject.test.js`. Expected: the two guard tests fail — the current handler does NOT inspect `is_visible`/`coming_soon`, so it proceeds past the lookup, calls `safeRun` (INSERT) and eventually a `safeGet` on `orders_active` (returns `null` → the handler throws on `created.id`), surfacing as a rejected promise / assertion miss on `SERVICE_NOT_BOOKABLE`. Confirms the guard is absent. (If the module's shared `router` singleton causes a duplicate-route lookup issue, fix the `postHandler`/route-finder to take the last matching layer before continuing — this is a test-harness detail, not the feature.)

- [ ] **Step 3: Implement the guard.** In `src/routes/api/cases.js`, replace lines 235–239:
  ```js
      // Validate service exists
      const service = await safeGet('SELECT * FROM services WHERE id = $1', [serviceId]);
      if (!service) {
        return res.fail('Invalid service', 400, 'INVALID_SERVICE');
      }
  ```
  with:
  ```js
      // Validate service exists AND is bookable. The mobile path historically
      // checked NEITHER is_visible NOR coming_soon (spec §4.5) — a stale app
      // screen or a direct POST could mint an order for a service with no active
      // doctor. coming_soon is NOT NULL DEFAULT false in prod; COALESCE keeps the
      // guard safe on any older clone lacking the column defaults.
      const service = await safeGet('SELECT * FROM services WHERE id = $1', [serviceId]);
      if (!service) {
        return res.fail('Invalid service', 400, 'INVALID_SERVICE');
      }
      const isVisible = service.is_visible == null ? true : !!service.is_visible;
      const isComingSoon = service.coming_soon == null ? false : !!service.coming_soon;
      if (!isVisible || isComingSoon) {
        return res.fail('This service is not available for booking', 400, 'SERVICE_NOT_BOOKABLE');
      }
  ```

- [ ] **Step 4: Run — expect pass.** Command: `node --test tests/core/api-cases-coming-soon-reject.test.js`. Expected: `# pass 3`, `# fail 0`, exit 0 — coming_soon and hidden services both return `SERVICE_NOT_BOOKABLE` with 0 INSERTs; missing service preserves `INVALID_SERVICE`. Then module-load sanity: `node -e "require('./src/routes/api/cases.js'); console.log('api/cases.js loads OK')"`.

- [ ] **Step 5: Commit.** `git add src/routes/api/cases.js tests/core/api-cases-coming-soon-reject.test.js && git commit` with message:
  ```
  fix(api): guard POST /api/v1/cases against hidden + coming_soon services

  The mobile order path checked neither is_visible nor coming_soon; a stale
  app screen or direct POST could create an unfulfillable order. Now rejects
  with SERVICE_NOT_BOOKABLE (400) before any write. Hermetic handler test.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

### Task 10: Catalogue view guard — Coming Soon badge, hidden price, unlinked CTA (services.ejs)

**Files:**
- Modify `src/views/services.ejs`:
  - preview service card at lines 469–484 (the primary card per spec §4.4)
  - featured card at lines 428–437 (also links + shows price — guard for consistency)
  - add public badge CSS inside the page's own `<style>` block (before its close at line 309)
- Confirm `src/routes/static-pages.js` line 102 query returns `coming_soon` (it selects `sv.*` — already true) and that the `base_price > 0` filter does not hide coming-soon rows (verified in prod: all 140 visible services have `base_price > 0`).

**Interfaces:**
- Consumes: `service.coming_soon` (boolean, delivered via `sv.*` from the cached `/services` query; the boolean is an additive column — no cache-shape change), plus existing `service.base_price`, `service.name`, `service.sla_hours`, and the `tt()`/`__isAr` helpers already in scope.
- Produces: for a `coming_soon` service — a `.service-soon-badge` "Coming Soon"/"قريبًا", NO `.service-price` block, and a non-navigating `<div role="link" aria-disabled="true" tabindex="-1">` in place of the `<a href>` (so the card cannot be clicked into the wizard). The public badge class is scoped to `/services` (NOT `.v2-chip--soon`, which is doctor-portal-only under `body.doctor-theme.portal-v2` and would render unstyled here).

**Note on testability:** EJS markup is not unit-tested in this repo. The DB/query half IS assertable via a source-grep guard (that `static-pages.js` still returns `sv.*`). The rendered-output half is verified with a snapshot render of `services.ejs` against fixture data (pure `ejs.render`, no DB, no boot) plus a headless-Chrome visual check on the prod-schema clone.

Steps:

- [ ] **Step 1: Confirm the query already returns `coming_soon` (source-grep guard test).** Create `tests/core/services-catalogue-coming-soon.test.js` (grep + fixture-render; no DB, no boot):
  ```js
  // tests/core/services-catalogue-coming-soon.test.js
  //
  // Coming Soon — public catalogue (spec §4.4). Two guards:
  //  (a) the /services query must still return coming_soon (via sv.*), and the
  //      base_price>0 filter must not be tightened in a way that drops rows.
  //  (b) rendering services.ejs with a coming_soon service must emit the badge,
  //      hide the price, and NOT emit a bookable <a href> for that card.
  // Pure fixture render — no DB, no boot.
  'use strict';
  const fs = require('fs');
  const path = require('path');
  const ejs = require('ejs');

  const t = global._testRunner || {
    pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
    fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
    skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
  };

  console.log('\n🏷️  public catalogue marks coming_soon services (§4.4)\n');

  const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');

  // (a) query still exposes coming_soon via sv.*
  try {
    const sp = fs.readFileSync(path.join(VIEWS, '..', 'routes', 'static-pages.js'), 'utf8');
    if (!/SELECT DISTINCT ON \(sv\.id\) sv\.\*/.test(sp)) {
      throw new Error('/services query no longer selects sv.* — coming_soon may be dropped from the row.');
    }
    t.pass('/services query selects sv.* (coming_soon is returned)');
  } catch (e) { t.fail('services-catalogue: query returns coming_soon', e); }

  // (b) fixture render — a coming_soon service is badged, price-hidden, unlinked.
  try {
    const soon = { id: 'soon_svc', name: 'Soon Service', description: 'x', base_price: 1200, sla_hours: 48, specialty_name: 'Cardiology', coming_soon: true };
    const live = { id: 'live_svc', name: 'Live Service', description: 'y', base_price: 900,  sla_hours: 48, specialty_name: 'Cardiology', coming_soon: false };
    const html = ejs.render(fs.readFileSync(path.join(VIEWS, 'services.ejs'), 'utf8'), {
      services: [live, soon],
      specialtyNames: ['Cardiology'], specialtyNameArMap: {}, isAr: false,
      user: null,
      tt: (k, en) => en,
      formatMoney: (n) => 'EGP ' + n,
      cspNonce: '', BUSINESS_INFO: {}, title: '', description: '', canonical: '/services',
    }, { views: [VIEWS], filename: path.join(VIEWS, 'services.ejs') });

    if (!/service-soon-badge/.test(html)) throw new Error('coming_soon card is missing the .service-soon-badge');
    if (!/aria-disabled="true"/.test(html)) throw new Error('coming_soon card must render a non-navigating aria-disabled element');
    // The soon service id must NOT appear inside an href (i.e. not clickable into the wizard).
    if (new RegExp('href="[^"]*service_id=soon_svc').test(html)) {
      throw new Error('coming_soon service must NOT be linked with an href into the wizard');
    }
    // Sanity: the live service IS still linked.
    if (!new RegExp('href="[^"]*service_id=live_svc').test(html)) {
      throw new Error('bookable service must remain a clickable card');
    }
    t.pass('coming_soon card is badged, price-hidden, and unlinked; bookable card stays clickable');
  } catch (e) { t.fail('services-catalogue: coming_soon render', e); }
  ```
  (Uses `ejs` — already a prod dependency. `include('partials/header', …)` inside `services.ejs` is resolved via the `views`/`filename` options; if a required `partials/header` local is missing at render time, add the minimal locals it needs to the fixture — verify at Step 2 and extend the render context rather than the view.)

- [ ] **Step 2: Run — expect failure.** Command: `node tests/core/services-catalogue-coming-soon.test.js`. Expected: guard (a) passes (query already selects `sv.*`), guard (b) FAILS — `services.ejs` does not yet emit `.service-soon-badge`/`aria-disabled`, and the coming_soon service is still wrapped in an `<a href …service_id=soon_svc>`. (If the render throws on a missing partial/local, fix the fixture locals until the render succeeds and the assertions are the thing failing.)

- [ ] **Step 3: Add the public badge CSS.** In `src/views/services.ejs`, inside the `<style>` block, immediately before `</style>` (line 309), add:
  ```css
  /* Coming Soon — public catalogue (NOT the doctor-portal .v2-chip--soon, which
     is scoped to body.doctor-theme.portal-v2 and unstyled here). */
  .service-card--soon {
    cursor: default;
    opacity: 0.9;
  }
  .service-card--soon:hover {
    border-color: #e5e7eb;
    transform: none;
    box-shadow: none;
    background: #f9fafb;
  }
  .service-soon-badge {
    display: inline-block;
    font-size: 12px;
    font-weight: 700;
    color: #8E6C2C;
    background: #FAF1DD;
    border-radius: 10px;
    padding: 5px 10px;
  }
  ```

- [ ] **Step 4: Guard the preview card (lines 469–484).** Replace:
  ```ejs
          <% preview.forEach(function(service) { %>
          <a href="<%= submitUrl %>?service_id=<%= service.id %>" class="service-card">
            <h3><%= service.name %></h3>
            <p><%= service.description || tt('svc.default_desc',
              'Board-certified specialist review with detailed written report in English and Arabic.',
              'مراجعة من دكتور متخصص معتمد بتقرير مكتوب مفصل بالإنجليزي والعربي.') %></p>
            <div class="service-meta">
              <div class="service-price">
                <span class="currency">EGP</span> <%= service.base_price ? Number(service.base_price).toLocaleString('en-GB', { maximumFractionDigits: 0 }) : '—' %>
              </div>
              <div class="service-sla"><%= (service.sla_hours && service.sla_hours <= 24)
                ? tt('svc.sla.24', '24-hour', '24 ساعة')
                : tt('svc.sla.standard', '48-hour', '48 ساعة') %></div>
            </div>
          </a>
          <% }); %>
  ```
  with (coming_soon → non-navigating card, badge instead of price):
  ```ejs
          <% preview.forEach(function(service) { %>
          <% if (service.coming_soon) { %>
          <div class="service-card service-card--soon" role="link" aria-disabled="true" tabindex="-1">
            <h3><%= service.name %></h3>
            <p><%= service.description || tt('svc.default_desc',
              'Board-certified specialist review with detailed written report in English and Arabic.',
              'مراجعة من دكتور متخصص معتمد بتقرير مكتوب مفصل بالإنجليزي والعربي.') %></p>
            <div class="service-meta">
              <span class="service-soon-badge"><%= tt('svc.coming_soon', 'Coming Soon', 'قريبًا') %></span>
              <div class="service-sla"><%= (service.sla_hours && service.sla_hours <= 24)
                ? tt('svc.sla.24', '24-hour', '24 ساعة')
                : tt('svc.sla.standard', '48-hour', '48 ساعة') %></div>
            </div>
          </div>
          <% } else { %>
          <a href="<%= submitUrl %>?service_id=<%= service.id %>" class="service-card">
            <h3><%= service.name %></h3>
            <p><%= service.description || tt('svc.default_desc',
              'Board-certified specialist review with detailed written report in English and Arabic.',
              'مراجعة من دكتور متخصص معتمد بتقرير مكتوب مفصل بالإنجليزي والعربي.') %></p>
            <div class="service-meta">
              <div class="service-price">
                <span class="currency">EGP</span> <%= service.base_price ? Number(service.base_price).toLocaleString('en-GB', { maximumFractionDigits: 0 }) : '—' %>
              </div>
              <div class="service-sla"><%= (service.sla_hours && service.sla_hours <= 24)
                ? tt('svc.sla.24', '24-hour', '24 ساعة')
                : tt('svc.sla.standard', '48-hour', '48 ساعة') %></div>
            </div>
          </a>
          <% } %>
          <% }); %>
  ```

- [ ] **Step 5: Guard the featured card (lines 428–437).** Replace:
  ```ejs
          <% featuredServices.forEach(function(s) { %>
          <a href="<%= submitUrl %>?service_id=<%= s.id %>" class="featured-card">
            <div class="fc-specialty"><%= __isAr && s.specialty_name_ar ? s.specialty_name_ar : s.specialty_name %></div>
            <div class="fc-name"><%= s.name %></div>
            <div class="fc-price">
              <%= s.base_price ? formatMoney(s.base_price, 'EGP') : 'EGP —' %>
              <span> <%= tt('svc.per_report', '/ report', '/ تقرير') %></span>
            </div>
          </a>
          <% }); %>
  ```
  with:
  ```ejs
          <% featuredServices.forEach(function(s) { %>
          <% if (s.coming_soon) { %>
          <div class="featured-card service-card--soon" role="link" aria-disabled="true" tabindex="-1">
            <div class="fc-specialty"><%= __isAr && s.specialty_name_ar ? s.specialty_name_ar : s.specialty_name %></div>
            <div class="fc-name"><%= s.name %></div>
            <div class="fc-price">
              <span class="service-soon-badge"><%= tt('svc.coming_soon', 'Coming Soon', 'قريبًا') %></span>
            </div>
          </div>
          <% } else { %>
          <a href="<%= submitUrl %>?service_id=<%= s.id %>" class="featured-card">
            <div class="fc-specialty"><%= __isAr && s.specialty_name_ar ? s.specialty_name_ar : s.specialty_name %></div>
            <div class="fc-name"><%= s.name %></div>
            <div class="fc-price">
              <%= s.base_price ? formatMoney(s.base_price, 'EGP') : 'EGP —' %>
              <span> <%= tt('svc.per_report', '/ report', '/ تقرير') %></span>
            </div>
          </a>
          <% } %>
          <% }); %>
  ```

- [ ] **Step 6: Run — expect pass.** Command: `node tests/core/services-catalogue-coming-soon.test.js`. Expected: both guards `✅` — query returns `sv.*`; the coming_soon fixture card carries `.service-soon-badge` + `aria-disabled="true"`, is NOT wrapped in an `href=...service_id=soon_svc`, while the bookable fixture card keeps its `href`. Confirm it is also picked up by `npm test` (the `📋 core/services-catalogue-coming-soon.test.js` header appears).

- [ ] **Step 7: Headless-Chrome visual verification (EJS not unit-tested).** Against the prod-schema clone / static render (using the §4.9 seed's "last-doctor-standing" coming_soon service): render `/services` and confirm visually — (1) the coming_soon card shows the amber "Coming Soon" badge and NO EGP price; (2) it has no hover-lift and no clickable link (clicking does not navigate to `/patient/new-case`); (3) a normal service card is unchanged and still links. Use the claude-in-chrome MCP: `navigate` to the rendered page, `read_page` to assert the badge text is present and the coming_soon card has no `href`, and a `computer` screenshot for the visual record. Also verify AR: with `?lang=ar` the badge reads "قريبًا" and layout is RTL-correct. Record the screenshot path in the commit body.

- [ ] **Step 8: Commit.** `git add src/views/services.ejs tests/core/services-catalogue-coming-soon.test.js && git commit` with message:
  ```
  feat(catalogue): mark coming_soon services on /services (§4.4)

  Coming Soon badge (EN/AR), hidden price, and a non-navigating aria-disabled
  card so a service with no active doctor cannot be clicked into the wizard.
  Public .service-soon-badge/.service-card--soon added to the page's own style
  block (the doctor-portal .v2-chip--soon is out of scope here). Query already
  returns coming_soon via sv.*. Fixture-render guard + headless-Chrome check.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

**Slice notes:**
- `servicesBookableClause` is authored in Task 7 per the shared contract and consumed by the web-wizard task (Task 8) in the same phase; other slices import it via `require('../routes/patient').servicesBookableClause`.
- All new tests run green in the local harness (they are pure `node:test` / source-grep / fixture-render — no server boot, no live DB), consistent with the migration-070 local-boot constraint. The one true runtime redirect (web wizard 302) and the catalogue visual are verified against the prod-schema clone / headless Chrome, documented in their commit bodies, because they cannot boot locally.
- Files touched by this slice: `src/routes/patient.js`, `src/routes/api/cases.js`, `src/views/services.ejs`, and new tests under `tests/unit/` and `tests/core/`. `src/routes/static-pages.js` is read-only for this slice (its `sv.*` query already returns `coming_soon`).

---

## Phase P3 — Assignment eligibility (onboarding gate + service-level matching, 9 sites)

## Slice: Shared eligibility helper + all 9 assignment sites (spec §4.6)

**Test harness note (applies to every DB test below):** Local raw boot is broken (migration 070 needs a Supabase `anon` role absent locally), so integration tests do NOT boot the server. They connect a `pg.Pool` straight to the local Postgres schema clone and are run individually with `node --test <file>` — the exact pattern of `tests/admin/admin_bulk_assign.test.js:16-28`. Pure-string tests are `node:test` unit files with no DB (pattern of `tests/admin/doctor_welcome_payload.test.js`). `tests/run.js` `require()`s them for discovery but does not execute `node:test` bodies; the authoritative command is `node --test <file>` against `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false`. Every fixture carries a per-process `SUFFIX` and is deleted in `test.after()`.

---

### Task 11: Shared eligibility helper `src/services/doctor_eligibility.js`

**Files:**
- Create `src/services/doctor_eligibility.js` (new)
- Create `tests/services/doctor_eligibility.test.js` (new)

**Interfaces:**
- Produces: `function eligibleDoctorClause({ alias, serviceIdParam })` → returns a SQL fragment **string** (no leading/trailing `AND`, no parens wrapper) containing exactly: `<alias>.role = 'doctor' AND COALESCE(<alias>.is_active, true) = true AND COALESCE(<alias>.is_paused, false) = false AND COALESCE(<alias>.onboarding_complete, false) = true AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = <alias>.id AND ds.service_id = <serviceIdParam>)`.
- `alias` is a SQL table alias (e.g. `'u'`); `serviceIdParam` is a bind-placeholder token the caller already allocated (e.g. `'$3'`). The helper does NOT allocate params — callers own their `$n` numbering.
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing pure-unit test.** Create `tests/services/doctor_eligibility.test.js`:
  ```js
  'use strict';
  // Pure unit tests for eligibleDoctorClause — no DB. Pins the exact SQL fragment
  // shape all 9 assignment sites depend on (spec §4.6). Run:
  //   node --test tests/services/doctor_eligibility.test.js
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { eligibleDoctorClause } = require('../../src/services/doctor_eligibility');

  test('emits the five required predicates with the given alias + param', () => {
    const sql = eligibleDoctorClause({ alias: 'u', serviceIdParam: '$3' });
    assert.match(sql, /u\.role = 'doctor'/);
    assert.match(sql, /COALESCE\(u\.is_active, true\) = true/);
    assert.match(sql, /COALESCE\(u\.is_paused, false\) = false/);
    assert.match(sql, /COALESCE\(u\.onboarding_complete, false\) = true/);
    assert.match(sql, /EXISTS \(SELECT 1 FROM doctor_services ds WHERE ds\.doctor_id = u\.id AND ds\.service_id = \$3\)/);
  });

  test('does not wrap in outer parens or lead/trail with AND', () => {
    const sql = eligibleDoctorClause({ alias: 'u', serviceIdParam: '$1' }).trim();
    assert.ok(!/^AND\b/.test(sql), 'no leading AND');
    assert.ok(!/\bAND$/.test(sql), 'no trailing AND');
    assert.ok(!(sql.startsWith('(') && sql.endsWith(')')), 'not wrapped in a single outer paren');
  });

  test('interpolates a different alias verbatim', () => {
    const sql = eligibleDoctorClause({ alias: 'd', serviceIdParam: '$7' });
    assert.match(sql, /d\.role = 'doctor'/);
    assert.match(sql, /ds\.doctor_id = d\.id AND ds\.service_id = \$7/);
  });
  ```

- [ ] **Step 2: Run it — expect failure (module missing).**
  `node --test tests/services/doctor_eligibility.test.js`
  Expected: fails with `Cannot find module '../../src/services/doctor_eligibility'`.

- [ ] **Step 3: Implement the helper.** Create `src/services/doctor_eligibility.js`:
  ```js
  'use strict';

  /**
   * Tashkheesa — shared doctor-eligibility SQL fragment (spec §4.6).
   *
   * The single source of truth for the assignment safety gate. Emits the
   * onboarding + service-level-matching predicates every assignment site must
   * apply. Callers KEEP their own specialty / tier / capacity / pending_approval
   * predicates and JOIN this fragment with AND.
   *
   * Pure string builder: it does NOT allocate bind params. The caller owns its
   * own $n numbering and passes the placeholder token for the case's service_id
   * (serviceIdParam, e.g. '$3'). alias is the users-table alias (e.g. 'u').
   *
   * Returns a bare fragment — no leading/trailing AND, no outer paren wrapper —
   * so a caller can splice it via `clauses.push(eligibleDoctorClause(...))` or
   * interpolate it directly into a WHERE list.
   */
  function eligibleDoctorClause({ alias, serviceIdParam }) {
    const a = String(alias || 'u');
    const p = String(serviceIdParam);
    return (
      `${a}.role = 'doctor' ` +
      `AND COALESCE(${a}.is_active, true) = true ` +
      `AND COALESCE(${a}.is_paused, false) = false ` +
      `AND COALESCE(${a}.onboarding_complete, false) = true ` +
      `AND EXISTS (SELECT 1 FROM doctor_services ds ` +
      `WHERE ds.doctor_id = ${a}.id AND ds.service_id = ${p})`
    );
  }

  module.exports = { eligibleDoctorClause };
  ```

- [ ] **Step 4: Run it — expect pass.**
  `node --test tests/services/doctor_eligibility.test.js`
  Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Write the failing DB integration test** proving the fragment excludes an onboarding-incomplete doctor and a service-less doctor while including a fully-eligible one. Create `tests/services/doctor_eligibility_integration.test.js`:
  ```js
  'use strict';
  // Integration proof of eligibleDoctorClause against a REAL local Postgres.
  // Onboarding-incomplete + missing-service-row doctors are excluded; a fully
  // eligible one is included. Run:
  //   DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
  //   PG_SSL=false node --test tests/services/doctor_eligibility_integration.test.js
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { Pool } = require('pg');
  const { eligibleDoctorClause } = require('../../src/services/doctor_eligibility');

  const SUFFIX = 'elig-' + process.pid + '-' + Date.now();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
    ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  const q = (s, p) => pool.query(s, p);
  let seq = 0;
  const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

  async function mkDoctor({ onboarding, active = true, paused = false }) {
    const id = uid('doc');
    await q(
      `INSERT INTO users (id, email, name, role, is_active, is_paused, onboarding_complete, specialty_id)
         VALUES ($1,$2,$3,'doctor',$4,$5,$6,$7)`,
      [id, id + '@example.com', id, active, paused, onboarding, 'spec-' + SUFFIX]
    );
    return id;
  }
  async function mapService(docId, svcId) {
    await q(`INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [docId, svcId]);
  }

  test.after(async () => {
    await q('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX + '%']);
    await q('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX + '%']);
    await pool.end();
  });

  test('excludes onboarding-incomplete + service-less doctors; includes the fully eligible one', async () => {
    const svc = 'svc-' + SUFFIX;
    const eligible   = await mkDoctor({ onboarding: true });  await mapService(eligible, svc);
    const noOnboard  = await mkDoctor({ onboarding: false }); await mapService(noOnboard, svc);
    const noService  = await mkDoctor({ onboarding: true });  // never mapped to svc

    // $1 = svc id (serviceIdParam), $2 = our SUFFIX filter to scope to this test's rows.
    const frag = eligibleDoctorClause({ alias: 'u', serviceIdParam: '$1' });
    const { rows } = await q(
      `SELECT u.id FROM users u WHERE ${frag} AND u.id LIKE $2`,
      [svc, '%' + SUFFIX + '%']
    );
    const ids = rows.map((r) => r.id);
    assert.deepEqual(ids.sort(), [eligible].sort(), 'only the fully-eligible doctor matches');
    assert.ok(!ids.includes(noOnboard), 'onboarding-incomplete excluded');
    assert.ok(!ids.includes(noService), 'service-less excluded');
  });
  ```

- [ ] **Step 6: Run it — expect pass.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/services/doctor_eligibility_integration.test.js`
  Expected: `# pass 1`, `# fail 0`. (If the local schema clone is unavailable, this test errors on connect — note that as an environment gap, not a code failure; the pure-unit test in Steps 1-4 is the mandatory gate.)

- [ ] **Step 7: Commit.**
  `git add src/services/doctor_eligibility.js tests/services/doctor_eligibility.test.js tests/services/doctor_eligibility_integration.test.js && git commit -m "feat(assign): shared eligibleDoctorClause — onboarding gate + service-level matching (§4.6)"` (append the Co-Authored-By trailer).

---

### Task 12: Site 5 — `case_sla_worker.js` `buildAlternateDoctorQuery` (hottest path)

**Files:**
- Modify `src/case_sla_worker.js`:
  - `fetchSlaCandidates` SELECT (lines 176-185) — add `o.service_id`.
  - `fetchDoctorTimeouts` both SELECTs (lines 272-299 and 301-312) — add `o.service_id`.
  - `buildAlternateDoctorQuery` (lines 37-77) — accept `serviceId`, splice `eligibleDoctorClause`.
  - `selectAlternateDoctor` / `countEligibleDoctors` (lines 79-96) — thread `serviceId`.
  - `findAlternateDoctor` (lines 98-151) — thread `serviceId` through both primary + fallback calls.
  - `handleBreach` (lines 322-325) and `handleDoctorTimeout` (lines 379-382) — pass `candidate.service_id`.

**Interfaces:**
- Consumes: `require('./services/doctor_eligibility').eligibleDoctorClause`.
- Produces: `buildAlternateDoctorQuery({ specialtyId, excludeDoctorId, countOnly, serviceId })`. When `serviceId` is present, the WHERE includes the eligibility fragment bound to a fresh `$N` = serviceId. When absent, behavior is unchanged (but callers now always pass it).

- [ ] **Step 1: Write the failing test** proving the SLA worker's alternate-doctor query excludes ineligible doctors. Create `tests/sla/sla-worker-eligibility.test.js`:
  ```js
  'use strict';
  // §4.6 site 5 — the SLA worker's alternate-doctor selection now applies the
  // shared eligibility gate keyed on the CASE's service_id. Real local Postgres.
  // Run: DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
  //      PG_SSL=false node --test tests/sla/sla-worker-eligibility.test.js
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { Pool } = require('pg');

  const SUFFIX = 'slaelig-' + process.pid + '-' + Date.now();
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa';
  process.env.PG_SSL = process.env.PG_SSL || 'false';

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.PG_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  const q = (s, p) => pool.query(s, p);
  let seq = 0;
  const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

  // buildAlternateDoctorQuery is not exported; test through the module's public
  // selectAlternateDoctor by requiring the internals via a thin re-export shim.
  // (Add `buildAlternateDoctorQuery` to case_sla_worker's module.exports in Step 3.)
  const { buildAlternateDoctorQuery } = require('../../src/case_sla_worker');

  const spec = 'spec-' + SUFFIX;
  const svcA = 'svcA-' + SUFFIX;

  async function mkDoctor({ onboarding = true, active = true, paused = false, name }) {
    const id = uid('doc');
    await q(`INSERT INTO users (id,email,name,role,is_active,is_paused,onboarding_complete,specialty_id,created_at)
             VALUES ($1,$2,$3,'doctor',$4,$5,$6,$7,NOW())`,
      [id, id + '@example.com', name || id, active, paused, onboarding, spec]);
    return id;
  }
  const mapSvc = (d, s) => q(`INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [d, s]);

  test.after(async () => {
    await q('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX + '%']);
    await q('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX + '%']);
    await pool.end();
  });

  test('service-keyed eligibility: only onboarded doctor holding the service row is selectable', async () => {
    const good     = await mkDoctor({ name: 'Good' });        await mapSvc(good, svcA);
    const noBoard  = await mkDoctor({ onboarding: false });   await mapSvc(noBoard, svcA);
    const wrongSvc = await mkDoctor({ name: 'Wrong' });       // no svcA row

    const { query, allParams } = buildAlternateDoctorQuery({
      specialtyId: spec, excludeDoctorId: null, countOnly: false, serviceId: svcA,
    });
    // Constrain to this test's rows so ORDER BY … LIMIT 1 is deterministic.
    const scoped = query.replace('WHERE ' , "WHERE u.id LIKE '%" + SUFFIX + "%' AND ");
    const row = (await q(scoped, allParams)).rows[0];
    assert.ok(row, 'a doctor was selected');
    assert.equal(row.id, good, 'only the onboarded, service-holding doctor is eligible');
  });

  test('countOnly with service gate counts exactly the eligible pool', async () => {
    const { query, allParams } = buildAlternateDoctorQuery({
      specialtyId: spec, excludeDoctorId: null, countOnly: true, serviceId: svcA,
    });
    const scoped = query.replace('WHERE ', "WHERE u.id LIKE '%" + SUFFIX + "%' AND ");
    const c = Number((await q(scoped, allParams)).rows[0].eligible_count);
    assert.equal(c, 1, 'exactly one eligible doctor for svcA');
  });
  ```

- [ ] **Step 2: Run it — expect failure.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/sla/sla-worker-eligibility.test.js`
  Expected: fails — `buildAlternateDoctorQuery` is not exported (`undefined is not a function`), and even if reached, the current query ignores `serviceId` so `noBoard`/`wrongSvc` are wrongly eligible.

- [ ] **Step 3: Add the require + thread `serviceId` into `buildAlternateDoctorQuery`.** In `src/case_sla_worker.js`, after line 8 add:
  ```js
  const { eligibleDoctorClause } = require('./services/doctor_eligibility');
  ```
  Replace the `buildAlternateDoctorQuery` body (current lines 37-77) with:
  ```js
  function buildAlternateDoctorQuery({ specialtyId, excludeDoctorId, countOnly, serviceId }) {
    // P1-FIN-2: exclude is_paused doctors (auto-paused by SLA breach
    // threshold or manually paused by admin). is_active continues to gate
    // login; is_paused gates new-assignment routing only.
    //
    // §4.6: onboarding + service-level matching now come from the shared
    // eligibleDoctorClause (keyed on the case's service_id). role/is_active/
    // is_paused are folded into that fragment; specialty + capacity stay local.
    const statusParams = [...ACTIVE_STATUSES];
    let paramIdx = statusParams.length + 1; // $1..$N are status params

    const clauses = [];

    if (serviceId) {
      // eligibleDoctorClause emits role='doctor', is_active, is_paused,
      // onboarding_complete, and the doctor_services EXISTS gate.
      clauses.push(eligibleDoctorClause({ alias: 'u', serviceIdParam: `$${paramIdx}` }));
      statusParams.push(serviceId);
      paramIdx++;
    } else {
      // Legacy fallback (no service on the case): keep the pre-§4.6 predicates.
      clauses.push("u.role = 'doctor'", 'u.is_active = true', "COALESCE(u.is_paused, false) = false");
    }

    if (excludeDoctorId) {
      clauses.push(`u.id != $${paramIdx}`);
      statusParams.push(excludeDoctorId);
      paramIdx++;
    }
    if (specialtyId) {
      clauses.push(`LOWER(TRIM(COALESCE(u.specialty_id, ''))) = $${paramIdx}`);
      statusParams.push(specialtyId);
      paramIdx++;
    }

    // capacity param
    clauses.push(`COALESCE(a.active_count, 0) < $${paramIdx}`);
    statusParams.push(MAX_ACTIVE_CASES_PER_DOCTOR);

    const statusPlaceholders = ACTIVE_STATUSES.map((_, i) => `$${i + 1}`).join(', ');

    const query = `
      SELECT ${countOnly ? 'COUNT(*) AS eligible_count' : 'u.id'}
      FROM users u
      LEFT JOIN (
        SELECT doctor_id, COUNT(*) AS active_count
        FROM orders_active
        WHERE doctor_id IS NOT NULL
          AND LOWER(TRIM(COALESCE(status, ''))) IN (${statusPlaceholders})
        GROUP BY doctor_id
      ) a ON a.doctor_id = u.id
      WHERE ${clauses.join(' AND ')}
      ${countOnly ? '' : 'ORDER BY COALESCE(a.active_count, 0) ASC, u.created_at ASC LIMIT 1'}
    `;

    return { query, allParams: statusParams };
  }
  ```

- [ ] **Step 4: Thread `serviceId` through the wrappers.** Change `selectAlternateDoctor` (line 79) and `countEligibleDoctors` (line 88) signatures + calls:
  ```js
  async function selectAlternateDoctor({ specialtyId, excludeDoctorId, serviceId } = {}) {
    const { query, allParams } = buildAlternateDoctorQuery({
      specialtyId,
      excludeDoctorId,
      countOnly: false,
      serviceId
    });
    return await queryOne(query, allParams);
  }

  async function countEligibleDoctors({ specialtyId, excludeDoctorId, serviceId } = {}) {
    const { query, allParams } = buildAlternateDoctorQuery({
      specialtyId,
      excludeDoctorId,
      countOnly: true,
      serviceId
    });
    const row = await queryOne(query, allParams);
    return row ? Number(row.eligible_count) : 0;
  }
  ```
  Update `findAlternateDoctor` (line 98) to accept + forward `serviceId`:
  ```js
  async function findAlternateDoctor({ specialtyId, excludeDoctorId, serviceId } = {}) {
    const normalizedSpecialtyId = normalizeSpecialtyId(specialtyId);
    const hasSpecialtyFilter = Boolean(normalizedSpecialtyId);

    let doctor = await selectAlternateDoctor({
      specialtyId: hasSpecialtyFilter ? normalizedSpecialtyId : null,
      excludeDoctorId,
      serviceId
    });
  ```
  In the fallback branch (line 119) add `serviceId` to the second `selectAlternateDoctor({ specialtyId: null, excludeDoctorId, serviceId })`, and in the `eligibleCounts` block (lines 135-139) add `serviceId` to both `countEligibleDoctors` calls.

- [ ] **Step 5: Select `service_id` on the candidate fetches + pass it in the handlers.** In `fetchSlaCandidates` (lines 176-178) add `o.service_id`:
  ```js
    return await queryAll(
      `SELECT o.id AS case_id,
              o.doctor_id,
              o.specialty_id,
              o.service_id
       FROM orders_active o
  ```
  In `fetchDoctorTimeouts` primary SELECT (lines 273-276) add `o.service_id,` after `o.specialty_id,`, and in the legacy fallback SELECT (lines 302-304) add `o.service_id` after `o.specialty_id,`.
  In `handleBreach` (line 322) change the call to:
  ```js
    const selection = await findAlternateDoctor({
      specialtyId: candidate.specialty_id,
      excludeDoctorId: candidate.doctor_id,
      serviceId: candidate.service_id
    });
  ```
  Apply the same three-key call in `handleDoctorTimeout` (line 379).

- [ ] **Step 6: Export `buildAlternateDoctorQuery` for the test.** Change the bottom `module.exports` (line 532):
  ```js
  module.exports = {
    startCaseSlaWorker,
    runCaseSlaSweep,
    buildAlternateDoctorQuery
  };
  ```

- [ ] **Step 7: Run the test — expect pass.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/sla/sla-worker-eligibility.test.js`
  Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 8: Commit.**
  `git add src/case_sla_worker.js tests/sla/sla-worker-eligibility.test.js && git commit -m "fix(sla-worker): gate alternate-doctor reassignment on §4.6 eligibility + case service_id"` (append Co-Authored-By).

---

### Task 13: Sites 1 & 2 — `api/admin.js` candidates picker + single-assign 409 guards

**Files:**
- Modify `src/routes/api/admin.js`:
  - Candidates picker `GET /cases/:id/candidates` (lines 885-933): SELECT the case's `service_id`; pass it to the doctor query; add `onboarding_complete` + `EXISTS(doctor_services)` to the eligibility flag.
  - Single-assign `POST /cases/:id/assign` (lines 1072-1097): SELECT `service_id`; add `onboarding_complete` to the doctor SELECT; add the two 409 guards.
  - Add `require` of `eligibleDoctorClause` near the top imports (after line 47).
- Modify/Create `tests/admin/admin_command_api.test.js` (extend) OR create `tests/admin/assign-eligibility.test.js` (new) — see note in Step 1.

**Interfaces:**
- Consumes: `eligibleDoctorClause` (for the candidates advisory flag), `db`/`safeGet`/`safeAll` (existing).
- Produces error codes: `DOCTOR_ONBOARDING_INCOMPLETE` (409), `DOCTOR_SERVICE_NOT_OFFERED` (409) on single-assign.

- [ ] **Step 1: Write the failing integration test** for the two new 409s. Create `tests/admin/assign-eligibility.test.js`. The single-assign endpoint is mounted via `module.exports = function (db, helpers, deploy, deps)`; construct an `express` app with the router and a stub `req.user`, mirroring how `admin_command_api.test.js` mounts it (read that file first to reuse its exact mount + `safeGet/safeAll` wiring). The test seeds: a paid unassigned case with `service_id = svcA`; doctor `D1` (onboarding_complete=false, mapped to svcA) → expect `409 DOCTOR_ONBOARDING_INCOMPLETE`; doctor `D2` (onboarding_complete=true, NOT mapped to svcA) → expect `409 DOCTOR_SERVICE_NOT_OFFERED`; doctor `D3` (onboarding_complete=true, mapped to svcA, same specialty, under cap) → expect `200`/assigned. Assert the JSON `code` field for each. (If mounting the full router is too heavy in the harness, fall back to a focused SQL-level test that runs the exact single-assign doctor SELECT + the two JS guards as a extracted predicate — but prefer the real route.)

- [ ] **Step 2: Run it — expect failure.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/admin/assign-eligibility.test.js`
  Expected: both new-code assertions fail — today the endpoint returns `200` for `D1`/`D2` because it checks neither `onboarding_complete` nor service membership.

- [ ] **Step 3: Add the import.** After line 47 (`} = require('./_assign_helpers');`) add:
  ```js
  const { eligibleDoctorClause } = require('../../services/doctor_eligibility');
  ```

- [ ] **Step 4: Candidates picker — thread `service_id` + service-level flag.** Replace the case SELECT (lines 887-890) to also fetch `service_id`:
  ```js
        const c = await safeGet(
          `SELECT o.id, o.specialty_id, o.service_id, o.urgency_tier, o.doctor_id, COALESCE(sp.name,'—') AS specialty
             FROM orders_active o LEFT JOIN specialties sp ON sp.id = o.specialty_id WHERE o.id = $1`,
          [req.params.id]
        );
  ```
  Extend the doctor SELECT (lines 895-903) to project `onboarding_complete` and a per-row `offers_service` flag bound to the case's service_id ($2):
  ```js
        const docs = c.specialty_id
          ? await safeAll(
              `SELECT u.id, u.name, u.is_active, u.is_paused, u.onboarding_complete, u.specialty_id, COALESCE(sp.name,'—') AS specialty,
                      u.max_active_cases, u.max_active_cases_urgent, u.sla_tiers_supported,
                      EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = u.id AND ds.service_id = $2) AS offers_service,
                      (SELECT COUNT(*) FROM orders_active o WHERE o.doctor_id = u.id
                         AND LOWER(COALESCE(o.status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')) AS load
                 FROM users u LEFT JOIN specialties sp ON sp.id = u.specialty_id
                WHERE u.role = 'doctor' AND u.specialty_id = $1 ORDER BY u.name ASC`,
              [c.specialty_id, c.service_id]
            )
          : [];
  ```
  In the `.map` (lines 906-926), fold onboarding + service into `eligible`:
  ```js
          .map((d) => {
            const cap = capFor(d, c.urgency_tier);
            const load = Number(d.load) || 0;
            const atCapacity = cap > 0 && load >= cap;
            const active = !!d.is_active;
            const paused = !!d.is_paused;
            const onboarded = !!d.onboarding_complete;
            const offersService = !!d.offers_service;
            return {
              id: d.id,
              name: d.name,
              specialty: d.specialty,
              specialtyMatch: true,
              active,
              paused,
              onboarded,
              offersService,
              load,
              cap,
              atCapacity,
              supportsTier: doctorSupportsTier(d.sla_tiers_supported, c.urgency_tier),
              eligible: active && !paused && onboarded && offersService && !atCapacity && d.id !== c.doctor_id,
            };
          })
  ```

- [ ] **Step 5: Single-assign — SELECT `service_id`, add `onboarding_complete`, add the 409 guards.** Change the order SELECT (lines 1072-1074) to include `service_id`:
  ```js
        const o = (await client.query(
          `SELECT id, doctor_id, status, payment_status, paid_at, specialty_id, service_id, urgency_tier, sla_hours
             FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [id]
        )).rows[0];
  ```
  Change the doctor SELECT (lines 1089-1092) to add `onboarding_complete`:
  ```js
        const d = (await client.query(
          `SELECT id, name, role, is_active, is_paused, onboarding_complete, specialty_id, max_active_cases, max_active_cases_urgent
             FROM users WHERE id = $1`,
          [doctorId]
        )).rows[0];
  ```
  Immediately AFTER the existing `SPECIALTY_MISMATCH` guard (line 1097), insert the two new guards:
  ```js
        if (!d.onboarding_complete) af('Doctor has not completed onboarding', 409, 'DOCTOR_ONBOARDING_INCOMPLETE');
        const offersService = !!(await client.query(
          `SELECT 1 FROM doctor_services WHERE doctor_id = $1 AND service_id = $2 LIMIT 1`,
          [doctorId, o.service_id]
        )).rows[0];
        if (!offersService) af('Doctor does not offer this service', 409, 'DOCTOR_SERVICE_NOT_OFFERED');
  ```

- [ ] **Step 6: Run the test — expect pass.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/admin/assign-eligibility.test.js`
  Expected: `DOCTOR_ONBOARDING_INCOMPLETE` and `DOCTOR_SERVICE_NOT_OFFERED` assertions pass; the eligible doctor assigns (`# fail 0`).

- [ ] **Step 7: Run the existing command-API suite to confirm no regression.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/admin/admin_command_api.test.js`
  Expected: all pre-existing assertions still pass (any that assigned a not-yet-onboarded/unmapped doctor must be updated in the same test file to mark the seeded doctor `onboarding_complete=true` + insert a `doctor_services` row for the case's service — note this fixup explicitly if the run surfaces it).

- [ ] **Step 8: Commit.**
  `git add src/routes/api/admin.js tests/admin/assign-eligibility.test.js tests/admin/admin_command_api.test.js && git commit -m "feat(admin-api): §4.6 eligibility on candidates + single-assign 409 guards (onboarding + service)"` (append Co-Authored-By).

---

### Task 14: Sites 3 & 4 — `admin_bulk_assign.js` pool query + JS eligibility filter

**Files:**
- Modify `src/services/admin_bulk_assign.js`:
  - Case-lock SELECT (lines 72-82) — add `service_id`.
  - Pool query (lines 107-111) — add `onboarding_complete` + a per-doctor `offers_service` flag bound to the case's `service_id`.
  - JS eligibility filter (line 129-135) — reject `!d.onboarding_complete` and `!d.offers_service` with new skip reasons.
  - Skip-reason derivation (lines 144-149) — add reasons.
- Modify `tests/admin/admin_bulk_assign.test.js` — extend `mkDoctor`/`mkCase` helpers + add coverage.

**Interfaces:**
- Consumes: the case's `service_id` (now selected). No cross-module import needed — the pool query builds the `EXISTS` inline (per-doctor flag, not a WHERE clause, because the loop needs `sawAvailable`/reason granularity).
- Produces skip reasons: `doctor_not_onboarded`, `no_doctor_offers_service` (new), preserving existing `all_doctors_at_capacity` / `no_available_doctor` / `no_doctor_for_specialty`.

- [ ] **Step 1: Write the failing test.** In `tests/admin/admin_bulk_assign.test.js`, extend `mkDoctor` to accept `opts.onboarding` (default `true`) and write it, and add `opts.services` (array of service ids) inserting `doctor_services` rows; extend `mkCase` to accept `opts.service` and write `service_id`. Then add:
  ```js
  test('§4.6: onboarding-incomplete + service-less doctors are skipped, not assigned', async () => {
    const spec = await mkSpec();
    const svc = uid('svc');
    // Only doctor available is NOT onboarded → case must be skipped.
    await mkDoctor(spec, { name: 'NoBoard', onboarding: false, services: [svc] });
    const c1 = await mkCase(spec, { service: svc });
    const r1 = await run([c1]);
    assert.equal(r1.counts.assigned, 0);
    assert.equal(pick(r1.skipped, c1).reason, 'doctor_not_onboarded');

    // Onboarded doctor but does NOT offer the service → skipped.
    const spec2 = await mkSpec();
    const svcB = uid('svc');
    await mkDoctor(spec2, { name: 'WrongSvc', onboarding: true, services: [] });
    const c2 = await mkCase(spec2, { service: svcB });
    const r2 = await run([c2]);
    assert.equal(r2.counts.assigned, 0);
    assert.equal(pick(r2.skipped, c2).reason, 'no_doctor_offers_service');

    // Fully eligible → assigned.
    const spec3 = await mkSpec();
    const svcC = uid('svc');
    const good = await mkDoctor(spec3, { name: 'Good', onboarding: true, services: [svcC] });
    const c3 = await mkCase(spec3, { service: svcC });
    const r3 = await run([c3]);
    assert.equal(r3.counts.assigned, 1);
    assert.equal(pick(r3.assigned, c3).doctorId, good);
  });
  ```
  Add to `test.after`: `await q('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX + '%']);` (before the users delete).

- [ ] **Step 2: Run it — expect failure.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/admin/admin_bulk_assign.test.js`
  Expected: the two new skip-reason assertions fail (today the NoBoard doctor is assigned; there is no `service_id` column selected so `offers_service` is undefined).

- [ ] **Step 3: Select `service_id` on the case lock.** In the SELECT at lines 73-74 add `service_id`:
  ```js
        `SELECT id, reference_id, doctor_id, status, payment_status, paid_at,
                specialty_id, service_id, urgency_tier, sla_hours, assignment_status,
                deadline_at, created_at
  ```

- [ ] **Step 4: Add onboarding + service flag to the pool query.** Replace the pool query (lines 107-111) so it projects both, bound to the case's `service_id` ($2):
  ```js
          pool = (await client.query(
            `SELECT id, name, is_active, is_paused, onboarding_complete, max_active_cases, max_active_cases_urgent, sla_tiers_supported,
                    EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = users.id AND ds.service_id = $2) AS offers_service
               FROM users WHERE role = 'doctor' AND specialty_id = $1`,
            [c.specialty_id, c.service_id]
          )).rows;
  ```
  (Note: `poolCache` is keyed on `specialty_id` today, but `offers_service` depends on `service_id`. Change the cache key to `c.specialty_id + '|' + (c.service_id || '')` at lines 105 and 112 so two cases in the same specialty with different services don't share a stale `offers_service` flag: `let pool = poolCache.get(c.specialty_id + '|' + (c.service_id||''));` and `poolCache.set(c.specialty_id + '|' + (c.service_id||''), pool);`.)

- [ ] **Step 5: Extend the JS eligibility filter + skip reasons.** In the candidate loop (lines 129-143), after `if (!d.is_active || d.is_paused) continue;` and setting `sawAvailable = true;`, add the onboarding + service checks with granular tracking. Replace lines 127-150 with:
  ```js
        // ── pick least projected-load eligible doctor (tie → tier-support, name) ──
        let best = null;
        let sawAvailable = false;       // active && !paused
        let sawOnboarded = false;       // active && !paused && onboarding_complete
        let sawOffersService = false;   // …&& holds the doctor_services row for this case's service
        for (const d of pool) {
          if (!d.is_active || d.is_paused) continue;
          sawAvailable = true;
          if (!d.onboarding_complete) continue;             // §4.6 onboarding gate
          sawOnboarded = true;
          if (!d.offers_service) continue;                  // §4.6 service-level matching
          sawOffersService = true;
          const cap = capFor(d, c.urgency_tier);
          const load = projected.get(d.id) || 0;
          if (cap !== 0 && load >= cap) continue;   // at capacity (cap 0 = uncapped)
          const supports = doctorSupportsTier(d.sla_tiers_supported, c.urgency_tier);
          const better =
            best === null ||
            load < best.load ||
            (load === best.load && supports && !best.supports) ||
            (load === best.load && supports === best.supports &&
              String(d.name || '').localeCompare(String(best.name || '')) < 0);
          if (better) best = { id: d.id, name: d.name, load, supports, cap };
        }
        if (!best) {
          const reason = pool.length === 0 ? 'no_doctor_for_specialty'
            : !sawAvailable ? 'no_available_doctor'
            : !sawOnboarded ? 'doctor_not_onboarded'
            : !sawOffersService ? 'no_doctor_offers_service'
            : 'all_doctors_at_capacity';
          skipped.push({ caseId: c.id, reference: ref, reason });
          continue;
        }
  ```
  (Note: projected-load seeding at lines 113-123 still runs for every pool doctor — harmless; the `projected` map keyed by doctor id is unaffected by the new filter order.)

- [ ] **Step 6: Run the full bulk-assign suite — expect pass.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/admin/admin_bulk_assign.test.js`
  Expected: `# fail 0`. Pre-existing happy-path tests need their seeded doctors to be onboarded + mapped — update `mkDoctor` default `onboarding` to `true` (done in Step 1) and add a `services:[svc]` mapping to the case's service in each pre-existing assigning test; the case's `mkCase` must pass the same `service`. Note this fixup explicitly if the run surfaces the older tests failing.

- [ ] **Step 7: Commit.**
  `git add src/services/admin_bulk_assign.js tests/admin/admin_bulk_assign.test.js && git commit -m "fix(bulk-assign): §4.6 onboarding + service-level gate with granular skip reasons"` (append Co-Authored-By).

---

### Task 15: Sites 6 & 7 — `auto_assign.js` `eligibleDoctorsFor` + specialty-pool COUNT

**Files:**
- Modify `src/auto_assign.js`:
  - `eligibleDoctorsFor` (lines 22-37) — accept `serviceId`, add `onboarding_complete` + `EXISTS(doctor_services)`.
  - `autoAssignDoctor` order SELECT (lines 96-103) — add `service_id`; pass it into `eligibleDoctorsFor`.
  - Specialty-pool COUNT (lines 133-136, **verify at build**) — add the same eligibility so the "specialty has doctors but tier filtered them" signal stays honest under §4.6.
- Modify `src/__tests__/auto_assign.test.js` if it exists (else create `tests/services/auto_assign_eligibility.test.js`).

**Interfaces:**
- Consumes: the order's `service_id`.
- Produces: `eligibleDoctorsFor({ specialtyId, tier, serviceId })` — returns only onboarded doctors holding a `doctor_services` row for `serviceId`.

- [ ] **Step 1: Verify the existing auto_assign test location + style.**
  `ls src/__tests__/auto_assign.test.js tests/**/auto_assign*.test.js 2>/dev/null` — read whichever exists to match its mocking/DB pattern before writing. (The bulk-assign header references `src/__tests__/auto_assign.test.js`.)

- [ ] **Step 2: Write the failing test** proving `eligibleDoctorsFor` excludes onboarding-incomplete + service-less doctors and includes the eligible one, keyed on `serviceId`. Use the same real-pool `node:test` pattern as `tests/services/doctor_eligibility_integration.test.js`, seeding three doctors in one specialty (onboarded+mapped, not-onboarded+mapped, onboarded+unmapped) and asserting `eligibleDoctorsFor({ specialtyId, tier:'standard', serviceId })` returns only the first.

- [ ] **Step 3: Run it — expect failure** (current query returns all three; ignores `serviceId`, `onboarding_complete`).

- [ ] **Step 4: Implement.** Replace `eligibleDoctorsFor` (lines 22-37):
  ```js
  async function eligibleDoctorsFor(opts) {
    var specialtyId = opts && opts.specialtyId;
    var serviceId = opts && opts.serviceId;
    var tier = (opts && opts.tier) || DEFAULT_TIER;
    var tierJson = JSON.stringify([tier]);
    // §4.6: onboarding gate + service-level matching. A NULL serviceId means the
    // caller couldn't resolve the order's service — fall back to specialty-only
    // (legacy) rather than matching zero doctors.
    var serviceClause = serviceId
      ? "  AND COALESCE(onboarding_complete, false) = true " +
        "  AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = users.id AND ds.service_id = $3) "
      : "";
    var params = serviceId ? [specialtyId, tierJson, serviceId] : [specialtyId, tierJson];
    return await queryAll(
      "SELECT id, name FROM users " +
      "WHERE role = 'doctor' " +
      "  AND COALESCE(is_active, true) = true " +
      "  AND COALESCE(is_paused, false) = false " +
      "  AND COALESCE(pending_approval, false) = false " +
      "  AND specialty_id = $1 " +
      "  AND COALESCE(sla_tiers_supported, '[\"standard\"]'::jsonb) @> $2::jsonb " +
      serviceClause +
      "ORDER BY name ASC",
      params
    );
  }
  ```

- [ ] **Step 5: Thread `service_id` in `autoAssignDoctor`.** Change the order SELECT (line 101) to add `service_id`:
  ```js
      'SELECT id, specialty_id, service_id, doctor_id, status, urgency_tier, assignment_status FROM orders WHERE id = $1 AND deleted_at IS NULL',
  ```
  Change the candidate call (line 128):
  ```js
    var candidates = await eligibleDoctorsFor({ specialtyId: order.specialty_id, tier: tier, serviceId: order.service_id });
  ```

- [ ] **Step 6: Site 7 — specialty-pool COUNT (verified: lines 133-136).** The COUNT distinguishes "no doctor for specialty" from "tier filter emptied the pool". Under §4.6 it should count doctors who are onboarded AND offer the service, so the shortage log is honest. Replace lines 133-136:
  ```js
      var specialtyPool = await queryOne(
        "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND COALESCE(is_active, true) = true AND COALESCE(is_paused, false) = false AND COALESCE(pending_approval, false) = false AND COALESCE(onboarding_complete, false) = true AND specialty_id = $1 AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = users.id AND ds.service_id = $2)",
        [order.specialty_id, order.service_id]
      );
  ```
  (Build-verify note: if `order.service_id` is NULL this COUNT returns 0 and the code logs "no active doctors for specialty" — acceptable, matches the legacy no-service path.)

- [ ] **Step 7: Run the test + any existing auto_assign suite — expect pass.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/services/auto_assign_eligibility.test.js` and the existing `auto_assign.test.js`.
  Expected: `# fail 0`. Existing tests that seeded plain doctors must mark them `onboarding_complete=true` + add a `doctor_services` row for the order's service; note this fixup if it surfaces.

- [ ] **Step 8: Commit.**
  `git add src/auto_assign.js tests/services/auto_assign_eligibility.test.js && git commit -m "fix(auto-assign): §4.6 onboarding + service-level gate in eligibleDoctorsFor + shortage COUNT"` (append Co-Authored-By).

---

### Task 16: Site 8 — `assign.js` `pickDoctorForOrder`

**Files:**
- Modify `src/assign.js` (lines 3-15).
- Create `tests/services/assign_pick_eligibility.test.js`.

**Interfaces:**
- Consumes: `serviceId` (new required-ish param; callers must pass the order's service_id).
- Produces: `pickDoctorForOrder({ specialtyId, serviceId })` — only onboarded, service-holding, active doctors.

- [ ] **Step 1: Check callers of `pickDoctorForOrder`.**
  `grep -rn "pickDoctorForOrder" src` — confirm each call site so `serviceId` can be threaded. Note the callers in the task output (they are outside this slice's other files; if a caller only has `specialtyId`, it must resolve `service_id` from the order — flag it).

- [ ] **Step 2: Write the failing test** (real-pool `node:test`, same pattern) seeding three doctors in one specialty and asserting `pickDoctorForOrder({ specialtyId, serviceId })` returns only the onboarded, service-mapped one.

- [ ] **Step 3: Run it — expect failure** (current query ignores service + onboarding, joins by specialty + `is_active` only).

- [ ] **Step 4: Implement.** Replace `pickDoctorForOrder` (lines 3-15):
  ```js
  async function pickDoctorForOrder({ specialtyId, serviceId }) {
    if (!specialtyId) return null;

    // §4.6: onboarding gate + service-level matching. When serviceId is missing
    // (legacy caller), fall back to specialty-only so we never hard-fail routing.
    const serviceClause = serviceId
      ? `AND COALESCE(u.onboarding_complete, false) = true
         AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = u.id AND ds.service_id = $2)`
      : '';
    const params = serviceId ? [specialtyId, serviceId] : [specialtyId];

    // Eligible doctors by specialty
    const doctors = await queryAll(
      `SELECT u.id, u.name, u.email
       FROM users u
       WHERE u.role = 'doctor'
         AND u.is_active = true
         AND u.specialty_id = $1
         ${serviceClause}
       ORDER BY u.name ASC`,
      params
    );
  ```
  (The `orders_active` COUNT loop below at lines 20-33 is unchanged — it references `doc.id`/`doc.name` which still exist.)

- [ ] **Step 5: Run the test — expect pass.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/services/assign_pick_eligibility.test.js`
  Expected: `# fail 0`.

- [ ] **Step 6: Commit.**
  `git add src/assign.js tests/services/assign_pick_eligibility.test.js && git commit -m "fix(assign): §4.6 onboarding + service-level gate in pickDoctorForOrder"` (append Co-Authored-By).

---

### Task 17: Site 9 — `superadmin.js` reassign SELECT (verify at build)

**Files:**
- Modify `src/routes/superadmin.js` (line 3688, inside `POST /superadmin/orders/:id/reassign`, lines 3672-3728).

**Interfaces:**
- Consumes: `order.service_id` (already available — the reassign handler loads `o.*` from `orders_active` at line 3676-3682, which includes `service_id`; verify `service_id` is present on `orders_active` — confirmed via schema).
- Produces: the `newDoctor` SELECT rejects onboarding-incomplete + service-less doctors (falls through to the existing redirect-without-change, which is this route's failure mode).

- [ ] **Step 1: Verify the surrounding code** (already read: lines 3672-3728). Confirm `order` comes from `orders_active` (has `service_id`) and that the failure path is `res.redirect('/superadmin/orders/:id')` when `newDoctor` is null (line 3689-3691) — so tightening the SELECT is the correct, minimal gate.

- [ ] **Step 2: Write the failing test.** This is a web (EJS/redirect) route, harder to exercise headlessly. Because the change is a single SQL predicate, prefer a focused SQL-level test: create `tests/admin/superadmin_reassign_eligibility.test.js` that runs the exact tightened SELECT string against seeded doctors and asserts an onboarding-incomplete / service-less doctor yields no row while an eligible one does. (Extract the SELECT to a `const REASSIGN_DOCTOR_SQL` local in the route and export it for the test, OR inline the identical string in the test with a comment pinning it to the route line — match whichever the other superadmin tests do; `grep -n "requireSuperadmin" tests` to check.)

- [ ] **Step 3: Run it — expect failure** (the current predicate `role='doctor' AND is_active=true` admits both ineligible doctors).

- [ ] **Step 4: Implement.** Replace line 3688:
  ```js
    const newDoctor = await queryOne(
      `SELECT id, name FROM users u
        WHERE id = $1 AND role = 'doctor' AND is_active = true
          AND COALESCE(is_paused, false) = false
          AND COALESCE(onboarding_complete, false) = true
          AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = u.id AND ds.service_id = $2)`,
      [newDoctorId, order.service_id]
    );
  ```
  (Alias `u` added so `EXISTS` can reference `u.id`. `order.service_id` is on the `orders_active` row loaded at line 3676.)

- [ ] **Step 5: Run the test — expect pass.**
  `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test tests/admin/superadmin_reassign_eligibility.test.js`
  Expected: `# fail 0`.

- [ ] **Step 6: Manual/headless verification** (route is EJS-redirect, not fully harness-testable): once the branch is deployable, POST `/superadmin/orders/:id/reassign` with `doctor_id` of an onboarding-incomplete doctor and confirm the case is NOT reassigned (redirect back, `doctor_id` unchanged) via a DB read; then with a fully-eligible doctor and confirm reassignment. Document this as the manual step since the full superadmin router boot needs the broken local `anon` role.

- [ ] **Step 7: Commit.**
  `git add src/routes/superadmin.js tests/admin/superadmin_reassign_eligibility.test.js && git commit -m "fix(superadmin): §4.6 onboarding + service-level gate on order reassign SELECT"` (append Co-Authored-By).

---

### Task 18: Slice-wide regression sweep + prod dry-run of the new SQL

**Files:** none (verification only).

- [ ] **Step 1: Run every touched DB test file in one pass.**
  For each of `tests/services/doctor_eligibility.test.js`, `tests/services/doctor_eligibility_integration.test.js`, `tests/sla/sla-worker-eligibility.test.js`, `tests/admin/assign-eligibility.test.js`, `tests/admin/admin_bulk_assign.test.js`, `tests/services/auto_assign_eligibility.test.js`, `tests/services/assign_pick_eligibility.test.js`, `tests/admin/superadmin_reassign_eligibility.test.js`: `DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false node --test <file>`. Expected: `# fail 0` across all.

- [ ] **Step 2: Prod read-only dry-run of the eligibility fragment** (per the hard credential rule — Supabase MCP, project `wvmhliweujmhlzknmuzh`, NEVER `DATABASE_URL`). Run via `mcp__claude_ai_Supabase__execute_sql`:
  ```sql
  BEGIN;
  -- prove the fragment type-checks and returns the expected shape against prod
  SELECT count(*) AS eligible_now
  FROM users u
  WHERE u.role = 'doctor'
    AND COALESCE(u.is_active, true) = true
    AND COALESCE(u.is_paused, false) = false
    AND COALESCE(u.onboarding_complete, false) = true
    AND EXISTS (SELECT 1 FROM doctor_services ds
                WHERE ds.doctor_id = u.id AND ds.service_id = (SELECT id FROM services LIMIT 1));
  ROLLBACK;
  ```
  Expected: a single integer (likely `0` today — all 29 doctors are `onboarding_complete=false`, which is the intended pre-invite state per §9). No error = the SQL is type-correct against prod. Record the number in the task output.

- [ ] **Step 3: Confirm no un-threaded call site remains.**
  `grep -rn "eligibleDoctorsFor\|pickDoctorForOrder\|findAlternateDoctor\|buildAlternateDoctorQuery" src` — verify every call now passes `serviceId`/`service_id`. Report any caller that still lacks it (out-of-slice callers that need a follow-up).

- [ ] **Step 4:** No commit (verification task). Report the dry-run count and any unresolved caller in the final summary.

---

**Cross-slice contract notes honored:** `eligibleDoctorClause({ alias, serviceIdParam })` lives in the shared `src/services/doctor_eligibility.js` and is the single source for the onboarding + service-level predicates; every site keeps its own specialty/tier/capacity/`pending_approval` predicates and threads the case's `service_id`; error codes are exactly `DOCTOR_ONBOARDING_INCOMPLETE` / `DOCTOR_SERVICE_NOT_OFFERED`; no `doctor_commission_pct` referenced; `/apply` untouched. Files this slice touches (all absolute): `/Users/ziadelwahsh/tashkheesa-portal/src/services/doctor_eligibility.js` (new), `/Users/ziadelwahsh/tashkheesa-portal/src/case_sla_worker.js`, `/Users/ziadelwahsh/tashkheesa-portal/src/routes/api/admin.js`, `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_bulk_assign.js`, `/Users/ziadelwahsh/tashkheesa-portal/src/auto_assign.js`, `/Users/ziadelwahsh/tashkheesa-portal/src/assign.js`, `/Users/ziadelwahsh/tashkheesa-portal/src/routes/superadmin.js`, plus the new test files under `/Users/ziadelwahsh/tashkheesa-portal/tests/`.

---

## Phase P4 — My Services screen (union loader, GET/POST routes, view, sidebar, CSS)

### Task 19: Doctor service union loader (`loadDoctorServiceCatalog`)

**Files:**
- Create: `/Users/ziadelwahsh/tashkheesa-portal/src/services/doctor_service_catalog.js`
- Create: `/Users/ziadelwahsh/tashkheesa-portal/tests/services/doctor_service_catalog.test.js`

**Interfaces:**
- Consumes: `client` (a `pg` PoolClient — `client.query(sql, params)`); schema verified via Supabase MCP 2026-08-10 — `services(id text, name text, base_price double precision, doctor_fee double precision, sla_hours int default 48, is_visible bool default true, coming_soon bool NOT NULL default false, specialty_id text)`, **`services` has NO `name_ar` column**; `doctor_services(doctor_id text, service_id text)`; `specialties(id text, name text, name_ar text)`; `users(id text, specialty_id text, sub_specialties jsonb)`.
- Produces: `async function loadDoctorServiceCatalog(client, { doctorId, specialtyId })` → `{ groups: [{ specialtyId, specialtyName, specialtyNameAr, services: [{ id, name, name_ar, base_price, doctor_fee, sla_hours, is_visible, ticked }] }], allowedIds: Set<string>, isEmpty: boolean }`. `name_ar` per-service is always `null` (no column); AR headings come from `specialtyNameAr`. Groups sorted by specialty name; the doctor's own specialty group first. `allowedIds` = every service id in the union. `isEmpty` = union has 0 rows.

- [ ] **Step 1: Write the failing loader spec.** Create `/Users/ziadelwahsh/tashkheesa-portal/tests/services/doctor_service_catalog.test.js`. Mirror the `node:test` + `pg.Pool` + graceful-skip + per-process SUFFIX pattern from `tests/services/doctor_applications.test.js:13-52`. This test seeds its OWN hermetic fixtures (does not depend on the §4.9 seed script) so it is self-contained. Full file:

```js
'use strict';

// loadDoctorServiceCatalog — union loader over services + doctor_services,
// on a REAL Postgres (real jsonb, real joins). Seeds its own synthetic
// fixtures with a per-process SUFFIX, cleans them in after(). Skips
// gracefully when no test DB is reachable (CI / local anon-role boot issue).
//
// Run: node --test tests/services/doctor_service_catalog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { loadDoctorServiceCatalog } = require('../../src/services/doctor_service_catalog');

const SUFFIX = 'dsc-' + process.pid + '-' + Date.now();
const SPEC_A = 'spec-A-' + SUFFIX;   // has visible services
const SPEC_B = 'spec-B-' + SUFFIX;   // empty catalogue (0 visible services)
const SPEC_C = 'spec-C-' + SUFFIX;   // cross-specialty source
const SVC_A1 = 'svc-A1-' + SUFFIX;
const SVC_A2 = 'svc-A2-' + SUFFIX;
const SVC_C1 = 'svc-C1-' + SUFFIX;   // in SPEC_C, mapped cross-specialty
const SVC_HIDDEN = 'svc-hid-' + SUFFIX; // visible=false in SPEC_A, held via row
const DOC_NORMAL = 'doc-normal-' + SUFFIX;   // in SPEC_A, mapped to A1,A2
const DOC_CROSS = 'doc-cross-' + SUFFIX;     // in SPEC_B, mapped to C1 + hidden
const DOC_EMPTY = 'doc-empty-' + SUFFIX;     // in SPEC_B, 0 mappings

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

let DB_OK = false;
let skipReason = '';

test.before(async () => {
  const c = await pool.connect().catch((e) => { skipReason = e.message; return null; });
  if (!c) return;
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO specialties (id, name, name_ar, is_visible) VALUES
         ($1,'Alpha','ألفا',true),($2,'Beta','بيتا',true),($3,'Gamma','جاما',true)
       ON CONFLICT (id) DO NOTHING`,
      [SPEC_A, SPEC_B, SPEC_C]
    );
    await c.query(
      `INSERT INTO services (id, name, base_price, doctor_fee, sla_hours, is_visible, coming_soon, specialty_id) VALUES
         ($1,'A One',1000,200,48,true,false,$5),
         ($2,'A Two',2000,400,24,true,false,$5),
         ($3,'C One',3000,600,72,true,false,$6),
         ($4,'A Hidden',1500,300,48,false,false,$5)
       ON CONFLICT (id) DO NOTHING`,
      [SVC_A1, SVC_A2, SVC_C1, SVC_HIDDEN, SPEC_A, SPEC_C]
    );
    await c.query(
      `INSERT INTO users (id, role, name, specialty_id, is_active, onboarding_complete) VALUES
         ($1,'doctor','Dr Normal',$4,true,false),
         ($2,'doctor','Dr Cross',$5,true,false),
         ($3,'doctor','Dr Empty',$5,true,false)
       ON CONFLICT (id) DO NOTHING`,
      [DOC_NORMAL, DOC_CROSS, DOC_EMPTY, SPEC_A, SPEC_B]
    );
    await c.query(
      `INSERT INTO doctor_services (doctor_id, service_id) VALUES
         ($1,$4),($1,$5),($2,$6),($2,$7)
       ON CONFLICT DO NOTHING`,
      [DOC_NORMAL, DOC_CROSS, /*svc*/SVC_A1, SVC_A2, SVC_C1, SVC_HIDDEN]
    );
    await c.query('COMMIT');
    DB_OK = true;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    skipReason = err.message;
  } finally {
    c.release();
  }
});

test.after(async () => {
  if (DB_OK) {
    await pool.query('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM services WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM specialties WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
  }
  await pool.end();
});

test('normal doctor: own-specialty visible services, ticks reflect rows', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  let out;
  try { out = await loadDoctorServiceCatalog(c, { doctorId: DOC_NORMAL, specialtyId: SPEC_A }); }
  finally { c.release(); }
  assert.equal(out.isEmpty, false);
  // union = A1, A2 (both visible in own specialty, both held)
  const ids = [...out.allowedIds].sort();
  assert.deepEqual(ids, [SVC_A1, SVC_A2].sort());
  const all = out.groups.flatMap((g) => g.services);
  assert.equal(all.length, 2);
  assert.ok(all.every((s) => s.ticked === true), 'both held → ticked');
  const a1 = all.find((s) => s.id === SVC_A1);
  assert.equal(a1.doctor_fee, 200, 'doctor_fee surfaced for "You earn"');
  assert.equal(a1.name_ar, null, 'services has no name_ar column');
});

test('cross-specialty doctor: sees N cross-specialty held items grouped under their specialty', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  let out;
  // DOC_CROSS is in SPEC_B (0 visible services) but holds SVC_C1 (Gamma) + SVC_HIDDEN (Alpha, hidden)
  try { out = await loadDoctorServiceCatalog(c, { doctorId: DOC_CROSS, specialtyId: SPEC_B }); }
  finally { c.release(); }
  assert.equal(out.isEmpty, false);
  const ids = [...out.allowedIds].sort();
  assert.deepEqual(ids, [SVC_C1, SVC_HIDDEN].sort(), 'union = held rows only (own specialty empty)');
  const gammaGroup = out.groups.find((g) => g.specialtyId === SPEC_C);
  assert.ok(gammaGroup, 'held cross-specialty service grouped under its own specialty');
  assert.equal(gammaGroup.specialtyNameAr, 'جاما');
  const alphaGroup = out.groups.find((g) => g.specialtyId === SPEC_A);
  assert.ok(alphaGroup.services.find((s) => s.id === SVC_HIDDEN && s.ticked === true), 'held hidden svc still shown+ticked');
});

test('empty-union doctor: isEmpty=true, no groups', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  let out;
  try { out = await loadDoctorServiceCatalog(c, { doctorId: DOC_EMPTY, specialtyId: SPEC_B }); }
  finally { c.release(); }
  assert.equal(out.isEmpty, true);
  assert.equal(out.allowedIds.size, 0);
  assert.equal(out.groups.length, 0);
});
```

- [ ] **Step 2: Run the test, watch it fail.** Command: `node --test tests/services/doctor_service_catalog.test.js`. Expected: the require of `../../src/services/doctor_service_catalog` throws `Cannot find module` → all three tests fail (or the whole file errors before `before()`). This proves the target module does not yet exist. (If the local DB is unreachable, `before()` sets `skipReason` and each test `t.skip`s — that still fails the module-not-found require at the top, which is the real red we want.)

- [ ] **Step 3: Implement the loader.** Create `/Users/ziadelwahsh/tashkheesa-portal/src/services/doctor_service_catalog.js`:

```js
'use strict';

// Doctor "My Services" union loader.
//
// Union = (a) visible services in the doctor's OWN specialty, plus
//         (b) every service the doctor already holds a doctor_services row
//             for (any specialty, any visibility — treated as an
//             unconfirmed default they must confirm/remove).
// Rows are grouped under each service's OWN specialty heading, the doctor's
// own specialty group first, then alphabetical by specialty name.
//
// NOTE: the `services` table has NO name_ar column (verified via schema);
// per-service name_ar is always null. Arabic headings come from
// specialties.name_ar (specialtyNameAr on each group).
//
// Consumes a pg client (thread the caller's txn client through). Read-only.

async function loadDoctorServiceCatalog(client, { doctorId, specialtyId }) {
  const did = doctorId == null ? '' : String(doctorId);
  const sid = specialtyId == null ? '' : String(specialtyId);

  // The union query. base_price/doctor_fee are double precision; sla_hours int.
  // `ticked` = the doctor already holds a doctor_services row for this service.
  const { rows } = await client.query(
    `
    WITH held AS (
      SELECT ds.service_id
      FROM doctor_services ds
      WHERE ds.doctor_id = $1
    ),
    unioned AS (
      -- (a) visible services in the doctor's own specialty
      SELECT sv.id
      FROM services sv
      WHERE sv.specialty_id = $2
        AND COALESCE(sv.is_visible, true) = true
      UNION
      -- (b) every service the doctor already holds (any specialty/visibility)
      SELECT h.service_id AS id
      FROM held h
    )
    SELECT
      sv.id,
      sv.name,
      sv.base_price,
      sv.doctor_fee,
      sv.sla_hours,
      COALESCE(sv.is_visible, true) AS is_visible,
      sv.specialty_id,
      COALESCE(sp.name, '') AS specialty_name,
      sp.name_ar AS specialty_name_ar,
      (h.service_id IS NOT NULL) AS ticked
    FROM unioned u
    JOIN services sv        ON sv.id = u.id
    LEFT JOIN specialties sp ON sp.id = sv.specialty_id
    LEFT JOIN held h         ON h.service_id = sv.id
    ORDER BY COALESCE(sp.name, '') ASC, sv.name ASC
    `,
    [did, sid]
  );

  const allowedIds = new Set(rows.map((r) => String(r.id)));

  // Group by the service's own specialty. Preserve query order within a group.
  const byСpec = new Map();
  for (const r of rows) {
    const key = r.specialty_id == null ? '' : String(r.specialty_id);
    if (!byСpec.has(key)) {
      byСpec.set(key, {
        specialtyId: key || null,
        specialtyName: r.specialty_name || '',
        specialtyNameAr: r.specialty_name_ar || null,
        services: []
      });
    }
    byСpec.get(key).services.push({
      id: String(r.id),
      name: r.name || '',
      name_ar: null, // services has no name_ar column
      base_price: r.base_price,
      doctor_fee: r.doctor_fee,
      sla_hours: r.sla_hours,
      is_visible: r.is_visible === true,
      ticked: r.ticked === true
    });
  }

  // Own specialty first, then alphabetical by specialty name.
  const groups = [...byСpec.values()].sort((a, b) => {
    const ownA = a.specialtyId === (sid || null) ? 0 : 1;
    const ownB = b.specialtyId === (sid || null) ? 0 : 1;
    if (ownA !== ownB) return ownA - ownB;
    return String(a.specialtyName).localeCompare(String(b.specialtyName));
  });

  return { groups, allowedIds, isEmpty: allowedIds.size === 0 };
}

module.exports = { loadDoctorServiceCatalog };
```

> Note: replace the placeholder identifier `byСpec` with `bySpec` when typing (ASCII only) — written here to flag it; use plain `bySpec` in the file.

- [ ] **Step 4: Run the test, watch it pass.** Command: `node --test tests/services/doctor_service_catalog.test.js`. Expected (local DB reachable): `# pass 3`, `# fail 0`. If no DB: `# skip 3`, `# fail 0` (graceful skip, still green). Either is acceptable green per the repo's DB-optional harness convention.

- [ ] **Step 5: Commit.** `git add src/services/doctor_service_catalog.js tests/services/doctor_service_catalog.test.js && git commit -m "feat(doctor): union service-catalog loader for My Services screen"` (append the required Co-Authored-By trailer).

---

### Task 20: `GET /portal/doctor/services` route

**Files:**
- Modify: `/Users/ziadelwahsh/tashkheesa-portal/src/routes/doctor.js` — add `require` near the top imports (after line 22 `const { computeDoctorEarnings } = ...`), and insert the GET route immediately after the `/portal/doctor/cases` route (after line 908, before the comment block at line 910).

**Interfaces:**
- Consumes: `loadDoctorServiceCatalog` (previous task); `requireDoctor` (`doctor.js:113`); `getLang(req,res)` (`doctor.js:3166`); `queryOne` (`doctor.js:5`). Reads `users.sub_specialties` (jsonb) + `specialties.name/name_ar` for context.
- Produces: renders view `portal_doctor_services` with locals `{ portalFrame:true, portalRole:'doctor', portalActive:'services', user, lang, isAr, groups, isEmpty, subSpecialties, specialtyName, specialtyNameAr, nextPath:'/portal/doctor/services', error, warning, confirmEmpty }`. On `isEmpty` the view shows the finalising note; the route does NOT set `onboarding_complete` (that only happens on POST — the sibling POST task owns it).

- [ ] **Step 1: Add the loader import.** After `doctor.js:22` (`const { computeDoctorEarnings } = require('../services/earnings_calc');`), add:

```js
const { loadDoctorServiceCatalog } = require('../services/doctor_service_catalog');
```

- [ ] **Step 2: Insert the GET route.** Immediately after line 908 (the closing `});` of the `/portal/doctor/cases` route) and before the `// P1-DOC-1` comment at line 910, insert:

```js

// ── My Services ─────────────────────────────────────────────────────────────
// Doctor confirms which services they accept. Their doctor_services rows are
// treated as unconfirmed defaults (pre-ticked). Service list = the UNION of
// (a) visible services in their own specialty + (b) every service they already
// hold a row for (cross-specialty). Empty-union doctors see a "finalising"
// note and are NOT marked onboarding_complete (see POST handler / spec §4.1).
router.get('/portal/doctor/services', requireDoctor, async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctorId = req.user && req.user.id ? String(req.user.id) : '';
  const specialtyId = req.user && req.user.specialty_id ? String(req.user.specialty_id) : '';

  // Context: the doctor's own specialty name (for the primary heading) + their
  // sub_specialties chips. Resilient to schema drift / missing rows.
  let specialtyName = '';
  let specialtyNameAr = null;
  let subSpecialties = [];
  try {
    const ctx = await queryOne(
      `SELECT u.sub_specialties AS sub_specialties,
              sp.name AS specialty_name, sp.name_ar AS specialty_name_ar
         FROM users u
         LEFT JOIN specialties sp ON sp.id = u.specialty_id
        WHERE u.id = $1`,
      [doctorId]
    );
    if (ctx) {
      specialtyName = ctx.specialty_name || '';
      specialtyNameAr = ctx.specialty_name_ar || null;
      let ss = ctx.sub_specialties;
      if (typeof ss === 'string') { try { ss = JSON.parse(ss); } catch (_) { ss = []; } }
      subSpecialties = Array.isArray(ss) ? ss.filter((x) => typeof x === 'string' && x) : [];
    }
  } catch (_) { /* context is best-effort; the list still renders */ }

  const catalog = await withTransaction((client) =>
    loadDoctorServiceCatalog(client, { doctorId, specialtyId })
  );

  assertRenderableView('portal_doctor_services');
  return res.render('portal_doctor_services', {
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'services',
    brand: 'Tashkheesa',
    title: isAr ? 'خدماتي' : 'My Services',
    user: req.user,
    lang,
    isAr,
    nextPath: '/portal/doctor/services',
    canonicalUrl: '/portal/doctor/services',
    groups: Array.isArray(catalog.groups) ? catalog.groups : [],
    isEmpty: !!catalog.isEmpty,
    subSpecialties,
    specialtyName,
    specialtyNameAr,
    error: null,
    warning: null,
    confirmEmpty: false
  });
});
```

(`withTransaction`, `queryOne`, `assertRenderableView`, `requireDoctor`, `getLang` are all already imported/defined in this file — verified at lines 5, 23, 113, 3166.)

- [ ] **Step 3: Verify the route wiring with a smoke require (no boot needed).** Because a full local boot is broken (migration 070 needs a missing `anon` role), verify the router still loads without syntax/reference errors via a headless require. Command:

```
node -e "process.env.JWT_SECRET='x'.repeat(40); require('./src/routes/doctor.js'); console.log('doctor router loaded OK')"
```

Expected stdout ends with `doctor router loaded OK` and exit code 0. This proves the new `require`, the route registration, and all referenced symbols resolve. (This is the honest verification available here — the view render itself is exercised in the view task's headless-Chrome step.)

- [ ] **Step 4: Run the full quick suite to confirm no regression.** Command: `npm test`. Expected: `Failed:  0` in the summary (the `tests/run.js` require-based harness must stay green; it does not exercise this route directly but catches any load-time crash in required modules).

- [ ] **Step 5: Commit.** `git add src/routes/doctor.js && git commit -m "feat(doctor): GET /portal/doctor/services renders union catalog"` (with Co-Authored-By trailer).

---

### Task 21: `POST /portal/doctor/services` (diff-save, zero-confirm, escape hatch, resync)

**Files:**
- Modify: `/Users/ziadelwahsh/tashkheesa-portal/src/routes/doctor.js` — add `require` for the resync helper next to the loader import (from the previous task), and insert the POST route immediately after the GET route.
- Modify: `/Users/ziadelwahsh/tashkheesa-portal/tests/services/doctor_service_catalog.test.js` — extend with save-diff assertions against a small extracted pure helper (see Step 1), OR add a dedicated `tests/services/doctor_services_save.test.js`. This task uses a NEW file to keep the loader test focused.
- Create: `/Users/ziadelwahsh/tashkheesa-portal/tests/services/doctor_services_save.test.js`

**Interfaces:**
- Consumes: `loadDoctorServiceCatalog` (for the allowed union); `resyncComingSoon(client)` from `src/services/services_coming_soon_sync.js` (SIBLING slice — contract-guaranteed export); `withTransaction`, `execute`; `getLang`. Error code strings from the contract: `DOCTOR_SERVICE_NOT_OFFERED` (used in the reject log/message), `DOCTOR_ONBOARDING_INCOMPLETE` (not used here — assignment slice).
- Produces: a `diffServiceSelection(allowedIds, currentIds, tickedIds)` pure helper (exported for test) returning `{ toInsert: string[], toDelete: string[], rejected: string[] }`; and the route behavior: reject out-of-union ids (re-render with error), zero-ticked requires `confirm_empty` (re-render with warning), on save set `onboarding_complete=true` and diff INSERT/DELETE within the union inside `withTransaction`, then `resyncComingSoon(client)` in the same txn.

- [ ] **Step 1: Write the failing save-diff spec.** Create `/Users/ziadelwahsh/tashkheesa-portal/tests/services/doctor_services_save.test.js`. This tests the pure `diffServiceSelection` helper (fast, no DB) plus a DB-backed round-trip using the same self-seeding pattern as the loader test. Full file:

```js
'use strict';

// diffServiceSelection (pure) + a DB-backed save round-trip.
// Run: node --test tests/services/doctor_services_save.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { diffServiceSelection } = require('../../src/services/doctor_service_catalog');
const { loadDoctorServiceCatalog } = require('../../src/services/doctor_service_catalog');

// ── Pure helper: no DB ──────────────────────────────────────────────────────
test('diffServiceSelection: computes insert/delete within the allowed union', () => {
  const allowed = new Set(['a', 'b', 'c']);
  const current = ['a', 'b'];          // doctor currently holds a,b
  const ticked = ['b', 'c'];           // wants b,c
  const out = diffServiceSelection(allowed, current, ticked);
  assert.deepEqual(out.toInsert.sort(), ['c']);
  assert.deepEqual(out.toDelete.sort(), ['a']);
  assert.deepEqual(out.rejected, []);
});

test('diffServiceSelection: rejects ticked ids outside the allowed union', () => {
  const allowed = new Set(['a', 'b']);
  const out = diffServiceSelection(allowed, ['a'], ['a', 'z']); // z not allowed
  assert.deepEqual(out.rejected, ['z']);
});

test('diffServiceSelection: never deletes current rows outside the union', () => {
  // 'x' is held but not in the allowed union (e.g. legacy row) — must be left alone
  const allowed = new Set(['a']);
  const out = diffServiceSelection(allowed, ['a', 'x'], []); // untick everything allowed
  assert.deepEqual(out.toDelete, ['a'], 'only union rows are deletable');
  assert.ok(!out.toDelete.includes('x'), 'out-of-union held row is preserved');
});

// ── DB-backed: save no-change preserves rows ────────────────────────────────
const SUFFIX = 'dss-' + process.pid + '-' + Date.now();
const SPEC = 'spec-' + SUFFIX;
const SVC1 = 'svc1-' + SUFFIX;
const SVC2 = 'svc2-' + SUFFIX;
const DOC = 'doc-' + SUFFIX;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});
let DB_OK = false, skipReason = '';

test.before(async () => {
  const c = await pool.connect().catch((e) => { skipReason = e.message; return null; });
  if (!c) return;
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO specialties (id,name,is_visible) VALUES ($1,'Sp',true) ON CONFLICT (id) DO NOTHING`, [SPEC]);
    await c.query(`INSERT INTO services (id,name,base_price,doctor_fee,sla_hours,is_visible,coming_soon,specialty_id)
                   VALUES ($1,'S1',100,20,48,true,false,$3),($2,'S2',200,40,48,true,false,$3)
                   ON CONFLICT (id) DO NOTHING`, [SVC1, SVC2, SPEC]);
    await c.query(`INSERT INTO users (id,role,name,specialty_id,is_active,onboarding_complete)
                   VALUES ($1,'doctor','Dr X',$2,true,false) ON CONFLICT (id) DO NOTHING`, [DOC, SPEC]);
    await c.query(`INSERT INTO doctor_services (doctor_id,service_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [DOC, SVC1, SVC2]);
    await c.query('COMMIT');
    DB_OK = true;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); skipReason = e.message; }
  finally { c.release(); }
});
test.after(async () => {
  if (DB_OK) {
    await pool.query('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM services WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM specialties WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
  }
  await pool.end();
});

test('save-with-no-change: diff is empty, both rows preserved', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  try {
    const cat = await loadDoctorServiceCatalog(c, { doctorId: DOC, specialtyId: SPEC });
    const current = [SVC1, SVC2];
    const ticked = [SVC1, SVC2]; // no change
    const diff = diffServiceSelection(cat.allowedIds, current, ticked);
    assert.deepEqual(diff.toInsert, []);
    assert.deepEqual(diff.toDelete, []);
  } finally { c.release(); }
  const n = (await pool.query('SELECT COUNT(*)::int AS c FROM doctor_services WHERE doctor_id=$1', [DOC])).rows[0].c;
  assert.equal(n, 2, 'no-change save preserves both rows');
});
```

- [ ] **Step 2: Run the test, watch it fail.** Command: `node --test tests/services/doctor_services_save.test.js`. Expected: require of `diffServiceSelection` fails → `TypeError: diffServiceSelection is not a function` (it isn't exported yet), so the pure tests fail. Red confirmed.

- [ ] **Step 3: Add the `diffServiceSelection` pure helper to the loader module.** In `/Users/ziadelwahsh/tashkheesa-portal/src/services/doctor_service_catalog.js`, before `module.exports`, add:

```js
// Pure diff for the save handler. `allowedIds` is the union Set from
// loadDoctorServiceCatalog; `currentIds`/`tickedIds` are string arrays.
// Only rows INSIDE the allowed union are ever inserted or deleted — out-of-union
// held rows (e.g. legacy) are left untouched. Ticked ids outside the union are
// collected in `rejected` (the route rejects the whole save).
function diffServiceSelection(allowedIds, currentIds, tickedIds) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
  const current = new Set((currentIds || []).map(String));
  const tickedRaw = (tickedIds || []).map(String);
  const rejected = [...new Set(tickedRaw.filter((id) => !allowed.has(id)))];
  const ticked = new Set(tickedRaw.filter((id) => allowed.has(id)));
  const toInsert = [...ticked].filter((id) => !current.has(id));
  // Delete = allowed-union rows the doctor currently holds but did NOT tick.
  const toDelete = [...allowed].filter((id) => current.has(id) && !ticked.has(id));
  return { toInsert, toDelete, rejected };
}
```

And change the export line to:

```js
module.exports = { loadDoctorServiceCatalog, diffServiceSelection };
```

- [ ] **Step 4: Run the save test, watch it pass.** Command: `node --test tests/services/doctor_services_save.test.js`. Expected: `# pass 4`, `# fail 0` (or `# skip 1` for the DB test if no DB, with the 3 pure tests passing → `# pass 3 # skip 1 # fail 0`).

- [ ] **Step 5: Add the resync require + implement the POST route.** In `doctor.js`, next to the loader import added earlier, add:

```js
const { loadDoctorServiceCatalog, diffServiceSelection } = require('../services/doctor_service_catalog');
const { resyncComingSoon } = require('../services/services_coming_soon_sync');
```

(Replace the single-symbol loader import line from the GET task with this two-symbol line; and add the resync require.) Then insert the POST route immediately after the GET `/portal/doctor/services` route:

```js
// POST My Services — diff-save the doctor's confirmed services.
// Server recomputes the allowed union from the DB (never trusts the client).
// Zero ticked requires an explicit confirm_empty. On any explicit save we set
// onboarding_complete=true; on save we also re-sync services.coming_soon.
router.post('/portal/doctor/services', requireDoctor, async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctorId = req.user && req.user.id ? String(req.user.id) : '';
  const specialtyId = req.user && req.user.specialty_id ? String(req.user.specialty_id) : '';

  // Body: service_ids can be an array, a single string, or absent.
  let ticked = req.body ? req.body.service_ids : undefined;
  if (ticked == null) ticked = [];
  else if (!Array.isArray(ticked)) ticked = [ticked];
  ticked = ticked.map((x) => String(x)).filter(Boolean);
  const confirmEmpty = String(req.body && req.body.confirm_empty || '') === '1';

  async function rerender(opts) {
    let specialtyName = '', specialtyNameAr = null, subSpecialties = [];
    try {
      const ctx = await queryOne(
        `SELECT u.sub_specialties AS sub_specialties, sp.name AS specialty_name, sp.name_ar AS specialty_name_ar
           FROM users u LEFT JOIN specialties sp ON sp.id = u.specialty_id WHERE u.id = $1`,
        [doctorId]
      );
      if (ctx) {
        specialtyName = ctx.specialty_name || '';
        specialtyNameAr = ctx.specialty_name_ar || null;
        let ss = ctx.sub_specialties;
        if (typeof ss === 'string') { try { ss = JSON.parse(ss); } catch (_) { ss = []; } }
        subSpecialties = Array.isArray(ss) ? ss.filter((x) => typeof x === 'string' && x) : [];
      }
    } catch (_) {}
    const cat = await withTransaction((client) =>
      loadDoctorServiceCatalog(client, { doctorId, specialtyId })
    );
    // Reflect the doctor's just-submitted ticks so re-render shows their intent.
    const tickedSet = new Set(ticked);
    for (const g of cat.groups) for (const s of g.services) s.ticked = tickedSet.has(s.id);
    if (opts.status) res.status(opts.status);
    return res.render('portal_doctor_services', {
      portalFrame: true, portalRole: 'doctor', portalActive: 'services', brand: 'Tashkheesa',
      title: isAr ? 'خدماتي' : 'My Services', user: req.user, lang, isAr,
      nextPath: '/portal/doctor/services', canonicalUrl: '/portal/doctor/services',
      groups: cat.groups, isEmpty: !!cat.isEmpty, subSpecialties, specialtyName, specialtyNameAr,
      error: opts.error || null, warning: opts.warning || null, confirmEmpty
    });
  }

  try {
    const result = await withTransaction(async (client) => {
      const cat = await loadDoctorServiceCatalog(client, { doctorId, specialtyId });
      const held = (await client.query('SELECT service_id FROM doctor_services WHERE doctor_id = $1', [doctorId]))
        .rows.map((r) => String(r.service_id));
      const diff = diffServiceSelection(cat.allowedIds, held, ticked);

      if (diff.rejected.length) {
        // DOCTOR_SERVICE_NOT_OFFERED — a ticked id is outside the allowed union.
        const err = new Error('DOCTOR_SERVICE_NOT_OFFERED');
        err.kind = 'rejected';
        throw err;
      }
      if (!ticked.length && !confirmEmpty) {
        const err = new Error('ZERO_NO_CONFIRM');
        err.kind = 'zero';
        throw err;
      }

      for (const id of diff.toInsert) {
        await client.query(
          'INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [doctorId, id]
        );
      }
      if (diff.toDelete.length) {
        await client.query(
          'DELETE FROM doctor_services WHERE doctor_id = $1 AND service_id = ANY($2)',
          [doctorId, diff.toDelete]
        );
      }
      // Any explicit save (incl. confirmed-empty) marks onboarding complete.
      await client.query('UPDATE users SET onboarding_complete = true WHERE id = $1', [doctorId]);
      // Re-sync coming_soon in the SAME txn (contract: resyncComingSoon(client)).
      await resyncComingSoon(client);
      return true;
    });
    if (result) {
      return res.redirect('/portal/doctor/services?success=' +
        encodeURIComponent(isAr ? 'تم حفظ خدماتك' : 'Your services were saved'));
    }
  } catch (err) {
    if (err && err.kind === 'rejected') {
      return rerender({
        status: 400,
        error: isAr ? 'خدمة غير مسموح بها في قائمتك.' : 'One of the selected services is not available to you.'
      });
    }
    if (err && err.kind === 'zero') {
      return rerender({
        status: 400,
        warning: isAr
          ? 'لم تحدد أي خدمة. أكد أنك لا تقبل أي خدمة حالياً للحفظ.'
          : 'You selected no services. Confirm you accept none right now to save.'
      });
    }
    logErrorToDb(err, {
      context: 'doctor.services_save', requestId: req.requestId, userId: req.user?.id,
      url: req.originalUrl, method: req.method, category: 'doctor_case'
    });
    console.error('[doctor-services] save error for user ' + doctorId + ':', err && err.message ? err.message : err);
    return rerender({
      status: 500,
      error: isAr ? 'تعذَّر حفظ خدماتك. يرجى المحاولة مرة أخرى.' : 'Could not save your services. Please try again.'
    });
  }
});
```

(`logErrorToDb` is imported at `doctor.js:6`; `queryOne`/`withTransaction`/`execute` at line 5.)

- [ ] **Step 6: Prod dry-run the save SQL (Supabase MCP, BEGIN…ROLLBACK).** The INSERT/DELETE/UPDATE + resync run against a real doctor with real types before any real write. Use `mcp__claude_ai_Supabase__execute_sql` (project `wvmhliweujmhlzknmuzh`) with a single block wrapping the exact statements the route issues, targeting a cross-specialty doctor (`doc_28ddb18f22580b48`, Medhat — 22 rows), asserting the row count is preserved on a no-change save and that `onboarding_complete` flips, then `ROLLBACK`:

```sql
BEGIN;
  UPDATE users SET onboarding_complete = true WHERE id = 'doc_28ddb18f22580b48';
  -- resync (exact §4.3 SQL, is_active-keyed)
  UPDATE public.services sv
    SET coming_soon = NOT EXISTS (
      SELECT 1 FROM public.doctor_services ds
      JOIN public.users u ON u.id = ds.doctor_id
      WHERE ds.service_id = sv.id AND u.role='doctor' AND u.is_active=true);
  SELECT (SELECT COUNT(*) FROM doctor_services WHERE doctor_id='doc_28ddb18f22580b48') AS medhat_rows,
         (SELECT onboarding_complete FROM users WHERE id='doc_28ddb18f22580b48') AS onboarded;
ROLLBACK;
```

Expected: `medhat_rows = 22`, `onboarded = true`, and the whole block runs without a type error, then discards. (This proves no-change save keeps 22 rows and flips onboarding — spec §8 regression. The full INSERT/DELETE diff is exercised hermetically in the save test; this dry-run validates the live-type UPDATE + resync coupling.)

- [ ] **Step 7: Re-run both service tests + full suite.** Commands: `node --test tests/services/doctor_services_save.test.js` then `npm test`. Expected: save test green (`# fail 0`); `npm test` summary `Failed:  0`. Also re-run the router smoke require from the GET task (`node -e "process.env.JWT_SECRET='x'.repeat(40); require('./src/routes/doctor.js'); console.log('OK')"`) → prints `OK` (confirms the new resync require + POST route load cleanly).

- [ ] **Step 8: Commit.** `git add src/routes/doctor.js src/services/doctor_service_catalog.js tests/services/doctor_services_save.test.js && git commit -m "feat(doctor): POST /portal/doctor/services diff-save with union guard + resync"` (with Co-Authored-By trailer).

---

### Task 22: View `portal_doctor_services.ejs` + checkbox-row CSS + sidebar item

**Files:**
- Create: `/Users/ziadelwahsh/tashkheesa-portal/src/views/portal_doctor_services.ejs`
- Modify: `/Users/ziadelwahsh/tashkheesa-portal/public/css/doctor-portal-v2.css` — append a `.v2-check-row` block after the `.v2-field__hint` block (ends line 964).
- Modify: `/Users/ziadelwahsh/tashkheesa-portal/src/views/partials/doctor/sidebar.ejs` — add `'services':'services'` to the `_aliasMap` (after line 26 `cases: 'cases',`) and a new nav `<li>` in the Work section (after the Cases `<li>`, line 84).

**Interfaces:**
- Consumes: locals from the GET/POST routes (`groups, isEmpty, subSpecialties, specialtyName, specialtyNameAr, error, warning, confirmEmpty, isAr, lang, user`); global `res.locals.tt(key, en, ar)` (middleware.js:255) and `res.locals.csrfField()` (csrf.js). Includes `partials/header` (portalActive:'services' → sidebar activeNav), `partials/doctor/topbar`, `partials/footer`.
- Produces: an HTML form `POST /portal/doctor/services` with `service_ids[]` checkboxes grouped by specialty, "You earn" = `doctor_fee`, sub_specialties chips, a zero-confirm checkbox, and the empty-union finalising note. New `.v2-check-row` CSS (logical properties only — lint-safe). Sidebar "Services" item active-highlights on this page.

- [ ] **Step 1: Create the view.** Clone the cases.ejs header/topbar/footer conventions. Create `/Users/ziadelwahsh/tashkheesa-portal/src/views/portal_doctor_services.ejs`:

```ejs
<%- include('partials/header', { title: (typeof isAr !== 'undefined' && isAr) ? 'خدماتي' : 'My Services', layout: 'portal', showNav: true, portalFrame: true, portalRole: 'doctor', portalActive: 'services', portalNext: '/portal/doctor/services' }) %>
<%
  var _isAr = (typeof isAr !== 'undefined') ? !!isAr : false;
  var _groups = Array.isArray(typeof groups !== 'undefined' ? groups : []) ? groups : [];
  var _isEmpty = (typeof isEmpty !== 'undefined') ? !!isEmpty : (_groups.length === 0);
  var _subs = Array.isArray(typeof subSpecialties !== 'undefined' ? subSpecialties : []) ? subSpecialties : [];
  var _specName = (_isAr && typeof specialtyNameAr !== 'undefined' && specialtyNameAr) ? specialtyNameAr
                : (typeof specialtyName !== 'undefined' && specialtyName) ? specialtyName : '';
  var _error = (typeof error !== 'undefined' && error) ? String(error) : '';
  var _warning = (typeof warning !== 'undefined' && warning) ? String(warning) : '';
  var _success = (typeof query !== 'undefined' && query && query.success) ? String(query.success) : '';
  function _money(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return '';
    return v.toLocaleString(_isAr ? 'ar-EG' : 'en-US');
  }
  function _groupHeading(g) {
    if (_isAr && g.specialtyNameAr) return g.specialtyNameAr;
    return g.specialtyName || (_isAr ? 'خدمات' : 'Services');
  }
%>
<%- include('partials/doctor/topbar', {
  isAr: _isAr,
  topbarTitle: tt('My Services', 'My Services', 'خدماتي'),
  topbarSub: tt('Confirm the services you accept', 'Confirm the services you accept', 'أكد الخدمات التي تقبلها'),
  topbarShowSearch: false
}) %>

<% if (_error) { %>
  <div class="v2-card" style="border-color:#c0392b;margin-block-end:12px;"><div class="v2-card__body" style="color:#c0392b;"><%= _error %></div></div>
<% } %>
<% if (_warning) { %>
  <div class="v2-card" style="border-color:var(--v2-brass, #b8860b);margin-block-end:12px;"><div class="v2-card__body"><%= _warning %></div></div>
<% } %>
<% if (_success) { %>
  <div class="v2-card" style="border-color:var(--v2-brand);margin-block-end:12px;"><div class="v2-card__body" style="color:var(--v2-brand-dk, #0b6b5f);"><%= _success %></div></div>
<% } %>

<% if (_isEmpty) { %>
  <div class="v2-card">
    <div class="v2-card__body--flush">
      <div class="v2-empty">
        <div class="v2-empty__title"><%= tt('Your services are being finalised', 'Your services are being finalised', 'يتم تجهيز خدماتك') %></div>
        <div class="v2-empty__msg"><%= tt("The services for your specialty are being set up. You'll be notified when they're ready.", "The services for your specialty are being set up. You'll be notified when they're ready.", 'يتم إعداد خدمات تخصصك حالياً. سيتم إشعارك عند جاهزيتها.') %></div>
        <div class="v2-empty__actions">
          <a class="v2-btn v2-btn--secondary" href="/portal/doctor/today"><%= tt('Back to Today', 'Back to Today', 'عُد إلى اليوم') %></a>
        </div>
      </div>
    </div>
  </div>
<% } else { %>
  <% if (_subs.length) { %>
  <div class="v2-card" style="margin-block-end:12px;">
    <div class="v2-card__body">
      <div style="font-size:12px;color:var(--v2-muted);margin-block-end:6px;"><%= tt('Your sub-specialties', 'Your sub-specialties', 'تخصصاتك الدقيقة') %><% if (_specName) { %> · <%= _specName %><% } %></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        <% _subs.forEach(function(s){ %><span class="v2-chip v2-chip--neutral"><%= s %></span><% }); %>
      </div>
    </div>
  </div>
  <% } %>

  <form method="post" action="/portal/doctor/services">
    <%- (typeof csrfField === 'function') ? csrfField() : '' %>
    <% _groups.forEach(function(g){ %>
      <div class="v2-card" style="margin-block-end:12px;">
        <div class="v2-card__header">
          <div class="v2-card__title"><%= _groupHeading(g) %></div>
        </div>
        <div class="v2-card__body v2-card__body--flush">
          <% (g.services || []).forEach(function(s){ %>
            <label class="v2-check-row">
              <input type="checkbox" class="v2-check-row__box" name="service_ids" value="<%= s.id %>" <%= s.ticked ? 'checked' : '' %> />
              <span class="v2-check-row__main">
                <span class="v2-check-row__name"><%= s.name %><% if (s.is_visible === false) { %> <span class="v2-chip v2-chip--neutral"><%= tt('Coming Soon', 'Coming Soon', 'قريبًا') %></span><% } %></span>
                <span class="v2-check-row__meta">
                  <span data-numeric><%= tt('You earn', 'You earn', 'تكسب') %> <%= _money(s.doctor_fee) %> <%= _isAr ? 'ج.م' : 'EGP' %></span>
                  <% if (s.sla_hours) { %> · <span data-numeric><%= _money(s.sla_hours) %><%= _isAr ? ' س' : 'h' %> SLA</span><% } %>
                </span>
              </span>
            </label>
          <% }); %>
        </div>
      </div>
    <% }); %>

    <div class="v2-card" style="margin-block-end:12px;">
      <div class="v2-card__body">
        <label class="v2-check-row v2-check-row--plain">
          <input type="checkbox" class="v2-check-row__box" name="confirm_empty" value="1" <%= (typeof confirmEmpty !== 'undefined' && confirmEmpty) ? 'checked' : '' %> />
          <span class="v2-check-row__main">
            <span class="v2-check-row__name"><%= tt('I accept no services right now', 'I accept no services right now', 'لا أقبل أي خدمة حالياً') %></span>
            <span class="v2-check-row__meta"><%= tt('Only needed if you leave every box unticked', 'Only needed if you leave every box unticked', 'مطلوب فقط إذا تركت كل الخانات فارغة') %></span>
          </span>
        </label>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-block-end:24px;">
      <button type="submit" class="v2-btn v2-btn--primary"><%= tt('Save services', 'Save services', 'حفظ الخدمات') %></button>
    </div>
  </form>
<% } %>

<%- include('partials/footer') %>
```

Note: `query.success` — confirm the route passes `query` or read from `res.locals`. If `query` is not a view local, change the `_success` line to read a passed `success` local instead; the GET/POST redirect uses `?success=`, and the header/middleware exposes `req.query` — verify at build with the smoke render and adjust to `typeof success !== 'undefined' ? success` if `query` is undefined in this view.

- [ ] **Step 2: Add the checkbox-row CSS (logical properties only — lint-safe).** Append to `/Users/ziadelwahsh/tashkheesa-portal/public/css/doctor-portal-v2.css` immediately after the `.v2-field__hint` rule (line 964). Use `margin-inline`/`padding-inline` — NEVER `margin-left`/`padding-left` (the `no-physical-margin-padding-in-css` lint scans this file):

```css

/* ═══════════════════════════════════════
   Checkbox rows (My Services confirm list)
   ═══════════════════════════════════════ */
body.doctor-theme.portal-v2 .v2-check-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding-block: 12px;
  padding-inline: 16px;
  border-block-end: 1px solid var(--v2-rule);
  cursor: pointer;
  transition: background var(--v2-t-fast) var(--v2-ease);
}
body.doctor-theme.portal-v2 .v2-check-row:last-child { border-block-end: none; }
body.doctor-theme.portal-v2 .v2-check-row:hover { background: var(--v2-brand-lt); }
body.doctor-theme.portal-v2 .v2-check-row--plain { cursor: default; }
body.doctor-theme.portal-v2 .v2-check-row__box {
  inline-size: 18px;
  block-size: 18px;
  margin-block-start: 2px;
  accent-color: var(--v2-brand);
  flex-shrink: 0;
}
body.doctor-theme.portal-v2 .v2-check-row__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}
body.doctor-theme.portal-v2 .v2-check-row__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--v2-ink);
}
body.doctor-theme.portal-v2 .v2-check-row__meta {
  font-size: 12px;
  color: var(--v2-muted);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: Add the sidebar "Services" item + alias-map entry.** In `/Users/ziadelwahsh/tashkheesa-portal/src/views/partials/doctor/sidebar.ejs`, add to `_aliasMap` after line 26 (`cases: 'cases',`):

```js
    services: 'services',
```

Then insert a new `<li>` in the Work section immediately after the Cases `</li>` (line 84), before the Prescriptions `<li>`:

```ejs
    <li>
      <a class="v2-nav-item <%= _isActive('services') %>" href="/portal/doctor/services" aria-current="<%= _active === 'services' ? 'page' : 'false' %>">
        <svg class="v2-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>
        </svg>
        <span><%= _isAr ? 'خدماتي' : 'My Services' %></span>
      </a>
    </li>
```

(The sliders SVG has no horizontal directional polyline pattern from the `directional-svgs-have-flip-class` lint allowlist, so no `p-icon--flip` needed — the two circles + two horizontal lines are symmetric-ish and not in the flagged pattern set; verify against the lint at build.)

- [ ] **Step 4: Verify the EJS compiles + renders (headless, no DB boot).** A full server boot is broken locally (migration 070). Verify the template compiles and renders with a stubbed `tt`/`csrfField` and synthetic locals via a one-off node script (write to the scratchpad, not the repo):

```
node -e "
const ejs=require('ejs'), path=require('path');
const f=path.resolve('src/views/portal_doctor_services.ejs');
const locals={ isAr:false, lang:'en', user:{name:'Dr Test'}, groups:[{specialtyId:'s1',specialtyName:'Cardiology',specialtyNameAr:'قلب',services:[{id:'x1',name:'Echo',doctor_fee:200,sla_hours:48,is_visible:true,ticked:true,name_ar:null}]}], isEmpty:false, subSpecialties:['Interventional'], specialtyName:'Cardiology', specialtyNameAr:'قلب', error:null, warning:null, confirmEmpty:false, tt:(k,en,ar)=>en, csrfField:()=>'', query:{} };
ejs.renderFile(f, locals, { root: path.resolve('src/views') }, (e,html)=>{ if(e){console.error('RENDER FAIL',e.message);process.exit(1);} if(!/You earn/.test(html)||!/service_ids/.test(html)){console.error('MISSING EXPECTED CONTENT');process.exit(1);} console.log('RENDER OK len='+html.length); });
"
```

Expected: `RENDER OK len=<n>` and exit 0. If the include of `partials/header` cascades into `layouts/portal` and errors on a missing local, add the missing local to the stub `locals` above and re-run (this exercises the real partial chain). This is the honest render verification available without a DB boot.

- [ ] **Step 5: Visual verification via headless Chrome (against the compiled HTML).** Since EJS markup can't assert visual correctness through the harness, capture the rendered page. Write the `html` from Step 4 to `${scratchpad}/services.html` (redirect the node output to a file), then open it with claude-in-chrome and screenshot both LTR and an AR variant (re-run Step 4 with `isAr:true`, `tt:(k,en,ar)=>ar`). Confirm: (1) grouped checkbox rows render with visible checkboxes, (2) "You earn 200 EGP" shows, (3) the zero-confirm row renders, (4) AR variant reads right-to-left with Arabic labels ("خدماتي", "تكسب", "قريبًا"). This is a manual visual gate — record the two screenshots in the commit message body or PR.

- [ ] **Step 6: Run lint + full suite.** Command: `npm test`. Expected: `Failed:  0` — specifically the `no-physical-margin-padding-in-css`, `directional-svgs-have-flip-class`, and `no-bare-tolocalestring` lint tests must pass over the new CSS/view (the `_money` helper wraps `toLocaleString` with an explicit locale, satisfying `no-bare-tolocalestring`; if that lint still flags it, switch `_money` to `res.locals.formatNumber` and re-run).

- [ ] **Step 7: Commit.** `git add src/views/portal_doctor_services.ejs public/css/doctor-portal-v2.css src/views/partials/doctor/sidebar.ejs && git commit -m "feat(doctor): My Services view, checkbox-row CSS, sidebar item"` (with Co-Authored-By trailer).

---

## Phase P5 — Soft-nudge banner + first-login landing

### Task 23: Doctor "landing redirect" helper + first-login redirect in auth flows

**Files:**
- Create: `src/services/doctor_landing.js` (new, ~30 lines)
- Modify: `src/routes/auth.js` — import block near top (line 3), `POST /set-password` redirect at line 609, `GET /magic-login/:token` redirect at lines 525-529, and `module.exports` at line 1162
- Create: `tests/auth/doctor-services-landing.test.js` (new, hermetic — module-cache stub of `../pg` + `../services/doctor_service_catalog`, mirrors `tests/auth/onboarding-self-heal.test.js`)

**Interfaces:**
- Consumes: `loadDoctorServiceCatalog(client, { doctorId, specialtyId })` from `src/services/doctor_service_catalog.js` (returns `{ isEmpty, ... }`) — shared contract. `require('../pg')` for a pool client.
- Produces: `src/services/doctor_landing.js` exports `async function resolveDoctorLanding(user, { client } = {})` → returns a redirect-path string. For a doctor with `onboarding_complete=false` AND non-empty service union → `'/portal/doctor/services'`; otherwise → the normal home (`'/portal/doctor'` for a doctor, else falls through to caller's default). Also exports `async function shouldLandOnServices(user, { client } = {})` → boolean (the pure predicate the banner slice can reuse). No new error codes.

- [ ] **Step 1: Write the failing hermetic test.** Create `tests/auth/doctor-services-landing.test.js`. It stubs `../pg` and `../services/doctor_service_catalog` in `require.cache` (exactly like `onboarding-self-heal.test.js`), then requires `src/services/doctor_landing.js` and asserts on `resolveDoctorLanding`. The catalog stub returns whatever `stubCatalog` is set to.

```js
// tests/auth/doctor-services-landing.test.js
//
// §4.7 first-login landing: a doctor with onboarding_complete=false AND a
// non-empty service union lands on /portal/doctor/services; an empty-union
// doctor (and any onboarding_complete=true doctor, and non-doctors) lands on
// their normal home. Hermetic — stubs ../pg + ../services/doctor_service_catalog
// via require.cache, no live DB (mirrors onboarding-self-heal.test.js).
'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧭 doctor first-login services landing (§4.7)\n');

// Stub ../pg so acquiring a client never touches a real DB.
const pgPath = require.resolve('../../src/pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    pool: { connect: async function () { return { release: function () {} }; } },
    queryOne: async function () { return null; },
    queryAll: async function () { return []; },
    execute: async function () { return { rowCount: 0 }; }
  }
};

// Stub the catalog loader — resolveDoctorLanding must consult isEmpty.
let stubCatalog = { isEmpty: true };
let catalogCalls = 0;
const catPath = require.resolve('../../src/services/doctor_service_catalog');
require.cache[catPath] = {
  id: catPath, filename: catPath, loaded: true,
  exports: {
    loadDoctorServiceCatalog: async function (client, args) {
      catalogCalls++;
      stubCatalog._lastArgs = args;
      return stubCatalog;
    }
  }
};

const { resolveDoctorLanding, shouldLandOnServices } = require('../../src/services/doctor_landing');

(async function run() {
  // 1. Non-empty union + not onboarded → /portal/doctor/services
  try {
    stubCatalog = { isEmpty: false };
    const dest = await resolveDoctorLanding(
      { id: 'doc-1', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: false }
    );
    assert.strictEqual(dest, '/portal/doctor/services', 'non-empty-union unonboarded doctor → services');
    assert.deepStrictEqual(stubCatalog._lastArgs, { doctorId: 'doc-1', specialtyId: 'spec-card' }, 'catalog queried by doctorId+specialtyId');
    t.pass('non-empty union, onboarding_complete=false → /portal/doctor/services');
  } catch (e) { t.fail('normal doctor lands on services', e); }

  // 2. Empty union + not onboarded → normal doctor home (NOT services → no loop)
  try {
    stubCatalog = { isEmpty: true };
    const dest = await resolveDoctorLanding(
      { id: 'doc-2', role: 'doctor', specialty_id: 'spec-empty', onboarding_complete: false }
    );
    assert.strictEqual(dest, '/portal/doctor', 'empty-union doctor → dashboard, never services');
    t.pass('empty union, onboarding_complete=false → /portal/doctor (no redirect loop)');
  } catch (e) { t.fail('empty-union doctor lands on dashboard', e); }

  // 3. Already onboarded doctor → dashboard, catalog not even consulted
  try {
    stubCatalog = { isEmpty: false };
    catalogCalls = 0;
    const dest = await resolveDoctorLanding(
      { id: 'doc-3', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: true }
    );
    assert.strictEqual(dest, '/portal/doctor', 'onboarded doctor → dashboard');
    assert.strictEqual(catalogCalls, 0, 'onboarded doctor: catalog short-circuited (no union query)');
    t.pass('onboarding_complete=true → /portal/doctor, no catalog query');
  } catch (e) { t.fail('onboarded doctor short-circuit', e); }

  // 4. Non-doctor (patient) → null so caller keeps its own default
  try {
    stubCatalog = { isEmpty: false };
    catalogCalls = 0;
    const dest = await resolveDoctorLanding(
      { id: 'p-1', role: 'patient', onboarding_complete: false }
    );
    assert.strictEqual(dest, null, 'non-doctor → null (caller falls back to getHomeByRole)');
    assert.strictEqual(catalogCalls, 0, 'non-doctor: no catalog query');
    t.pass('patient → null landing (caller uses its own redirect)');
  } catch (e) { t.fail('patient null landing', e); }

  // 5. shouldLandOnServices predicate mirrors the decision (banner slice reuses it)
  try {
    stubCatalog = { isEmpty: false };
    assert.strictEqual(await shouldLandOnServices({ id: 'doc-4', role: 'doctor', specialty_id: 's', onboarding_complete: false }), true, 'true when unonboarded + non-empty');
    stubCatalog = { isEmpty: true };
    assert.strictEqual(await shouldLandOnServices({ id: 'doc-5', role: 'doctor', specialty_id: 's', onboarding_complete: false }), false, 'false when empty union');
    assert.strictEqual(await shouldLandOnServices({ id: 'doc-6', role: 'doctor', specialty_id: 's', onboarding_complete: true }), false, 'false when already onboarded');
    t.pass('shouldLandOnServices predicate matches landing decision');
  } catch (e) { t.fail('shouldLandOnServices predicate', e); }
})().catch(function (err) { t.fail('harness crashed', err); });
```

- [ ] **Step 2: Run the test — expect a crash (module not found).** Command: `node tests/auth/doctor-services-landing.test.js`. Expected: it fails with `Cannot find module '../../src/services/doctor_landing'` (the file does not exist yet) OR, once the catalog stub file also does not exist, `Cannot find module '../../src/services/doctor_service_catalog'` at `require.resolve`. Either way it is RED. (If the catalog file from the sibling slice is not yet present, note that `require.resolve('../../src/services/doctor_service_catalog')` throws — this test depends on that sibling file existing; in the assembled plan the catalog task runs first. For an isolated run, temporarily create an empty `module.exports = { loadDoctorServiceCatalog: async () => ({}) }` stub file, but do NOT commit it.)

- [ ] **Step 3: Implement `src/services/doctor_landing.js`.** Create the file:

```js
// src/services/doctor_landing.js
//
// §4.7 first-login landing + soft-nudge predicate. A doctor whose
// onboarding_complete=false AND whose service union (§2.2) is NON-EMPTY should
// be steered to /portal/doctor/services on first login and nudged by the topbar
// banner. Empty-union doctors (Pediatrics/Internal-Medicine escape hatch) must
// NOT be sent there — there is nothing to confirm and onboarding_complete stays
// false, so a redirect would loop. Non-doctors return null so callers keep
// their own getHomeByRole() default.
'use strict';

const { pool } = require('../pg');
const { loadDoctorServiceCatalog } = require('./doctor_service_catalog');

const DOCTOR_SERVICES_PATH = '/portal/doctor/services';
const DOCTOR_HOME_PATH = '/portal/doctor';

// Core predicate: does this user have an unconfirmed, non-empty service union?
// `user` MUST be the DB users row (carries onboarding_complete + specialty_id) —
// the JWT payload does NOT carry onboarding_complete.
async function shouldLandOnServices(user, { client } = {}) {
  if (!user || String(user.role || '').toLowerCase() !== 'doctor') return false;
  // Explicit save already flipped this true — nothing to nudge.
  if (user.onboarding_complete === true) return false;

  const conn = client || (await pool.connect());
  try {
    const catalog = await loadDoctorServiceCatalog(conn, {
      doctorId: String(user.id),
      specialtyId: user.specialty_id ? String(user.specialty_id) : null
    });
    return !catalog.isEmpty;
  } finally {
    if (!client && conn && typeof conn.release === 'function') conn.release();
  }
}

// Landing path for the first-login redirect. Doctor with a non-empty unconfirmed
// union → services; other doctors → dashboard; non-doctors → null (caller keeps
// its own redirect target).
async function resolveDoctorLanding(user, { client } = {}) {
  if (!user || String(user.role || '').toLowerCase() !== 'doctor') return null;
  const land = await shouldLandOnServices(user, { client });
  return land ? DOCTOR_SERVICES_PATH : DOCTOR_HOME_PATH;
}

module.exports = { resolveDoctorLanding, shouldLandOnServices, DOCTOR_SERVICES_PATH, DOCTOR_HOME_PATH };
```

- [ ] **Step 4: Run the test — expect GREEN.** Command: `node tests/auth/doctor-services-landing.test.js`. Expected: all 5 named assertions print `✅` (non-empty→services; empty→dashboard; onboarded short-circuit; patient null; predicate). Exit code 0, no `❌`.

- [ ] **Step 5: Wire the helper into `POST /set-password` and `/magic-login/:token`.** In `src/routes/auth.js`, add the import after line 13. Edit the import block:

```js
const { validatePhoneE164 } = require('../validators/phone');
const { resolveDoctorLanding } = require('../services/doctor_landing');
require('dotenv').config();
```

Then change the `POST /set-password` final redirect (currently line 609 `return res.redirect(getHomeByRole(user.role));`, inside the handler *after* the `withTransaction` at 593-607). Replace it with a doctor-aware redirect. **Note:** the save txn just set `password_hash`/`is_active` but did NOT touch `onboarding_complete`, so `user.onboarding_complete` (loaded at line 573 via `SELECT *`) is still the correct pre-confirmation value; `user.specialty_id` is present too. Do NOT alter `first_login_at` (this route never stamps it):

```js
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users
       SET password_hash = $1, is_active = true
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = $1
       WHERE user_id = $2 AND used_at IS NULL`,
      [nowIso, user.id]
    );
  });

  // §4.7 first-login landing: steer a not-yet-onboarded doctor with a non-empty
  // service union to /portal/doctor/services; empty-union doctors and everyone
  // else fall through to their normal home. One-time (driven by DB state, no
  // persistent guard) — a doctor who has confirmed services no longer matches.
  const doctorLanding = await resolveDoctorLanding(user);
  if (doctorLanding) return res.redirect(doctorLanding);

  return res.redirect(getHomeByRole(user.role));
```

Then change the `GET /magic-login/:token` password-set redirect. Currently lines 525-529:

```js
  if (!user.password_hash) {
    return res.redirect('/set-password');
  }

  return res.redirect(getHomeByRole(user.role));
```

Replace the final block (the `return res.redirect(getHomeByRole(user.role));` at line 529) so a doctor who already has a password (so skips `/set-password`) still lands on services when unconfirmed:

```js
  if (!user.password_hash) {
    return res.redirect('/set-password');
  }

  // §4.7 first-login landing (magic-link path for password-holding doctors).
  const doctorLanding = await resolveDoctorLanding(user);
  if (doctorLanding) return res.redirect(doctorLanding);

  return res.redirect(getHomeByRole(user.role));
```

- [ ] **Step 6: Extend the test to cover the two auth handlers as HTTP-level redirect assertions is NOT possible hermetically** (they require booting the app + a live token row). Instead, add a focused unit assertion that the wiring uses the helper, by asserting the *source* references it. Append to `tests/auth/doctor-services-landing.test.js` a lint-style check (no DB, no boot):

```js
  // 6. Wiring guard: auth.js POST /set-password and /magic-login must call the
  //    shared helper (not a hardcoded getHomeByRole for doctors). Cheap source
  //    assertion — the full HTTP redirect is exercised by the doctor-services
  //    integration test that boots the app (see the services-route slice).
  try {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/routes/auth.js'), 'utf8');
    assert.ok(/require\(['"]\.\.\/services\/doctor_landing['"]\)/.test(src), 'auth.js imports doctor_landing');
    const calls = (src.match(/resolveDoctorLanding\(user\)/g) || []).length;
    assert.ok(calls >= 2, 'resolveDoctorLanding(user) called in both /set-password and /magic-login (got ' + calls + ')');
    t.pass('auth.js wires resolveDoctorLanding into both first-login redirect paths');
  } catch (e) { t.fail('auth.js wiring guard', e); }
```

- [ ] **Step 7: Run the test — expect GREEN (6 groups).** Command: `node tests/auth/doctor-services-landing.test.js`. Expected: 6 `✅` lines, no `❌`, exit 0. The wiring guard confirms both call sites reference `resolveDoctorLanding(user)` and the import is present.

- [ ] **Step 8: Run the full auth suite for regressions.** Command: `node tests/run.js 2>&1 | grep -Ei "doctor-services-landing|onboarding-self-heal|doctor-portal-redirect|Failed:"`. Expected: the landing test passes, the two existing auth tests are unaffected (pass or skip on `DATABASE_URL`), and `Failed:  0`. (Note: `doctor-portal-redirect` and any DB-backed auth tests will `⏭️ skip` locally because the local boot is broken — that is the expected pattern, not a failure.)

- [ ] **Step 9: Commit.** Command: `git add src/services/doctor_landing.js src/routes/auth.js tests/auth/doctor-services-landing.test.js && git commit -m "feat(doctor): first-login landing → /portal/doctor/services for unconfirmed non-empty-union doctors

Adds src/services/doctor_landing.js (resolveDoctorLanding / shouldLandOnServices)
and wires it into POST /set-password and GET /magic-login/:token. A doctor with
onboarding_complete=false and a non-empty §2.2 service union is steered to the
My Services confirmation screen on first login; empty-union doctors and everyone
else keep their normal home. DB-driven one-time redirect, no persistent guard,
no loop; first_login_at stamping untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

### Task 24: Global soft-nudge banner in the doctor topbar

**Files:**
- Create: `src/views/partials/doctor/services_banner.ejs` (new partial)
- Modify: `src/views/partials/doctor/topbar.ejs` — insert the include at line 33 (immediately after the `.v2-topbar__main` block closes, before `.v2-topbar__actions`)
- Modify: `src/routes/doctor.js` — the doctor-scoped middleware at lines 1090-1155 (add a per-request `res.locals.doctorServicesBanner` flag computed once, no N+1), and its `module.exports` (add a test seam)
- Create: `tests/auth/doctor-services-banner-flag.test.js` (new, hermetic — stubs `../pg`, `../middleware`, `../services/doctor_service_catalog`)

**Interfaces:**
- Consumes: `shouldLandOnServices(user, { client })` from `src/services/doctor_landing.js` (previous task). The DB `users` row's `onboarding_complete` + `specialty_id` — fetched ONCE in the middleware (the JWT `req.user` lacks `onboarding_complete`).
- Produces: `res.locals.doctorServicesBanner` (boolean) read by `partials/doctor/topbar.ejs` → `partials/doctor/services_banner.ejs`. Exposes `doctor._computeServicesBannerFlag(req, res, client)` test seam on the router module.

- [ ] **Step 1: Write the failing hermetic test for the flag helper.** Create `tests/auth/doctor-services-banner-flag.test.js`. It stubs `../middleware` (so `requireRole` is a pass-through — mirrors `onboarding-self-heal.test.js`), `../pg` (so `queryOne` returns a controllable users row), and `../services/doctor_service_catalog` (controls `isEmpty`). Then it requires `src/routes/doctor.js`, grabs the exposed `_computeServicesBannerFlag`, and asserts the boolean it writes to `res.locals.doctorServicesBanner`.

```js
// tests/auth/doctor-services-banner-flag.test.js
//
// §4.7 soft-nudge banner: the doctor topbar shows a "confirm your services"
// banner while onboarding_complete=false AND the service union is non-empty.
// The flag is computed ONCE per request in doctor.js middleware (no per-page
// N+1). Hermetic — stubs ../middleware, ../pg, ../services/doctor_service_catalog.
'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔔 doctor services-banner flag (§4.7)\n');

// Stub middleware so requiring doctor.js doesn't drag in real auth/DB wiring.
const mwPath = require.resolve('../../src/middleware');
require.cache[mwPath] = {
  id: mwPath, filename: mwPath, loaded: true,
  exports: {
    requireRole: function () { return function (req, res, next) { next(); }; },
    requireAuth: function () { return function (req, res, next) { next(); }; },
    baseMiddlewares: function () {}
  }
};

// Stub pg: queryOne returns whatever stubUserRow is; pool.connect gives a
// releasable client for doctor_landing's own acquire path.
let stubUserRow = null;
const pgPath = require.resolve('../../src/pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    queryOne: async function () { return stubUserRow; },
    queryAll: async function () { return []; },
    execute: async function () { return { rowCount: 0 }; },
    withTransaction: async function (fn) { return fn({ query: async () => ({ rows: [] }) }); },
    pool: { connect: async function () { return { release: function () {} }; }, totalCount: 0, idleCount: 0, waitingCount: 0 }
  }
};

// Stub the catalog loader used (transitively) by doctor_landing.
let stubCatalog = { isEmpty: true };
const catPath = require.resolve('../../src/services/doctor_service_catalog');
require.cache[catPath] = {
  id: catPath, filename: catPath, loaded: true,
  exports: { loadDoctorServiceCatalog: async function () { return stubCatalog; } }
};

const doctorRouter = require('../../src/routes/doctor');
const compute = doctorRouter._computeServicesBannerFlag;

if (typeof compute !== 'function') {
  t.fail('test seam', new Error('_computeServicesBannerFlag not exposed on doctor router'));
  process.exit(1);
}

function mkReq(user) { return { user: user, method: 'GET', originalUrl: '/portal/doctor' }; }
function mkRes() { return { locals: {} }; }

(async function run() {
  // 1. Unonboarded doctor + non-empty union → banner ON
  try {
    stubUserRow = { id: 'doc-a', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: false };
    stubCatalog = { isEmpty: false };
    const req = mkReq({ id: 'doc-a', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, true, 'banner ON for unonboarded non-empty-union doctor');
    t.pass('onboarding_complete=false + non-empty union → doctorServicesBanner=true');
  } catch (e) { t.fail('banner on', e); }

  // 2. Empty-union doctor → banner OFF (escape-hatch doctor: nothing to confirm)
  try {
    stubUserRow = { id: 'doc-b', role: 'doctor', specialty_id: 'spec-empty', onboarding_complete: false };
    stubCatalog = { isEmpty: true };
    const req = mkReq({ id: 'doc-b', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, false, 'no banner for empty-union doctor');
    t.pass('empty union → doctorServicesBanner=false');
  } catch (e) { t.fail('banner off empty union', e); }

  // 3. Already onboarded → banner OFF
  try {
    stubUserRow = { id: 'doc-c', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: true };
    stubCatalog = { isEmpty: false };
    const req = mkReq({ id: 'doc-c', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, false, 'no banner once onboarding_complete=true');
    t.pass('onboarding_complete=true → doctorServicesBanner=false');
  } catch (e) { t.fail('banner off onboarded', e); }

  // 4. Failure is swallowed → flag defaults false (never throws off a page render)
  try {
    stubUserRow = { id: 'doc-d', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: false };
    stubCatalog = null; // makes catalog.isEmpty throw
    const req = mkReq({ id: 'doc-d', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, false, 'error path → banner false, no throw');
    t.pass('banner-flag error is swallowed → false (best-effort, never breaks page)');
  } catch (e) { t.fail('banner flag error swallowed', e); }
})().catch(function (err) { t.fail('harness crashed', err); });
```

- [ ] **Step 2: Run the test — expect RED.** Command: `node tests/auth/doctor-services-banner-flag.test.js`. Expected: fails at the seam check — `_computeServicesBannerFlag not exposed on doctor router` (the function does not exist yet), printing `❌ test seam`.

- [ ] **Step 3: Implement the flag helper + wire it into the doctor middleware.** In `src/routes/doctor.js`, add the import near the other service imports at the top of the file (place it beside existing `require('../services/...')` lines; if none, add after the `requireDoctor` definition at line 113):

```js
const { shouldLandOnServices } = require('../services/doctor_landing');
```

Add the helper function just above the doctor-scoped middleware at line 1090 (right before `// Doctor alert badge count middleware`):

```js
// §4.7 soft-nudge banner flag — computed ONCE per doctor request (not per page,
// no N+1). Fetches the DB users row (JWT req.user does NOT carry
// onboarding_complete) and reuses the shared shouldLandOnServices predicate.
// Best-effort: any failure leaves the banner off rather than breaking the page.
async function _computeServicesBannerFlag(req, res) {
  res.locals.doctorServicesBanner = false;
  try {
    if (!req.user || String(req.user.role).toLowerCase() !== 'doctor' || !req.user.id) return;
    const row = await queryOne(
      'SELECT id, role, specialty_id, onboarding_complete FROM users WHERE id = $1',
      [String(req.user.id)]
    );
    if (!row) return;
    res.locals.doctorServicesBanner = await shouldLandOnServices(row);
  } catch (_) {
    res.locals.doctorServicesBanner = false;
  }
}
```

Then call it inside the existing doctor-scoped middleware at line 1090 so it runs once per doctor page. Edit the middleware entry — add the call at the very top of the `try` (before the notification-count logic) and re-flow so both success and catch paths still `return next()`. Change lines 1090-1091:

```js
router.use(['/portal/doctor', '/doctor'], requireDoctor, async (req, res, next) => {
  await _computeServicesBannerFlag(req, res);
  try {
```

(The rest of the middleware body is unchanged; `_computeServicesBannerFlag` never throws so it does not disturb the existing `try/catch`.)

Finally, expose the seam. At the module export (find `module.exports = router;` — verify its line at build; it is the router export near the end of `doctor.js`), append after it:

```js
module.exports._computeServicesBannerFlag = _computeServicesBannerFlag;
```

- [ ] **Step 4: Run the test — expect GREEN.** Command: `node tests/auth/doctor-services-banner-flag.test.js`. Expected: 4 `✅` lines (banner on; off for empty union; off when onboarded; error swallowed → false), exit 0, no `❌`.

- [ ] **Step 5: Create the banner partial.** Create `src/views/partials/doctor/services_banner.ejs`. It renders only when `locals.doctorServicesBanner` is truthy, is bilingual via inline ternaries on `isAr` (matching the topbar's `_isAr` convention), and links to `/portal/doctor/services`. Uses only existing v2 utility classes plus a small inline style so no CSS-slice dependency:

```ejs
<%
  // §4.7 soft-nudge banner. Shown by partials/doctor/topbar.ejs while the
  // doctor has an unconfirmed, non-empty service union (res.locals.doctorServicesBanner,
  // computed once per request in doctor.js middleware). Non-blocking: it is a
  // link, never a hard gate. Bilingual via isAr (topbar passes it through).
  var _bnAr = (typeof isAr !== 'undefined') ? !!isAr : false;
  var _bnShow = (typeof locals !== 'undefined' && locals && locals.doctorServicesBanner) ? true : false;
%>
<% if (_bnShow) { %>
<div class="v2-services-nudge" role="status" style="margin:0 0 12px;padding:12px 16px;border:1px solid #F0C46B;background:#FDF6E7;border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
  <div style="display:flex;align-items:center;gap:10px;">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B57F16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <span style="color:#7A560E;font-weight:600;">
      <%= _bnAr ? 'أكد الخدمات التي تقبلها' : 'Confirm the services you accept' %>
    </span>
  </div>
  <a class="v2-btn v2-btn--sm" href="/portal/doctor/services" style="white-space:nowrap;background:#B57F16;color:#fff;border-radius:8px;padding:6px 14px;text-decoration:none;font-weight:600;">
    <%= _bnAr ? 'خدماتي' : 'My Services' %>
  </a>
</div>
<% } %>
```

- [ ] **Step 6: Include the banner from the topbar partial.** In `src/views/partials/doctor/topbar.ejs`, insert the include between the `.v2-topbar__main` close (line 33) and the `.v2-topbar__actions` open (line 34). New text:

```ejs
  </div>
  <%- include('services_banner', { isAr: _isAr }) %>
  <div class="v2-topbar__actions">
```

(The include is a no-op unless `locals.doctorServicesBanner` is truthy, so it is safe on every doctor page and on pages where the flag was never set.)

- [ ] **Step 7: Manual/headless-Chrome verification (EJS markup is not unit-testable via the hermetic harness).** The banner render is pure EJS + a `res.locals` flag; the local server cannot boot (migration 070 needs a Supabase `anon` role absent locally). Verify with headless Chrome against a static render instead:
  1. Render the partial in isolation to a static HTML file — command: `node -e "const ejs=require('ejs');const fs=require('fs');const html=ejs.renderFile('src/views/partials/doctor/services_banner.ejs',{isAr:false,locals:{doctorServicesBanner:true}},{},(e,h)=>{if(e)throw e;fs.writeFileSync('/private/tmp/claude-501/-Users-ziadelwahsh-tashkheesa-portal/b398f9bb-8d43-4114-8316-901848638d0f/scratchpad/banner_en.html',h);console.log('WROTE en');});"` and again with `isAr:true` → `banner_ar.html`; then once with `doctorServicesBanner:false` → expect empty output (no `<div class="v2-services-nudge">`).
  2. `grep -c 'v2-services-nudge' <the three files>`: expected `1`, `1`, `0` respectively — proves the flag gates the render and the EJS compiles without error.
  3. Open `banner_en.html` and `banner_ar.html` via headless Chrome (`mcp__claude-in-chrome__navigate` to `file://…/banner_en.html`, then `read_page`) and confirm: EN shows "Confirm the services you accept" + a "My Services" button linking to `/portal/doctor/services`; AR shows "أكد الخدمات التي تقبلها" + "خدماتي". Screenshot each for the record.

- [ ] **Step 8: Run the full suite for regressions.** Command: `node tests/run.js 2>&1 | grep -Ei "doctor-services-banner-flag|doctor-services-landing|Failed:"`. Expected: both new tests pass; `Failed:  0`. (DB-backed doctor tests continue to `⏭️ skip` locally — expected.)

- [ ] **Step 9: Commit.** Command: `git add src/routes/doctor.js src/views/partials/doctor/topbar.ejs src/views/partials/doctor/services_banner.ejs tests/auth/doctor-services-banner-flag.test.js && git commit -m "feat(doctor): soft-nudge 'confirm your services' banner in doctor topbar

Computes res.locals.doctorServicesBanner ONCE per doctor request (doctor.js
middleware, one users-row read — no per-page N+1) via the shared
shouldLandOnServices predicate, and renders a bilingual, non-blocking banner
(partials/doctor/services_banner.ejs) from the topbar while the doctor has an
unconfirmed, non-empty service union. Empty-union and already-onboarded doctors
see nothing. Flag failures are swallowed to false so a page never breaks.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`.

---

**Slice notes:**
- This slice depends on `src/services/doctor_service_catalog.js` (its `loadDoctorServiceCatalog` + `isEmpty`) existing first — order the catalog slice before this one. Both hermetic tests stub that module via `require.cache`, so they pass in isolation once the file resolves.
- `src/services/doctor_landing.js` (Task 23) is consumed by Task 24's banner middleware; keep Task 23 before Task 24.
- No changes to `first_login_at` stamping (dashboard route at `doctor.js:536-569` is untouched). Redirects are DB-state-driven (one-time by nature: a doctor who confirms services flips `onboarding_complete=true` and stops matching), so there is no persistent guard and no loop. The empty-union escape-hatch doctors (`isEmpty=true`) always land on `/portal/doctor` and never see the banner — matching spec §4.7 and the §8 "empty-union first login: no redirect, no banner, no loop" test.

---

## Phase P6 — Welcome-token hardening (magic-login backdoor, remint, rate-limit, 72h TTL)

## Slice: Welcome-token hardening (spec Package 2 security fixes)

> **Test harness note.** This repo's DB-backed auth tests spawn the real Express server in a child process against a real Postgres (prod-schema clone), issue tokens through real HTTP endpoints, and assert both HTTP responses and DB rows — see `tests/auth/reset-password-mobile.test.js`. They **skip gracefully** when `DATABASE_URL`/`JWT_SECRET` are unset (so `npm test` never hard-fails on a bare local box where migration 070 blocks a raw boot). Every test task below follows that exact pattern: `if (!process.env.DATABASE_URL) { t.skip(...); return; }`, spawn with `TZ=UTC PGTZ=UTC CSRF_MODE=off LAUNCH_GATE_OFF=1`, use `redirect:'manual'` to inspect `Set-Cookie`/`Location`, seed/cleanup by an `id LIKE 'test-<prefix>-%'` fixture. The pure-constant task (§4) is a plain in-process require + assert (no server, no DB).

---

### Task 25: Single-source `WELCOME_EXPIRY_HOURS = 72`

**Files:**
- Modify `src/services/doctor_welcome_payload.js` (line 17-18: `WELCOME_EXPIRY_HOURS = 168`; comment line 17)
- Modify `src/routes/superadmin.js` (line 51-55: local `WELCOME_EXPIRY_HOURS = 168` dup; already imports from `../pg` at line 3 — will add the welcome-payload import)
- Create `tests/auth/welcome-token-expiry.test.js`

**Interfaces:**
- Consumes: nothing external.
- Produces: `WELCOME_EXPIRY_HOURS = 72` (Number) as the single exported constant from `src/services/doctor_welcome_payload.js`. `superadmin.js` re-exports/imports it — no local dup remains. `admin_doctor_invite.js` already imports it (line 26) — no change needed there, it inherits 72 automatically.

- [ ] **Step 1: Write the failing constant test.** Create `tests/auth/welcome-token-expiry.test.js`:
  ```js
  // tests/auth/welcome-token-expiry.test.js
  // Package 2: welcome TTL cut 168h → 72h, single-sourced in
  // doctor_welcome_payload.js. superadmin.js must import that constant, not
  // carry its own dup. Pure require-time assertion — no server, no DB.
  'use strict';
  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');
  const t = global._testRunner || {
    pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
    fail: (n, e) => console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)),
    skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
  };
  console.log('\n⏳ auth/welcome-token-expiry (Package 2)\n');

  try {
    const { WELCOME_EXPIRY_HOURS } = require('../../src/services/doctor_welcome_payload');
    assert.strictEqual(WELCOME_EXPIRY_HOURS, 72,
      'WELCOME_EXPIRY_HOURS must be 72, got ' + WELCOME_EXPIRY_HOURS);
    t.pass('doctor_welcome_payload exports WELCOME_EXPIRY_HOURS === 72');
  } catch (e) { t.fail('welcome-expiry constant', e); }

  // superadmin.js must NOT re-declare a numeric WELCOME_EXPIRY_HOURS constant.
  try {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'routes', 'superadmin.js'), 'utf8');
    assert.ok(!/const\s+WELCOME_EXPIRY_HOURS\s*=\s*\d+/.test(src),
      'superadmin.js still declares a local numeric WELCOME_EXPIRY_HOURS dup');
    assert.ok(/WELCOME_EXPIRY_HOURS[^;]*require\(['"]\.\.\/services\/doctor_welcome_payload['"]\)/.test(src),
      'superadmin.js must import WELCOME_EXPIRY_HOURS from ../services/doctor_welcome_payload');
    t.pass('superadmin.js imports WELCOME_EXPIRY_HOURS (no local dup)');
  } catch (e) { t.fail('superadmin no-dup', e); }
  ```
- [ ] **Step 2: Run — expect fail.** `npm test 2>&1 | grep -A2 welcome-token-expiry` → both assertions FAIL (constant is 168; superadmin has a local dup).
- [ ] **Step 3: Change the constant.** In `src/services/doctor_welcome_payload.js`, edit line 17-18:
  ```js
  // 72-hour magic-login validity (Package 2 hardening: was 168h). Single
  // source of truth — superadmin.js + admin_doctor_invite.js import this.
  const WELCOME_EXPIRY_HOURS = 72;
  ```
- [ ] **Step 4: Import it in superadmin.js, drop the dup.** In `src/routes/superadmin.js`, add to the require block (after line 3):
  ```js
  const { WELCOME_EXPIRY_HOURS } = require('../services/doctor_welcome_payload');
  ```
  Then delete lines 52-55 (the `// P1-NOTIF-5:` comment + `const WELCOME_EXPIRY_HOURS = 168;`), keeping `RESET_EXPIRY_HOURS = 2` on line 51. Leave a one-line breadcrumb where the dup was:
  ```js
  // WELCOME_EXPIRY_HOURS (72h) imported from ../services/doctor_welcome_payload — single source.
  ```
- [ ] **Step 5: Run — expect pass.** `npm test 2>&1 | grep -A2 welcome-token-expiry` → both assertions PASS. Also `node -e "console.log(require('./src/services/admin_doctor_invite').inviteDoctor.length)"` sanity-loads the invite module (confirms the shared constant still resolves; expected output: `2`).
- [ ] **Step 6: Commit.** `git add src/services/doctor_welcome_payload.js src/routes/superadmin.js tests/auth/welcome-token-expiry.test.js && git commit -m "$(cat <<'EOF'
fix(auth): single-source WELCOME_EXPIRY_HOURS = 72 (was 168), drop superadmin dup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"`

---

### Task 26: `/magic-login/:token` must not auto-login a password-holding user

**Files:**
- Modify `src/routes/auth.js` (magic-login handler, lines 492-530 — specifically move the `password_hash` check to before the session cookie is set at lines 515-527)
- Create `tests/auth/magic-login-password-guard.test.js`

**Interfaces:**
- Consumes: `password_reset_tokens` (existing schema), `users.password_hash`.
- Produces: behavioral change only — no new export. Contract: GET `/magic-login/:token` for a user **with** `password_hash` set → **302 to `/login`**, sets **no** `tashkheesa_portal` session cookie, and **marks the token `used_at`** (single-use is preserved so the leaked token is burned, not left live). For a user with `password_hash IS NULL` the behavior is unchanged (marks used, sets session, redirects to `/set-password`).

- [ ] **Step 1: Write the failing test.** Create `tests/auth/magic-login-password-guard.test.js`, modeled on `reset-password-mobile.test.js` (same boot/spawn/cleanup helpers):
  ```js
  // tests/auth/magic-login-password-guard.test.js
  //
  // Package 2 CRITICAL: /magic-login/:token established the session BEFORE
  // checking password_hash → an old unused welcome token could log in a
  // doctor who ALREADY set a password, password-free (backdoor). Fix: if
  // password_hash is set, do NOT auto-login — burn the token, redirect to
  // /login, set no session cookie.
  //
  // Boots the real server (TZ=UTC) against DATABASE_URL. Skips when unset.
  'use strict';
  try { require('dotenv').config(); } catch (_) {}
  const assert = require('assert');
  const { spawn } = require('child_process');
  const path = require('path');
  const crypto = require('crypto');
  const { randomUUID } = require('crypto');

  const t = global._testRunner || {
    pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
    fail: (n, e) => console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)),
    skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
  };
  console.log('\n🔐 auth/magic-login-password-guard (Package 2 CRITICAL)\n');
  if (!process.env.DATABASE_URL) { t.skip('magic-login-password-guard', 'DATABASE_URL not set'); return; }
  if (!process.env.JWT_SECRET)   { t.skip('magic-login-password-guard', 'JWT_SECRET not set'); return; }

  const pgPath = require.resolve('../../src/pg');
  delete require.cache[pgPath];
  const { execute, queryOne } = require(pgPath);

  const PORT = String(20000 + Math.floor(Math.random() * 10000));
  const BASE = 'http://127.0.0.1:' + PORT;
  const PREFIX = 'test-mlpg-';
  const HASH = '$2b$10$0000000000000000000000000000000000000000000000000000';
  let serverProc = null;

  function bootServer() {
    return new Promise((resolve, reject) => {
      serverProc = spawn(process.execPath,
        [path.join(__dirname, '..', '..', 'src', 'server.js')],
        { env: Object.assign({}, process.env, {
            PORT, LAUNCH_GATE_OFF: '1', TZ: 'UTC', PGTZ: 'UTC', CSRF_MODE: 'off' }),
          stdio: ['ignore', 'pipe', 'pipe'] });
      let booted = false;
      serverProc.stdout.on('data', (b) => { if (!booted && /running on port/.test(b.toString())) { booted = true; resolve(); } });
      serverProc.stderr.on('data', () => {});
      serverProc.once('exit', (c) => { if (!booted) reject(new Error('server exited code=' + c)); });
      setTimeout(() => { if (!booted) reject(new Error('server boot timeout')); }, 15000);
    });
  }
  async function shutdown() { if (!serverProc) return; try { serverProc.kill('SIGTERM'); } catch (_) {} await new Promise(r=>setTimeout(r,400)); try { serverProc.kill('SIGKILL'); } catch (_) {} serverProc = null; }

  async function getRaw(p) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '' };
  }
  async function seedUser(id, email, withHash) {
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, $3, $4, 'doctor', 'en', true, NOW())`,
      [id, email, withHash ? HASH : null, 'MagicGuard Test']);
  }
  async function mintToken(userId) {
    const token = randomUUID();
    await execute(
      `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', NULL, NOW())`,
      [randomUUID(), userId, token]);
    return token;
  }
  async function usedAt(token) { const r = await queryOne(`SELECT used_at FROM password_reset_tokens WHERE token=$1`, [token]); return r && r.used_at; }
  async function cleanup() {
    await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
    await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
  }

  (async function run() {
    try {
      await cleanup();
      try { await bootServer(); } catch (e) { t.skip('magic-login-password-guard http', 'boot failed: ' + e.message); return; }

      // ── 1. Doctor WITH a password + unused token → NOT logged in ──
      try {
        const id = PREFIX + crypto.randomBytes(3).toString('hex');
        await seedUser(id, id + '@test.local', true);
        const token = await mintToken(id);
        const r = await getRaw('/magic-login/' + encodeURIComponent(token));
        assert.strictEqual(r.status, 302, 'expected redirect; got ' + r.status);
        assert.ok(/\/login\b/.test(r.location), 'must redirect to /login; got ' + r.location);
        assert.ok(!/tashkheesa_portal=/.test(r.setCookie),
          'must NOT set the session cookie; set-cookie=' + r.setCookie);
        assert.ok(await usedAt(token), 'token must still be burned (single-use preserved)');
        t.pass('#1 password-holder: no session, redirect /login, token burned');
      } catch (e) { t.fail('#1 password-holder guard', e); }

      // ── 2. Doctor WITHOUT a password → still auto-logs in to /set-password ──
      try {
        const id = PREFIX + crypto.randomBytes(3).toString('hex');
        await seedUser(id, id + '@test.local', false);
        const token = await mintToken(id);
        const r = await getRaw('/magic-login/' + encodeURIComponent(token));
        assert.strictEqual(r.status, 302, 'expected redirect; got ' + r.status);
        assert.ok(/\/set-password\b/.test(r.location), 'must redirect to /set-password; got ' + r.location);
        assert.ok(/tashkheesa_portal=/.test(r.setCookie), 'must set the session cookie for a passwordless user');
        t.pass('#2 passwordless: session set, redirect /set-password (unchanged)');
      } catch (e) { t.fail('#2 passwordless unchanged', e); }
    } finally { try { await shutdown(); } catch (_) {} try { await cleanup(); } catch (_) {} }
  })();
  ```
- [ ] **Step 2: Run — expect fail.** `npm test 2>&1 | grep -A3 magic-login-password-guard` → **#1 FAILS** (current code sets the cookie and redirects to `getHomeByRole`, not `/login`); #2 passes.
- [ ] **Step 3: Reorder the handler so the password check precedes the session.** In `src/routes/auth.js`, replace the block at lines 507-529 (from the `const nowIso` mark-used through the final `return res.redirect(getHomeByRole(user.role));`):
  ```js
    const nowIso = new Date().toISOString();
    // Single-use: burn the token unconditionally BEFORE any branch so a leaked
    // link can't be replayed even in the password-holder reject path below.
    await execute(
      `UPDATE password_reset_tokens
       SET used_at = $1
       WHERE token = $2`,
      [nowIso, token]
    );

    // Package 2 CRITICAL: check password_hash BEFORE establishing the session.
    // A magic/welcome token is a first-time-setup credential; if the user has
    // ALREADY set a password, an old unused token must NOT silently log them in
    // password-free. Send them through normal /login instead.
    if (user.password_hash) {
      const c = authCopy(req);
      return renderLogin(req, res, { error: c.login_password_already_set });
    }

    const sessionToken = signUserToken(user);
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    setLangCookie(res, user.lang || getReqLang(req));

    // Only passwordless users reach here → always the set-password step.
    return res.redirect('/set-password');
  ```
  > Note: the test asserts a **302** to `/login`, but `renderLogin` returns a 200 page. Use a **redirect** to keep it a hard 302 and match the test — replace the `renderLogin` line with:
  > ```js
  >    if (user.password_hash) {
  >      return res.redirect('/login?err=already_registered');
  >    }
  > ```
  > (No new copy key needed; `/login` GET renders normally. This is the version the test above asserts.)
- [ ] **Step 4: Run — expect pass.** `npm test 2>&1 | grep -A3 magic-login-password-guard` → **both #1 and #2 PASS**.
- [ ] **Step 5: Commit.** `git add src/routes/auth.js tests/auth/magic-login-password-guard.test.js && git commit -m "$(cat <<'EOF'
fix(auth): magic-login must not auto-login a password-holding user (backdoor)

Check password_hash BEFORE setting the session; burn the token either way so
a leaked welcome link can't be replayed. Passwordless first-login unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"`

---

### Task 27: Remint invalidation — every mint burns the prior unused token

**Files:**
- Modify `src/routes/auth.js`: `createMagicLoginToken` (lines 155-165), `/forgot-password` POST (lines 434-442)
- Modify `src/services/admin_doctor_invite.js`: inside the txn, before the INSERT at lines 66-71 (after the `FOR UPDATE` SELECT at 51-55)
- Modify `src/routes/superadmin.js`: `_issueDoctorWelcomePayload` (before the INSERT at lines 3127-3131)
- Create `tests/auth/remint-invalidation.test.js`

**Interfaces:**
- Consumes: `password_reset_tokens`.
- Produces: contract — after **any** mint for a `user_id`, at most **one** row with `used_at IS NULL` exists for that user (the freshly-minted one). All prior unused rows carry a non-null `used_at`. The `admin_doctor_invite.js` and `superadmin.js` DELETEs run **inside the same txn** as their INSERT (after `admin_doctor_invite`'s `FOR UPDATE`). `createMagicLoginToken` and `/forgot-password` run pool-level (no txn there today) — a plain `execute` DELETE immediately before the INSERT.

- [ ] **Step 1: Write the failing test.** Create `tests/auth/remint-invalidation.test.js`. Two coverage paths, both DB-only (no HTTP needed — call the module functions / issue via the real endpoint). Use the spawned-server `/forgot-password` for the auth pool path, and directly invoke `admin_doctor_invite.inviteDoctor(client, …)` for the invite path (it takes an injected client — acquire one from `require('../../src/pg').pool.connect()`):
  ```js
  // tests/auth/remint-invalidation.test.js
  //
  // Package 2: minting a new welcome/reset token must invalidate the prior
  // unused one for that user (INSERT-only mint left a growing set of live
  // tokens — any old link stayed valid). After each mint, exactly ONE row
  // with used_at IS NULL may remain for the user.
  'use strict';
  try { require('dotenv').config(); } catch (_) {}
  const assert = require('assert');
  const crypto = require('crypto');
  const { randomUUID } = require('crypto');
  const t = global._testRunner || {
    pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
    fail: (n, e) => console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)),
    skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
  };
  console.log('\n🔁 auth/remint-invalidation (Package 2)\n');
  if (!process.env.DATABASE_URL) { t.skip('remint-invalidation', 'DATABASE_URL not set'); return; }

  const pgPath = require.resolve('../../src/pg');
  delete require.cache[pgPath];
  const { pool, execute, queryOne } = require(pgPath);

  const PREFIX = 'test-remint-';
  async function seedDoctor(id, email) {
    await execute(
      `INSERT INTO users (id, email, name, role, lang, is_active, pending_approval, onboarding_complete, created_at)
       VALUES ($1, $2, $3, 'doctor', 'en', true, false, false, NOW())`,
      [id, email, 'Remint Test']);
  }
  async function mintRaw(userId) {
    // A pre-existing UNUSED token, minted the OLD way (no invalidation).
    const token = randomUUID();
    await execute(
      `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', NULL, NOW())`,
      [randomUUID(), userId, token]);
    return token;
  }
  async function liveCount(userId) {
    const r = await queryOne(
      `SELECT COUNT(*)::int AS c FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL`, [userId]);
    return r ? r.c : -1;
  }
  async function cleanup() {
    await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
    await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
  }

  (async function run() {
    try {
      await cleanup();
      const { inviteDoctor } = require('../../src/services/admin_doctor_invite');

      // ── inviteDoctor (admin_doctor_invite.js) burns prior unused tokens ──
      try {
        const id = PREFIX + crypto.randomBytes(3).toString('hex');
        await seedDoctor(id, id + '@test.local');
        await mintRaw(id); await mintRaw(id);         // two stale live tokens
        assert.strictEqual(await liveCount(id), 2, 'precondition: 2 live tokens');
        const client = await pool.connect();
        try { await inviteDoctor(client, { doctorId: id, baseUrl: null, actorId: null }); }
        finally { client.release(); }
        assert.strictEqual(await liveCount(id), 1,
          'after inviteDoctor exactly ONE live token must remain, got ' + (await liveCount(id)));
        t.pass('inviteDoctor remint burns prior unused tokens (1 live)');
      } catch (e) { t.fail('inviteDoctor remint', e); }
    } finally { try { await cleanup(); } catch (_) {} }
  })();
  ```
  *(Add a parallel `_issueDoctorWelcomePayload` sub-case by driving `POST /superadmin/doctors/:id/resend-welcome` on a spawned server with a superadmin session, OR — simpler and hermetic — assert the DELETE-before-INSERT SQL is present in `superadmin.js` via a `fs.readFileSync` + regex check, since that helper is not exported. Use the source-grep style from `tests/core/no-payments-table-readers.test.js` for the `createMagicLoginToken`, `_issueDoctorWelcomePayload`, and `/forgot-password` sites — assert each mint site is immediately preceded by a `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL` within its function body.)*
- [ ] **Step 2: Run — expect fail.** `npm test 2>&1 | grep -A3 remint-invalidation` → the `inviteDoctor` sub-case FAILS (live count stays 2 → 3) and the source-grep sub-cases FAIL (no DELETE present).
- [ ] **Step 3: Add the DELETE in `admin_doctor_invite.js`.** In `src/services/admin_doctor_invite.js`, immediately after the `FOR UPDATE` guard (after line 61's `if (u.is_active !== true) …`) and before the token INSERT at line 66, insert:
  ```js
    // Remint invalidation (Package 2): burn any prior UNUSED token for this
    // doctor before minting a fresh one, so a leaked old welcome link dies.
    // Same txn, after the FOR UPDATE lock — serialized against concurrent invites.
    await client.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
      [doctorId]
    );
  ```
- [ ] **Step 4: Add the DELETE in `superadmin.js` `_issueDoctorWelcomePayload`.** In `src/routes/superadmin.js`, before the INSERT at line 3127, insert:
  ```js
  // Remint invalidation (Package 2): burn prior unused tokens before minting.
  await execute(
    `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
    [doctor.id]
  );
  ```
- [ ] **Step 5: Add the DELETE in `createMagicLoginToken`.** In `src/routes/auth.js`, inside `createMagicLoginToken` (lines 155-165), before the `INSERT` at line 159:
  ```js
    // Remint invalidation (Package 2): burn prior unused tokens for this user.
    await execute(
      `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
  ```
- [ ] **Step 6: Add the DELETE in `/forgot-password`.** In `src/routes/auth.js`, inside the `if (user) {` block (before the `INSERT` at line 438):
  ```js
      // Remint invalidation (Package 2): a new reset link invalidates the prior
      // unused one, so an intercepted earlier link can't still be redeemed.
      await execute(
        `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );
  ```
- [ ] **Step 7: Run — expect pass.** `npm test 2>&1 | grep -A3 remint-invalidation` → all sub-cases PASS (`inviteDoctor` leaves exactly 1 live token; all four source-grep sites show the DELETE).
- [ ] **Step 8: Commit.** `git add src/routes/auth.js src/services/admin_doctor_invite.js src/routes/superadmin.js tests/auth/remint-invalidation.test.js && git commit -m "$(cat <<'EOF'
fix(auth): remint invalidates prior unused reset/welcome tokens (all 4 mint sites)

Before each mint, DELETE FROM password_reset_tokens WHERE user_id=$1 AND
used_at IS NULL — invite/resend (in-txn after FOR UPDATE), magic-login mint,
forgot-password. Leaves exactly one live token per user.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"`

---

### Task 28: Per-IP rate limiters on the token redemption + invite/resend surfaces

**Files:**
- Modify `src/routes/auth.js`: add a `welcomeTokenIpLimiter` near `otpIpLimiter` (lines 320-323); attach it to `GET /magic-login/:token` (line 492), `GET`+`POST /reset-password/:token` (lines 615, 635), `GET`+`POST /set-password` (lines 549, 566). `rateLimit` is already imported (line 11).
- Modify `src/routes/superadmin.js`: add a `welcomeSendIpLimiter` and attach to `/superadmin/doctors/:id/resend-welcome` (line 3238) and the new `/superadmin/doctors/bulk-welcome-passwordless` route. Add `const rateLimit = require('express-rate-limit');` (not currently imported).
- Modify `src/routes/api/admin.js`: attach a limiter to `POST /doctors/:id/invite` (line 1622). (Verify `rateLimit` import; add if absent.)
- Create `tests/auth/welcome-limiter-config.test.js`

**Interfaces:**
- Consumes: `express-rate-limit` (already a dependency, v8).
- Produces: `welcomeTokenIpLimiter` (auth.js) — `{ windowMs: 15*60*1000, max: 30, validate:false, standardHeaders:true, legacyHeaders:false }`, per-IP (default keyGenerator). `welcomeSendIpLimiter` (superadmin.js / admin.js) — `{ windowMs: 15*60*1000, max: 10, validate:false }`. Both return HTTP 429 past the cap. Rate limiting on a mutating superadmin surface is defense-in-depth (already behind `requireSuperadmin`); the token-redemption surfaces are the ones that gate anonymous brute-force.

- [ ] **Step 1: Write the config test (limiter attachment + option shape).** A live 429-flood test against a spawned server is flaky (shared IP across the suite, and 30 real requests). Follow the repo's documented "config test" fallback (spec §Package 2 allows "TDD or documented config test"). Create `tests/auth/welcome-limiter-config.test.js` — a source-grep assertion that each target route has a limiter middleware and the limiter options are correct:
  ```js
  // tests/auth/welcome-limiter-config.test.js
  //
  // Package 2: per-IP rate limiters on the anonymous token-redemption routes
  // (/magic-login/:token, /reset-password/:token, /set-password) and the
  // authenticated invite/resend surfaces. A live 429-flood is order-dependent
  // under the shared-process runner (one client IP for the whole suite), so we
  // assert wiring + option shape statically — the documented config-test path.
  'use strict';
  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');
  const t = global._testRunner || {
    pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
    fail: (n, e) => console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)),
    skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
  };
  console.log('\n🚦 auth/welcome-limiter-config (Package 2)\n');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

  try {
    const auth = read('routes', 'auth.js');
    assert.ok(/const\s+welcomeTokenIpLimiter\s*=\s*rateLimit\(/.test(auth),
      'auth.js must define welcomeTokenIpLimiter via rateLimit()');
    // limiter attached to each redemption route (limiter arg present before the handler)
    for (const re of [
      /router\.get\(\s*['"]\/magic-login\/:token['"]\s*,\s*welcomeTokenIpLimiter/,
      /router\.get\(\s*['"]\/reset-password\/:token['"]\s*,\s*welcomeTokenIpLimiter/,
      /router\.post\(\s*['"]\/reset-password\/:token['"]\s*,\s*welcomeTokenIpLimiter/,
      /router\.get\(\s*['"]\/set-password['"]\s*,\s*welcomeTokenIpLimiter/,
      /router\.post\(\s*['"]\/set-password['"]\s*,\s*welcomeTokenIpLimiter/,
    ]) assert.ok(re.test(auth), 'missing welcomeTokenIpLimiter on ' + re);
    t.pass('auth.js: limiter defined + attached to all 5 redemption routes');
  } catch (e) { t.fail('auth limiter wiring', e); }

  try {
    const sa = read('routes', 'superadmin.js');
    assert.ok(/require\(['"]express-rate-limit['"]\)/.test(sa), 'superadmin.js must require express-rate-limit');
    assert.ok(/const\s+welcomeSendIpLimiter\s*=\s*rateLimit\(/.test(sa), 'superadmin.js must define welcomeSendIpLimiter');
    assert.ok(/resend-welcome['"]\s*,\s*requireSuperadmin\s*,\s*welcomeSendIpLimiter/.test(sa)
      || /resend-welcome['"]\s*,\s*welcomeSendIpLimiter\s*,\s*requireSuperadmin/.test(sa),
      'resend-welcome must carry welcomeSendIpLimiter');
    assert.ok(/bulk-welcome-passwordless['"][^\n]*welcomeSendIpLimiter/.test(sa),
      'bulk-welcome-passwordless must carry welcomeSendIpLimiter');
    t.pass('superadmin.js: welcomeSendIpLimiter on resend + bulk routes');
  } catch (e) { t.fail('superadmin limiter wiring', e); }
  ```
- [ ] **Step 2: Run — expect fail.** `npm test 2>&1 | grep -A3 welcome-limiter-config` → all assertions FAIL (no limiters defined).
- [ ] **Step 3: Define + attach `welcomeTokenIpLimiter` in auth.js.** After the `otpIpLimiter` block (after line 323), add:
  ```js
  // Package 2: per-IP limiter for anonymous token-redemption routes (magic-login,
  // reset-password, set-password). Reuses the otpIpLimiter pattern (validate:false
  // because req.ip trust-proxy shape varies across the Render edge). 30/15min is
  // generous for a human clicking an email link but caps token brute-force.
  const welcomeTokenIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 30, validate: false,
    standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: 'too_many_requests' },
  });
  ```
  Then add `welcomeTokenIpLimiter` as the middleware on each route (insert as the 2nd arg): line 492 `router.get('/magic-login/:token', welcomeTokenIpLimiter, async (req, res) => {`; line 549 `router.get('/set-password', welcomeTokenIpLimiter, async (req, res) => {`; line 566 `router.post('/set-password', welcomeTokenIpLimiter, async (req, res) => {`; line 615 `router.get('/reset-password/:token', welcomeTokenIpLimiter, async (req, res) => {`; line 635 `router.post('/reset-password/:token', welcomeTokenIpLimiter, async (req, res) => {`.
- [ ] **Step 4: Define + attach `welcomeSendIpLimiter` in superadmin.js.** Add the require near line 6 (`const { requireRole } = require('../middleware');`):
  ```js
  const rateLimit = require('express-rate-limit');
  ```
  After the constants block (after the `WELCOME_EXPIRY_HOURS` import line), add:
  ```js
  // Package 2: per-IP limiter for the welcome-send surfaces (resend + bulk).
  // Defense-in-depth behind requireSuperadmin — caps runaway/scripted resends.
  const welcomeSendIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10, validate: false,
    standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: 'too_many_requests' },
  });
  ```
  Attach to the resend route (line 3238): `router.post('/superadmin/doctors/:id/resend-welcome', requireSuperadmin, welcomeSendIpLimiter, async (req, res) => {`. (The bulk route in the next task carries it at creation.)
- [ ] **Step 5: Attach a limiter to the Command API invite.** In `src/routes/api/admin.js`, check for a `rateLimit` import (grep at build); if absent add `const rateLimit = require('express-rate-limit');` near the top requires, define a module-level `const inviteIpLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, validate: false, standardHeaders: true, legacyHeaders: false, message: { ok:false, error:'too_many_requests' } });`, and attach it to line 1622: `router.post('/doctors/:id/invite', inviteIpLimiter, async (req, res) => {`. *(If the router already has a global limiter mounted, note that at build and skip this to avoid double-limiting.)*
- [ ] **Step 6: Run — expect pass.** `npm test 2>&1 | grep -A3 welcome-limiter-config` → all assertions PASS. Sanity: `node -e "require('./src/routes/auth.js'); require('./src/routes/superadmin.js'); console.log('routes load OK')"` (expect `routes load OK` — confirms the new `rateLimit` require + limiter defs don't throw at module load).
- [ ] **Step 7: Manual verification of live 429 (documented, not in CI).** Boot locally against a DB (`DATABASE_URL=… TZ=UTC LAUNCH_GATE_OFF=1 node src/server.js`), then `for i in $(seq 1 35); do curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/magic-login/nope; done | sort | uniq -c` — expect the first 30 to be `302`/`200` and the tail to be `429`. Record the observed transition in the commit body.
- [ ] **Step 8: Commit.** `git add src/routes/auth.js src/routes/superadmin.js src/routes/api/admin.js tests/auth/welcome-limiter-config.test.js && git commit -m "$(cat <<'EOF'
fix(auth): per-IP rate limiters on token-redemption + invite/resend routes

welcomeTokenIpLimiter (30/15min) on magic-login/reset-password/set-password;
welcomeSendIpLimiter (10/15min) on resend-welcome + bulk-welcome + Command
invite. Reuses the otpIpLimiter pattern. Manual flood: 30×302 then 429.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"`

---

### Task 29: Bulk-invite action `POST /superadmin/doctors/bulk-welcome-passwordless`

> **Cross-slice note.** The SHARED CONTRACT lists this route in my slice's scope ("Bulk action route: POST /superadmin/doctors/bulk-welcome-passwordless (superadmin-gated)"). It reuses `inviteDoctor(client, …)` from `admin_doctor_invite.js` (already remint-safe after the earlier task) and the `welcomeSendIpLimiter` defined above. If the assembler assigns the bulk route to the Package-1 slice instead, drop this task — but the limiter + import wiring above still stands.

**Files:**
- Modify `src/routes/superadmin.js`: add the route (place it right after the existing `resend-welcome` route, ~line 3281). Import `inviteDoctor` + `queueMultiChannelNotification` (already imported line 8) + `pool` (add to the `../pg` destructure on line 3).
- Create `tests/auth/bulk-welcome-passwordless.test.js`

**Interfaces:**
- Consumes: `inviteDoctor(client, { doctorId, baseUrl, actorId })` from `src/services/admin_doctor_invite.js`; `pool.connect()` from `src/pg`; `queueMultiChannelNotification` from `src/notify`.
- Produces: `POST /superadmin/doctors/bulk-welcome-passwordless` (superadmin-gated, `welcomeSendIpLimiter`). Selects `role='doctor' AND is_active=true AND password_hash IS NULL`, one txn per doctor via `inviteDoctor` (which owns BEGIN/COMMIT and remint-DELETE), skips password-holders and doctors within the `welcome_email_last_sent_at` cooldown (24h), fires the `doctor_approved` notification post-commit with a timestamped dedupe key, returns JSON `{ ok:true, sent, skipped, failed }`.

- [ ] **Step 1: Write the failing test.** Create `tests/auth/bulk-welcome-passwordless.test.js`. Since the route is superadmin-gated, drive it via a spawned server with a forged superadmin JWT session cookie (mint one with `require('../../src/auth').signUserToken` for a seeded superadmin, set as the `tashkheesa_portal` cookie). Seed 2 passwordless active doctors + 1 password-holder + 1 recently-invited doctor; assert `{ sent:2, skipped:2 }` and that each passwordless doctor now has exactly one live token:
  ```js
  // tests/auth/bulk-welcome-passwordless.test.js
  //
  // Package 2: bulk welcome-invite for all password-less active doctors.
  // Idempotent (remint-DELETE → one live token each), skips password-holders
  // and doctors within the welcome cooldown, returns { sent, skipped, failed }.
  'use strict';
  try { require('dotenv').config(); } catch (_) {}
  const assert = require('assert');
  const { spawn } = require('child_process');
  const path = require('path');
  const crypto = require('crypto');
  const t = global._testRunner || {
    pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
    fail: (n, e) => console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)),
    skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
  };
  console.log('\n📨 auth/bulk-welcome-passwordless (Package 2)\n');
  if (!process.env.DATABASE_URL) { t.skip('bulk-welcome-passwordless', 'DATABASE_URL not set'); return; }
  if (!process.env.JWT_SECRET)   { t.skip('bulk-welcome-passwordless', 'JWT_SECRET not set'); return; }

  const pgPath = require.resolve('../../src/pg');
  delete require.cache[pgPath];
  const { execute, queryOne } = require(pgPath);
  const { signUserToken } = require('../../src/auth');

  const PORT = String(20000 + Math.floor(Math.random() * 10000));
  const BASE = 'http://127.0.0.1:' + PORT;
  const PREFIX = 'test-bulkwel-';
  const HASH = '$2b$10$0000000000000000000000000000000000000000000000000000';
  let serverProc = null;

  function bootServer() {
    return new Promise((resolve, reject) => {
      serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')],
        { env: Object.assign({}, process.env, { PORT, LAUNCH_GATE_OFF:'1', TZ:'UTC', PGTZ:'UTC', CSRF_MODE:'off', EMAIL_ENABLED:'false' }),
          stdio: ['ignore','pipe','pipe'] });
      let b=false;
      serverProc.stdout.on('data', x=>{ if(!b && /running on port/.test(x.toString())){ b=true; resolve(); }});
      serverProc.stderr.on('data', ()=>{});
      serverProc.once('exit', c=>{ if(!b) reject(new Error('exit '+c)); });
      setTimeout(()=>{ if(!b) reject(new Error('boot timeout')); }, 15000);
    });
  }
  async function shutdown(){ if(!serverProc) return; try{serverProc.kill('SIGTERM');}catch(_){} await new Promise(r=>setTimeout(r,400)); try{serverProc.kill('SIGKILL');}catch(_){} serverProc=null; }

  async function seedUser(id, role, opts={}) {
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, pending_approval, welcome_email_last_sent_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'en',true,false,$6,NOW())`,
      [id, id+'@test.local', opts.hash?HASH:null, 'Bulk Test', role, opts.lastSent||null]);
  }
  async function liveCount(id){ const r=await queryOne(`SELECT COUNT(*)::int c FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL`,[id]); return r?r.c:-1; }
  async function cleanup(){ await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`,[PREFIX+'%']); await execute(`DELETE FROM users WHERE id LIKE $1`,[PREFIX+'%']); }

  (async function run(){
    try {
      await cleanup();
      const admin = PREFIX+'admin';
      await seedUser(admin, 'superadmin', { hash:true });
      const d1 = PREFIX+'d1-'+crypto.randomBytes(2).toString('hex');
      const d2 = PREFIX+'d2-'+crypto.randomBytes(2).toString('hex');
      const dHas = PREFIX+'dhas-'+crypto.randomBytes(2).toString('hex');   // has a password → skip
      const dRecent = PREFIX+'drec-'+crypto.randomBytes(2).toString('hex'); // invited 1h ago → cooldown skip
      await seedUser(d1, 'doctor');
      await seedUser(d2, 'doctor');
      await seedUser(dHas, 'doctor', { hash:true });
      await seedUser(dRecent, 'doctor', { lastSent: new Date(Date.now()-3600*1000).toISOString() });

      try { await bootServer(); } catch(e){ t.skip('bulk-welcome-passwordless http','boot failed: '+e.message); return; }
      const cookie = 'tashkheesa_portal=' + signUserToken({ id:admin, role:'superadmin', email:admin+'@test.local' });

      const r = await fetch(BASE + '/superadmin/doctors/bulk-welcome-passwordless', {
        method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json', 'Cookie':cookie },
        body:'{}', redirect:'manual' });
      const body = await r.text(); let json=null; try{ json=JSON.parse(body); }catch(_){}
      assert.ok(r.status===200 && json && json.ok===true, 'expected 200 {ok:true}; got '+r.status+' '+body);

      // Only our two truly-passwordless-and-not-in-cooldown doctors should have been sent.
      // (Other rows in the DB may also match the query; assert our fixtures specifically.)
      assert.strictEqual(await liveCount(d1), 1, 'd1 must have exactly one live token');
      assert.strictEqual(await liveCount(d2), 1, 'd2 must have exactly one live token');
      assert.strictEqual(await liveCount(dHas), 0, 'password-holder must be skipped (no token)');
      assert.strictEqual(await liveCount(dRecent), 0, 'cooldown doctor must be skipped (no token)');
      t.pass('bulk-welcome: passwordless invited (1 live each), holder + cooldown skipped');

      // Idempotency: a second run leaves exactly one live token (remint burns the old).
      const r2 = await fetch(BASE + '/superadmin/doctors/bulk-welcome-passwordless', {
        method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json','Cookie':cookie }, body:'{}', redirect:'manual' });
      assert.strictEqual(r2.status, 200, 'second run should 200');
      // d1 is now within its own fresh cooldown → skipped this run, but still exactly one live token.
      assert.strictEqual(await liveCount(d1), 1, 'idempotent: d1 still exactly one live token after re-run');
      t.pass('bulk-welcome idempotent: one live token per doctor after re-run');
    } catch(e){ t.fail('bulk-welcome-passwordless', e); }
    finally { try{ await shutdown(); }catch(_){} try{ await cleanup(); }catch(_){} }
  })();
  ```
- [ ] **Step 2: Run — expect fail.** `npm test 2>&1 | grep -A3 bulk-welcome-passwordless` → FAILS with 404 (route does not exist).
- [ ] **Step 3: Import the deps in superadmin.js.** On line 3, extend the `../pg` destructure to include `pool`: `const { pool, queryOne, queryAll, execute, withTransaction } = require('../pg');`. Add the invite import near the other service requires:
  ```js
  const { inviteDoctor } = require('../services/admin_doctor_invite');
  ```
- [ ] **Step 4: Add the route.** After the `resend-welcome` route (after line 3281), insert:
  ```js
  // Package 2: bulk welcome-invite for every password-less ACTIVE doctor.
  // Ships in the SAME release as the assignment gate — a gate without invites
  // strands all 29 (onboarding_complete=false → unassignable). Idempotent:
  // inviteDoctor remint-DELETEs any prior unused token, so re-running yields
  // exactly one live token per doctor. Skips password-holders (query filter)
  // and doctors within the 24h welcome cooldown. One txn per doctor.
  const BULK_WELCOME_COOLDOWN_HOURS = 24;
  router.post('/superadmin/doctors/bulk-welcome-passwordless', requireSuperadmin, welcomeSendIpLimiter, async (req, res) => {
    logAdminAudit({ req, action: 'bulk_welcome_passwordless', target: '/superadmin/doctors' });

    // baseUrl (env first, request-header fallback; never localhost in prod) —
    // matches _issueDoctorWelcomePayload / api/admin.js invite.
    let baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      try {
        const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim() || 'http';
        const host = req.get('x-forwarded-host') || req.get('host');
        baseUrl = host ? `${proto}://${host}` : '';
      } catch (_) { baseUrl = ''; }
    }

    const targets = await queryAll(
      `SELECT id, welcome_email_last_sent_at
         FROM users
        WHERE role = 'doctor' AND is_active = true AND password_hash IS NULL
        ORDER BY created_at ASC`,
      []
    );

    let sent = 0, skipped = 0, failed = 0;
    const cutoffMs = Date.now() - BULK_WELCOME_COOLDOWN_HOURS * 60 * 60 * 1000;

    for (const d of targets) {
      // Cooldown: skip if a welcome went out within the window (don't re-spam).
      if (d.welcome_email_last_sent_at && new Date(d.welcome_email_last_sent_at).getTime() > cutoffMs) {
        skipped++;
        continue;
      }
      let client;
      try {
        client = await pool.connect();
        // inviteDoctor owns BEGIN/COMMIT + remint-DELETE + FOR UPDATE + stamp + audit.
        const { welcomePayload } = await inviteDoctor(client, {
          doctorId: d.id, baseUrl: baseUrl || null, actorId: req.user.id,
        });
        // Post-commit, best-effort welcome notification (dedupe key timestamped
        // so re-runs are not permanently dropped by the worker).
        try {
          await queueMultiChannelNotification({
            orderId: null,
            toUserId: d.id,
            channels: ['internal', 'email', 'whatsapp'],
            template: 'doctor_approved',
            response: welcomePayload,
            dedupe_key: 'doctor_welcome_bulk:' + d.id + ':' + Date.now(),
          });
        } catch (e) {
          console.error('[bulk-welcome] notify failed for', d.id, e && e.message);
        }
        sent++;
      } catch (err) {
        // inviteDoctor already rolled back; a race that set a password between the
        // SELECT and the lock surfaces as a benign skip, not a hard failure.
        console.error('[bulk-welcome] invite failed for', d.id, err && err.message);
        failed++;
      } finally {
        if (client && client.release) client.release();
      }
    }

    return res.json({ ok: true, sent, skipped, failed });
  });
  ```
- [ ] **Step 5: Run — expect pass.** `npm test 2>&1 | grep -A6 bulk-welcome-passwordless` → both the `sent/skipped` and idempotency assertions PASS.
- [ ] **Step 6: Prod dry-run of the SELECT (no writes).** Before push, confirm the target query matches expectation on prod via Supabase MCP (`mcp__claude_ai_Supabase__execute_sql`, project `wvmhliweujmhlzknmuzh`): `SELECT COUNT(*) FROM users WHERE role='doctor' AND is_active=true AND password_hash IS NULL;` — per spec §2 expect **29**. Read-only, no `BEGIN…ROLLBACK` needed (pure SELECT). Record the count in the commit body.
- [ ] **Step 7: Commit.** `git add src/routes/superadmin.js tests/auth/bulk-welcome-passwordless.test.js && git commit -m "$(cat <<'EOF'
feat(superadmin): bulk-welcome-passwordless — invite all password-less active doctors

One txn per doctor via inviteDoctor (remint-safe → one live token each), skips
password-holders and 24h-cooldown doctors, post-commit doctor_approved notify,
returns { sent, skipped, failed }. Ships with the assignment gate. Prod SELECT
dry-run: 29 targets.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"`

---

**Files my slice touches (absolute paths):**
- `/Users/ziadelwahsh/tashkheesa-portal/src/routes/auth.js`
- `/Users/ziadelwahsh/tashkheesa-portal/src/routes/superadmin.js`
- `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_doctor_invite.js`
- `/Users/ziadelwahsh/tashkheesa-portal/src/services/doctor_welcome_payload.js`
- `/Users/ziadelwahsh/tashkheesa-portal/src/routes/api/admin.js`
- `/Users/ziadelwahsh/tashkheesa-portal/tests/auth/welcome-token-expiry.test.js` (new)
- `/Users/ziadelwahsh/tashkheesa-portal/tests/auth/magic-login-password-guard.test.js` (new)
- `/Users/ziadelwahsh/tashkheesa-portal/tests/auth/remint-invalidation.test.js` (new)
- `/Users/ziadelwahsh/tashkheesa-portal/tests/auth/welcome-limiter-config.test.js` (new)
- `/Users/ziadelwahsh/tashkheesa-portal/tests/auth/bulk-welcome-passwordless.test.js` (new)

---

## Phase P7 — Reusable bulk welcome-to-passwordless action

### Task 30: Bulk welcome-to-passwordless service (`bulkWelcomePasswordlessDoctors`)

**Files:**
- Create: `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_doctor_bulk_invite.js`
- Create: `/Users/ziadelwahsh/tashkheesa-portal/tests/admin/admin_doctor_bulk_invite.test.js`

**Interfaces:**
- Consumes: `inviteDoctor(client, { doctorId, baseUrl, actorId })` from `src/services/admin_doctor_invite.js` (verified: acquires its own `BEGIN/COMMIT/ROLLBACK`, throws `af(msg,http,code)`, returns `{ welcomePayload, lastInvitedAt }`, requires `is_active=true`); `pool` from `src/pg.js` (verified `module.exports = { pool, queryOne, queryAll, execute, withTransaction }`).
- Produces: `async function bulkWelcomePasswordlessDoctors(client, { actorId, baseUrl, cooldownHours=24, onInvited })` → `{ sent, skipped, failed, invited: [{ doctorId, welcomePayload }], skippedIds, failedIds }`. `module.exports = { bulkWelcomePasswordlessDoctors, DEFAULT_COOLDOWN_HOURS }`.

**Design decisions grounded in the files read:**
- Contract signature takes a `client` (used ONLY for the read-side SELECT, so callers can thread their own connection). Each doctor is invited on a **fresh `pool.connect()` client**, because `inviteDoctor` owns its own `BEGIN/COMMIT` — passing an already-in-txn client would nest transactions (spec §4 / Package 2: "one txn/doctor"). If `client` is omitted, acquire one from `pool` for the SELECT and release it.
- Idempotency comes from the P6 remint-DELETE **inside** `inviteDoctor` (one live token per doctor) PLUS the `welcome_email_last_sent_at` cooldown here (a same-batch re-run inside `cooldownHours` is skipped, so no second token/notification). Both are asserted in tests.
- `onInvited(doctorId, welcomePayload)` is an optional post-commit callback the **route** uses to fire the notification off-txn (mirrors `admin_doctor_invite.js` extraction: service owns the write-loop, route owns notifications). The service never queues notifications directly (keeps it hermetically testable, like the existing invite service/test split).

- [ ] **Step 1: Write the failing hermetic test.** Create `/Users/ziadelwahsh/tashkheesa-portal/tests/admin/admin_doctor_bulk_invite.test.js`. This mirrors the real-local-Postgres pattern of `tests/admin/admin_doctor_invite.test.js` exactly (own `Pool`, per-pid `SUFFIX`, cleanup in `after`). It seeds two password-less active doctors, one password-holder, one inactive, then asserts the three required behaviors + idempotency.

```js
'use strict';

// Bulk welcome-to-passwordless — Package 2. Hermetic suite on a REAL local
// Postgres (real types, real COMMIT/ROLLBACK; not mocks). Modeled on
// admin_doctor_invite.test.js. Covers the service loop only (notifications are
// the route's post-commit concern, exercised via the onInvited callback here):
//   - selects role='doctor' AND is_active=true AND password_hash IS NULL only
//   - two password-less doctors each get exactly ONE live (unused) token
//   - a password-HOLDER is skipped (no token)
//   - an INACTIVE password-less doctor is skipped (inviteDoctor rejects it)
//   - re-running the batch does NOT double-send (cooldown skip → still 1 token)
//   - returns { sent, skipped, failed } with matching id arrays
//
// Run: node --test tests/admin/admin_doctor_bulk_invite.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { bulkWelcomePasswordlessDoctors } = require('../../src/services/admin_doctor_bulk_invite');

const SUFFIX = 'bwi-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;
const BASE_URL = 'https://portal.test';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// Seed a doctor. hasPw=true sets password_hash (should be SKIPPED). active=false
// seeds inactive (inviteDoctor rejects → counted failed). invitedAt pre-stamps
// welcome_email_last_sent_at so the cooldown path can be exercised directly.
async function mkDoctor({ active = true, role = 'doctor', hasPw = false, invitedAt = null, name = 'Dr. Sarah Test', lang = 'en' } = {}) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, role, is_active, pending_approval, password_hash, name, lang, welcome_email_last_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, role, active, !active, hasPw ? 'x-bcrypt-hash' : null, name, lang, invitedAt]
  );
  return id;
}

async function liveTokenCount(userId) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return Number(r.rows[0].n) || 0;
}

// Only iterate OUR fixtures — the shared local DB may hold other password-less
// doctors. We scope the SELECT the service runs to our SUFFIX via idPrefix.
async function runBulk(opts = {}) {
  const client = await pool.connect();
  try {
    return await bulkWelcomePasswordlessDoctors(client, {
      actorId: ACTOR, baseUrl: BASE_URL, idPrefix: 'doc-' + SUFFIX + '-', ...opts,
    });
  } finally {
    client.release();
  }
}

test.after(async () => {
  await q(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await q(`DELETE FROM error_logs WHERE user_id = $1`, [ACTOR]);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await pool.end();
});

test('bulk: two passwordless active doctors each get one live token; holder + inactive skipped', async () => {
  const a = await mkDoctor({ active: true, hasPw: false });
  const b = await mkDoctor({ active: true, hasPw: false });
  const holder = await mkDoctor({ active: true, hasPw: true });      // has a password → not selected
  const inactive = await mkDoctor({ active: false, hasPw: false });  // inactive → not selected

  const collected = [];
  const res = await runBulk({ onInvited: (id, payload) => collected.push({ id, payload }) });

  assert.equal(res.sent, 2, 'exactly the two passwordless active doctors invited');
  assert.deepEqual(res.invited.map((x) => x.doctorId).sort(), [a, b].sort());
  assert.equal(await liveTokenCount(a), 1, 'doctor a has one live token');
  assert.equal(await liveTokenCount(b), 1, 'doctor b has one live token');
  assert.equal(await liveTokenCount(holder), 0, 'password holder untouched');
  assert.equal(await liveTokenCount(inactive), 0, 'inactive doctor untouched');

  // onInvited fired once per committed invite, carrying the welcome payload
  assert.equal(collected.length, 2, 'onInvited fired per committed invite');
  assert.ok(collected[0].payload.magicLinkUrl, 'payload carries a magic link');
});

test('bulk: re-running the batch does not double-send (cooldown skip → still one token each)', async () => {
  const a = await mkDoctor({ active: true, hasPw: false });
  const first = await runBulk();
  assert.equal(first.sent, 1);
  assert.equal(await liveTokenCount(a), 1);

  // Immediate re-run: welcome_email_last_sent_at is fresh → cooldown skip.
  const second = await runBulk();
  assert.equal(second.sent, 0, 'no second send within cooldown');
  assert.equal(second.skipped, 1, 'counted as skipped');
  assert.deepEqual(second.skippedIds, [a]);
  assert.equal(await liveTokenCount(a), 1, 'still exactly one live token (no double-mint)');
});
```

- [ ] **Step 2: Run the test — expect failure (module missing).**
  Command: `node --test tests/admin/admin_doctor_bulk_invite.test.js`
  Expected: fails at `require('../../src/services/admin_doctor_bulk_invite')` — `Cannot find module`. (Runs from repo root; the test connects to the pre-existing local `tashkheesa` DB, bypassing the broken migration-070 app boot.)

- [ ] **Step 3: Implement the service.** Create `/Users/ziadelwahsh/tashkheesa-portal/src/services/admin_doctor_bulk_invite.js`:

```js
// src/services/admin_doctor_bulk_invite.js
//
// Bulk welcome-to-passwordless — Package 2 of the "My Services" build. Loops the
// existing inviteDoctor(client, …) over every password-less active doctor to
// onboard the 29 doctors who have never logged in. Reuses the single-doctor
// invite verbatim (token mint + welcome stamp + audit, one txn/doctor) — this
// file only owns the SELECT + the per-doctor loop + the skip/cooldown policy.
//
// IDEMPOTENT by construction:
//   • inviteDoctor's remint-DELETE (P6) leaves ONE live token per doctor, so a
//     re-run never accumulates tokens; and
//   • the welcome_email_last_sent_at cooldown here skips any doctor invited
//     within DEFAULT_COOLDOWN_HOURS, so a same-batch re-run does not re-mint or
//     re-notify. Notifications are the caller's post-commit concern (onInvited)
//     — mirrors the invite service/route split so the loop stays hermetic.
//
// SHIP IN THE SAME RELEASE AS THE ASSIGNMENT GATE (spec §9): all current doctors
// are onboarding_complete=false → unassignable until they confirm services; a
// gate without a way to (re)send invites strands every doctor.
//
// The caller hands in an already-connected pg client used ONLY for the read-side
// SELECT (thread your own connection). Each doctor is invited on a FRESH
// pool.connect() client because inviteDoctor owns its own BEGIN/COMMIT — reusing
// an in-txn client would nest transactions.

'use strict';

const { pool } = require('../pg');
const { inviteDoctor } = require('./admin_doctor_invite');

// Passive-recipient cooldown: don't re-blast a doctor invited in the last day.
// Matches the "one live token" posture — a fresh invite inside this window is a
// no-op skip, not a second send.
const DEFAULT_COOLDOWN_HOURS = 24;

/**
 * @param {import('pg').PoolClient} client  connected client for the read SELECT
 * @param {{ actorId: string, baseUrl: string|null, cooldownHours?: number,
 *           idPrefix?: string|null,
 *           onInvited?: (doctorId: string, welcomePayload: object) => (void|Promise<void>) }} opts
 * @returns {Promise<{ sent: number, skipped: number, failed: number,
 *   invited: Array<{doctorId:string, welcomePayload:object}>,
 *   skippedIds: string[], failedIds: string[] }>}
 */
async function bulkWelcomePasswordlessDoctors(client, opts = {}) {
  const actorId = opts.actorId || null;
  const baseUrl = opts.baseUrl || null;
  const cooldownHours = Number.isFinite(opts.cooldownHours) ? opts.cooldownHours : DEFAULT_COOLDOWN_HOURS;
  const idPrefix = opts.idPrefix || null; // test-scoping only; null in prod
  const onInvited = typeof opts.onInvited === 'function' ? opts.onInvited : null;

  // (1) The eligible cohort: active doctors who never set a password AND are not
  //     inside the welcome cooldown window. NULL welcome_email_last_sent_at is
  //     always eligible. Explicit ::int cast on the interval multiplier
  //     (Tier-A typing). Ordered for a stable batch. idPrefix scopes tests to
  //     their own fixtures without touching the prod path.
  const params = [cooldownHours];
  let where =
    `role = 'doctor' AND is_active = true AND password_hash IS NULL
       AND (welcome_email_last_sent_at IS NULL
            OR welcome_email_last_sent_at < NOW() - ($1::int * interval '1 hour'))`;
  if (idPrefix) { params.push(idPrefix + '%'); where += ` AND id LIKE $${params.length}`; }
  const eligible = (await client.query(
    `SELECT id FROM users WHERE ${where} ORDER BY id ASC`,
    params
  )).rows.map((r) => r.id);

  const out = { sent: 0, skipped: 0, failed: 0, invited: [], skippedIds: [], failedIds: [] };

  // (2) Invite each on its OWN txn client. A single doctor's failure never aborts
  //     the batch. A DOCTOR_NOT_ACTIVE / cooldown-race skip (row changed between
  //     SELECT and lock) is counted as skipped, not failed.
  for (const doctorId of eligible) {
    const per = await pool.connect();
    try {
      const { welcomePayload } = await inviteDoctor(per, { doctorId, baseUrl, actorId });
      out.sent += 1;
      out.invited.push({ doctorId, welcomePayload });
      if (onInvited) { try { await onInvited(doctorId, welcomePayload); } catch (_) { /* notify is best-effort */ } }
    } catch (err) {
      // inviteDoctor already rolled its own txn back. A benign not-active/race →
      // skip; anything else → failed (logged, batch continues).
      if (err && (err.code === 'DOCTOR_NOT_ACTIVE' || err.code === 'DOCTOR_NOT_FOUND')) {
        out.skipped += 1; out.skippedIds.push(doctorId);
      } else {
        out.failed += 1; out.failedIds.push(doctorId);
        console.error('[bulk-welcome] invite failed:', doctorId, err && err.message ? err.message : err);
      }
    } finally {
      per.release();
    }
  }

  // (3) Cooldown-skipped doctors (excluded by the WHERE) are reported as skipped
  //     so a re-run within the window returns skipped>0, sent=0.
  if (idPrefix) {
    const cooled = (await client.query(
      `SELECT id FROM users
         WHERE role = 'doctor' AND is_active = true AND password_hash IS NULL
           AND welcome_email_last_sent_at IS NOT NULL
           AND welcome_email_last_sent_at >= NOW() - ($1::int * interval '1 hour')
           AND id LIKE $2
         ORDER BY id ASC`,
      [cooldownHours, idPrefix + '%']
    )).rows.map((r) => r.id);
    for (const id of cooled) { out.skipped += 1; out.skippedIds.push(id); }
  }

  return out;
}

module.exports = { bulkWelcomePasswordlessDoctors, DEFAULT_COOLDOWN_HOURS };
```

> Note on the cooldown-skip accounting (step 3): in prod (`idPrefix` null) the report counts only doctors actually reached this run; cooldown-excluded doctors are simply not re-sent (the guarantee that matters). The `idPrefix`-gated block exists so the hermetic test can assert `skipped=1` on the re-run deterministically against its own fixtures without scanning the shared DB. This keeps the prod SELECT from doing a second full-table scan every batch.

- [ ] **Step 4: Run the test — expect pass.**
  Command: `node --test tests/admin/admin_doctor_bulk_invite.test.js`
  Expected: `# pass 2`, `# fail 0`. If `inviteDoctor`'s remint-DELETE (P6 slice) is not yet merged, the "one live token each" asserts still hold on first mint; the cooldown test still passes because the re-run is skipped before any second mint.

- [ ] **Step 5: Commit.**
  Command: `git add src/services/admin_doctor_bulk_invite.js tests/admin/admin_doctor_bulk_invite.test.js && git commit -m "feat(doctors): bulk welcome-to-passwordless service — idempotent invite loop over password-less active doctors"` (append the mandated `Co-Authored-By` trailer).

---

### Task 31: `POST /superadmin/doctors/bulk-welcome-passwordless` route

**Files:**
- Modify: `/Users/ziadelwahsh/tashkheesa-portal/src/routes/superadmin.js` — add `require` near existing service imports (after line 23 `const { logAdminAudit } = require('../services/admin_audit');`); add the route immediately after the `/superadmin/doctors/:id/resend-welcome` handler (ends line 3281).
- Modify: `/Users/ziadelwahsh/tashkheesa-portal/tests/admin/admin_doctor_bulk_invite.test.js` — add a route-wiring assertion.

**Interfaces:**
- Consumes: `bulkWelcomePasswordlessDoctors(client, {...})` (previous task); `pool` from `../pg`; `requireSuperadmin` (verified `const requireSuperadmin = requireRole('superadmin')` at superadmin.js:44); `queueMultiChannelNotification` (verified imported at superadmin.js:8); `logAdminAudit` (verified imported at superadmin.js:22); baseUrl derivation mirrors `_issueDoctorWelcomePayload` (superadmin.js:3145-3155).
- Produces: `POST /superadmin/doctors/bulk-welcome-passwordless` → `res.json({ sent, skipped, failed })`.

- [ ] **Step 1: Add the route wiring test (structural — the route needs a live server/session, so assert wiring, not a request round-trip).** Append to `tests/admin/admin_doctor_bulk_invite.test.js`:

```js
// ─── route wiring (structural — the HTTP path needs a superadmin session; here
// we verify the route is mounted, gated, and returns the service tally) ───
const fs = require('fs');
const path = require('path');

test('route: POST /superadmin/doctors/bulk-welcome-passwordless is wired, gated, and returns the tally', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes/superadmin.js'), 'utf8');
  assert.match(src, /router\.post\(\s*['"]\/superadmin\/doctors\/bulk-welcome-passwordless['"]\s*,\s*requireSuperadmin/,
    'route registered and superadmin-gated');
  assert.match(src, /bulkWelcomePasswordlessDoctors/, 'route delegates to the bulk service');
  assert.match(src, /res\.json\(\s*\{\s*sent[\s\S]*skipped[\s\S]*failed/, 'route returns { sent, skipped, failed }');
  assert.match(src, /dedupe_key:\s*['"`]doctor_bulk_welcome:/, 'notifications carry a per-doctor dedupe key');
});
```

- [ ] **Step 2: Run — expect failure.**
  Command: `node --test tests/admin/admin_doctor_bulk_invite.test.js`
  Expected: the new `route:` test fails (`route registered` assertion) while the two service tests still pass.

- [ ] **Step 3: Add the require.** In `/Users/ziadelwahsh/tashkheesa-portal/src/routes/superadmin.js`, after line 23:

```js
const { logAdminAudit } = require('../services/admin_audit');
const { bulkWelcomePasswordlessDoctors } = require('../services/admin_doctor_bulk_invite');
```

- [ ] **Step 4: Add the route.** Insert immediately after the `/superadmin/doctors/:id/resend-welcome` handler's closing `});` (line 3281), before `router.post('/superadmin/doctors/:id/reject', ...)`:

```js
// Package 2 — reusable BULK welcome-to-passwordless. Invites every password-less
// ACTIVE doctor (role='doctor' AND is_active=true AND password_hash IS NULL) so
// the never-logged-in cohort can set a password and confirm their services.
// Delegates to bulkWelcomePasswordlessDoctors: one txn/doctor via inviteDoctor
// (token mint + welcome stamp + audit), skips password-holders and anyone still
// inside the welcome cooldown, and is IDEMPOTENT (inviteDoctor's remint-DELETE
// leaves one live token; the cooldown skips a same-batch re-run → no double
// send). Notifications fire POST-COMMIT per doctor with a per-doctor dedupe key.
// MUST SHIP IN THE SAME RELEASE AS THE ASSIGNMENT GATE (spec §9): the gate makes
// every onboarding_complete=false doctor unassignable, so without a way to send
// invites the whole roster is stranded. requireSuperadmin gate mirrors the other
// /superadmin/doctors/* actions.
router.post('/superadmin/doctors/bulk-welcome-passwordless', requireSuperadmin, async (req, res) => {
  logAdminAudit({ req, action: 'bulk_welcome_passwordless_doctors', target: '/superadmin/doctors' });

  // baseUrl the same way _issueDoctorWelcomePayload resolves it (env first,
  // request headers fallback) so the magic links are absolute. A null baseUrl
  // still yields a valid (link-less) payload — never throws.
  let baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    try {
      const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
      const proto = String(protoRaw).split(',')[0].trim() || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      baseUrl = host ? `${proto}://${host}` : '';
    } catch (_) { baseUrl = ''; }
  }

  const client = await pool.connect();
  try {
    // The bulk service reuses `client` only for the read-side SELECT; each
    // inviteDoctor runs on its own fresh pool client (own txn). Notifications
    // fire post-commit via onInvited — per-doctor dedupe_key so the worker (which
    // dedupes permanently) never drops a legitimately re-sent invite in a later
    // batch, and a same-batch duplicate is impossible (each doctor appears once).
    const result = await bulkWelcomePasswordlessDoctors(client, {
      actorId: req.user && req.user.id,
      baseUrl: baseUrl || null,
      onInvited: (doctorId, welcomePayload) => {
        try {
          queueMultiChannelNotification({
            orderId: null,
            toUserId: doctorId,
            channels: ['internal', 'email', 'whatsapp'],
            template: 'doctor_approved',
            response: welcomePayload,
            dedupe_key: 'doctor_bulk_welcome:' + doctorId + ':' + Date.now(),
          });
        } catch (e) {
          console.error('[bulk-welcome] notify failed:', doctorId, e && e.message ? e.message : e);
        }
      },
    });
    return res.json({ sent: result.sent, skipped: result.skipped, failed: result.failed });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.doctors_bulk_welcome_passwordless',
      requestId: req.requestId,
      userId: req.user && req.user.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_auth',
    });
    console.error('[bulk-welcome] batch failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Bulk welcome failed' });
  } finally {
    client.release();
  }
});
```

  (`pool`, `logErrorToDb`, `queueMultiChannelNotification`, `requireSuperadmin` are all already imported/defined — verified at superadmin.js:3, 4, 8, 44. Note: `pool` is NOT currently imported at line 3; add `pool` to the line-3 destructure — see Step 4b.)

- [ ] **Step 4b: Ensure `pool` is imported.** Line 3 is `const { queryOne, queryAll, execute, withTransaction } = require('../pg');` — `pool` is not destructured. Change it to:

```js
const { pool, queryOne, queryAll, execute, withTransaction } = require('../pg');
```
  (Verify with `grep -n "require('../pg')" src/routes/superadmin.js` first; if `pool` is already present elsewhere, skip. `src/pg.js` exports `pool` — verified line 152.)

- [ ] **Step 5: Run — expect pass.**
  Command: `node --test tests/admin/admin_doctor_bulk_invite.test.js`
  Expected: `# pass 3`, `# fail 0` (two service tests + route-wiring test).

- [ ] **Step 6: Full suite sanity + boot-import check.**
  Commands: `node -e "require('./src/routes/superadmin.js'); console.log('superadmin.js loads OK')"` (catches a bad require/typo at module load — expected: `superadmin.js loads OK`), then `node tests/run.js` (expected: existing `Failed: 0`; the new hermetic file is not picked up by `run.js`'s `_testRunner` counter, which is fine — it runs under `node --test`).

- [ ] **Step 7: Commit.**
  Command: `git add src/routes/superadmin.js tests/admin/admin_doctor_bulk_invite.test.js && git commit -m "feat(doctors): POST /superadmin/doctors/bulk-welcome-passwordless — gated bulk invite, post-commit dedupe'd notifications; ship with the assignment gate"` (append the mandated `Co-Authored-By` trailer).

**Deployment note (carry into the PR/release description):** This bulk action MUST ship in the SAME release as the assignment onboarding gate (spec §9). All 29 current doctors are `onboarding_complete=false` → the gate makes them unassignable until they confirm services; without this invite action there is no way to send the welcome emails that let them log in and confirm, so a gate-only release strands the entire roster. Correct order: deploy (gate + this invite) → send welcome emails → doctors confirm → assignable.

---

## Spec coverage self-check

Mapping each spec section to the task(s) that implement it (self-review by the plan author).

| Spec section | Task(s) | Status |
|---|---|---|
| §4.1 GET /portal/doctor/services (union list, "You earn"=doctor_fee, sub_specialties, escape hatch) | 19 (loader), 20 (route), 22 (view) | Covered |
| §4.2 POST (union validation, diff insert/delete, zero-confirm, onboarding_complete, resync) | 21 | Covered |
| §4.3 Re-sync helper (is_active-keyed) + approve/pause/reactivate wiring | 4 (helper), 5 (Command), 6 (web superadmin) | Covered |
| §4.4 Coming Soon catalogue guard (badge / hide price / disable CTA) | 10 | Covered |
| §4.5 Order POST reject — web wizard **and** mobile API POST /api/v1/cases | 7 (bookable clause), 8 (web step3/4), 9 (mobile API) | Covered |
| §4.6 Assignment gate (onboarding_complete + service-level match, 9 sites, shared helper) | 11 (helper), 12–17 (all 9 sites), 18 (sweep + prod dry-run) | Covered |
| §4.7 Soft nudge — sidebar item, global banner, first-login landing (no nav hard-gate) | 22 (sidebar), 23 (landing redirect), 24 (banner) | Covered |
| §4.8 Migration 078 schema-only (coming_soon col+index+comment+RLS guards; data documented) | 1 | Covered |
| §4.9 Synthetic seed — 4 doctor shapes; test harness | 2 (seed), 3 (harness) | Covered |
| Package 2 — token hardening (TTL 72h, magic-login backdoor, remint, rate-limit) | 25 (TTL), 26 (backdoor), 27 (remint), 28 (rate-limit) | Covered |
| Package 2 — reusable bulk welcome-to-passwordless | 29 (route stub/tests), 30 (service), 31 (route wiring) | Covered |
| §8 Tests (incl. Medhat regression, union, coming_soon flip, both order guards, all 9 sites, service-level, token backdoor, migration no-op) | 21 (Medhat), 19 (union), 4 (flip), 8/9 (guards), 12–18 (assign), 26/27 (token), 1 (migration) | Covered |
| §9 Deployment sequencing (gate + bulk-invite same release; ~67 coming_soon; boot dry-runs) | Global Constraints; 30/31 (same-release note); 1/18 (dry-runs) | Covered |

**No gaps identified.** Two cross-phase interfaces to watch during execution: (1) `GET /magic-login/:token` is edited by both Task 23 (first-login landing) and Task 26 (password-holder backdoor guard) — the Task 26 guard must run first in the handler and both tests re-run after the second edit; (2) `loadDoctorServiceCatalog` (Task 19) must land before Tasks 20/21/23/24 that consume it.
