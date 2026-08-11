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
