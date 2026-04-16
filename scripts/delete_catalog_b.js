#!/usr/bin/env node
// scripts/delete_catalog_b.js
// Deletes Catalog B services + specialties from the DB.
//
// Catalog B = early-development demo rows produced by src/seed_specialties.js.
// All have specialty_id LIKE 'spec-%' (services) or id LIKE 'spec-%' (specialties).
// Catalog A (lowercase specialty_ids like 'cardiology', stable IDs like 'card_echo')
// is untouched.
//
// Usage:
//   Dry-run (default — no writes):
//     DATABASE_URL=<prod-url> PG_SSL=true node scripts/delete_catalog_b.js --dry-run
//   Live (deletes inside a single transaction):
//     DATABASE_URL=<prod-url> PG_SSL=true node scripts/delete_catalog_b.js --live
//
// Pre-flight (live mode): re-verifies that zero orders.service_id and zero
// service_regional_prices.service_id rows reference any Catalog B service.
// Aborts the transaction immediately if either check fails.
//
// Post-deploy: src/server.js no longer calls seedSpecialtiesAndServices(), so
// Catalog B will not be recreated on the next boot. Run this script BEFORE
// the deploy that ships the seeder-disable change, or AFTER — order doesn't
// matter as long as both happen.

const { Pool } = require('pg');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isLive = args.includes('--live');

if (isDryRun === isLive) {
  console.error('ERROR: pass exactly one of --dry-run or --live');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 5000,
});

function hr() { console.log('-'.repeat(72)); }

async function main() {
  const dbInfo = await pool.query(
    "SELECT current_database() AS db, inet_server_addr()::text AS host, current_user AS usr"
  );
  hr();
  console.log('Mode:', isDryRun ? 'DRY-RUN (no writes)' : 'LIVE (will DELETE rows)');
  console.log('Connected to:', dbInfo.rows[0]);
  hr();

  // ── Plan preview ────────────────────────────────────────────────────────
  const plan = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM services    WHERE specialty_id LIKE 'spec-%') AS services_to_delete,
      (SELECT COUNT(*)::int FROM specialties WHERE id            LIKE 'spec-%') AS specialties_to_delete
  `);
  const svcCount = plan.rows[0].services_to_delete;
  const specCount = plan.rows[0].specialties_to_delete;

  console.log('Plan:');
  console.log('    services    rows to DELETE WHERE specialty_id LIKE \'spec-%\' =', svcCount);
  console.log('    specialties rows to DELETE WHERE id            LIKE \'spec-%\' =', specCount);
  hr();

  // ── Per-specialty preview (which buckets will lose what) ─────────────────
  const grouped = await pool.query(`
    SELECT s.specialty_id, COUNT(*)::int AS row_count
    FROM services s
    WHERE s.specialty_id LIKE 'spec-%'
    GROUP BY s.specialty_id
    ORDER BY s.specialty_id
  `);
  if (grouped.rows.length > 0) {
    console.log('Catalog B services grouped by specialty_id (preview):');
    for (const r of grouped.rows) {
      console.log(`    ${r.specialty_id.padEnd(28)} ${r.row_count} rows`);
    }
    hr();
  }

  // ── Safety re-check (always runs, even in dry-run, so the user sees it)
  // The audit said 0/0; this re-runs that exact check against current state
  // so we catch anything that landed between audit and now.
  const refCheck = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM orders o
       WHERE o.service_id IN (SELECT id FROM services WHERE specialty_id LIKE 'spec-%'))
        AS orders_referencing_b,
      (CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'service_regional_prices'
      ) THEN
        (SELECT COUNT(*)::int FROM service_regional_prices srp
         WHERE srp.service_id IN (SELECT id FROM services WHERE specialty_id LIKE 'spec-%'))
       ELSE 0 END) AS prices_referencing_b
  `);
  const ordersRef = refCheck.rows[0].orders_referencing_b;
  const pricesRef = refCheck.rows[0].prices_referencing_b;

  console.log('Safety re-check:');
  console.log('    orders referencing Catalog B          =', ordersRef);
  console.log('    service_regional_prices referencing B =', pricesRef);
  hr();

  if (ordersRef > 0 || pricesRef > 0) {
    console.log('SAFETY ABORT: Catalog B is referenced by ' + ordersRef + ' order(s)');
    console.log('              and ' + pricesRef + ' regional-price row(s).');
    console.log('              Audit reported 0/0 — state changed since.');
    console.log('              Re-run the audit and revise plan before deleting.');
    process.exitCode = 2;
    return;
  }

  if (svcCount === 0 && specCount === 0) {
    console.log('Nothing to delete. Exiting.');
    return;
  }

  if (isDryRun) {
    console.log('Dry-run complete. Re-run with --live to execute.');
    return;
  }

  // ── LIVE: single transaction, all-or-nothing ─────────────────────────────
  console.log('Executing DELETE in a single transaction...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-verify under transaction (race guard — last chance before write)
    const txnRecheck = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM orders o
         WHERE o.service_id IN (SELECT id FROM services WHERE specialty_id LIKE 'spec-%'))
          AS orders_referencing_b,
        (CASE WHEN EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'service_regional_prices'
        ) THEN
          (SELECT COUNT(*)::int FROM service_regional_prices srp
           WHERE srp.service_id IN (SELECT id FROM services WHERE specialty_id LIKE 'spec-%'))
         ELSE 0 END) AS prices_referencing_b
    `);
    if (txnRecheck.rows[0].orders_referencing_b > 0 || txnRecheck.rows[0].prices_referencing_b > 0) {
      throw new Error(
        'Race detected: ' + txnRecheck.rows[0].orders_referencing_b + ' order(s) and '
        + txnRecheck.rows[0].prices_referencing_b + ' price(s) now reference Catalog B. Aborting.'
      );
    }

    // Order matters: services first (in case any FK exists from services to
    // specialties), specialties second.
    const delServices = await client.query(
      "DELETE FROM services WHERE specialty_id LIKE 'spec-%'"
    );
    if (delServices.rowCount !== svcCount) {
      throw new Error(
        'services DELETE rowCount mismatch: expected ' + svcCount
        + ', got ' + delServices.rowCount + '. Aborting.'
      );
    }

    const delSpecialties = await client.query(
      "DELETE FROM specialties WHERE id LIKE 'spec-%'"
    );
    if (delSpecialties.rowCount !== specCount) {
      throw new Error(
        'specialties DELETE rowCount mismatch: expected ' + specCount
        + ', got ' + delSpecialties.rowCount + '. Aborting.'
      );
    }

    await client.query('COMMIT');
    console.log('Deleted ' + delServices.rowCount + ' services rows.');
    console.log('Deleted ' + delSpecialties.rowCount + ' specialties rows.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('TRANSACTION ROLLED BACK:', err.message);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  // ── Post-check ───────────────────────────────────────────────────────────
  const post = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM services    WHERE specialty_id LIKE 'spec-%') AS remaining_b_services,
      (SELECT COUNT(*)::int FROM specialties WHERE id            LIKE 'spec-%') AS remaining_b_specialties,
      (SELECT COUNT(*)::int FROM services)    AS total_services,
      (SELECT COUNT(*)::int FROM specialties) AS total_specialties
  `);
  hr();
  console.log('Post-delete state:');
  console.log('    services    total =', post.rows[0].total_services,
    ' (remaining spec-* =', post.rows[0].remaining_b_services + ')');
  console.log('    specialties total =', post.rows[0].total_specialties,
    ' (remaining spec-* =', post.rows[0].remaining_b_specialties + ')');
  if (post.rows[0].remaining_b_services === 0 && post.rows[0].remaining_b_specialties === 0) {
    console.log('OK — Catalog B fully removed.');
  } else {
    console.log('WARNING — spec-* rows still present. Investigate.');
  }
}

main()
  .catch((err) => {
    console.error('Delete failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
