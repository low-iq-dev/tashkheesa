#!/usr/bin/env node
// scripts/audit_catalog_b.js
// Read-only audit of the services / specialties / orders / service_regional_prices
// tables to size up the Catalog A vs Catalog B split before any cleanup decision.
//
// Catalog A — canonical services. Stable IDs (e.g. card_echo, rad_mri_review)
//             AND lowercase specialty_id (cardiology, radiology, neurology).
// Catalog B — early-development demo services. UUID / svc-* IDs with
//             specialty_id LIKE 'spec-%'. Currently produced on every boot by
//             src/seed_specialties.js.
//
// Usage:
//   DATABASE_URL=<prod-url> PG_SSL=true node scripts/audit_catalog_b.js
//
// Performs no writes. Safe to run against production.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  console.error('Run with: DATABASE_URL=<prod-url> PG_SSL=true node scripts/audit_catalog_b.js');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 5000,
});

function hr() { console.log('-'.repeat(72)); }

// Predicates reused across queries — kept as constants so they're identical
// in every place we test "is this row Catalog A?" / "is this row Catalog B?".
const CATALOG_B_PREDICATE = "s.specialty_id LIKE 'spec-%'";
const CATALOG_A_PREDICATE = "s.specialty_id NOT LIKE 'spec-%' AND s.id NOT LIKE '%-%-%-%-%'";
// Anything not matching A or B (e.g. lowercase specialty_id but UUID-ish id)
// gets called "uncategorized" so we don't silently lose rows from the count.

async function main() {
  const dbInfo = await pool.query(
    "SELECT current_database() AS db, inet_server_addr()::text AS host, current_user AS usr"
  );
  hr();
  console.log('Connected to:', dbInfo.rows[0]);
  hr();

  // ── Q1: Catalog A row count ──────────────────────────────────────────────
  const q1 = await pool.query(
    `SELECT COUNT(*)::int AS catalog_a_count FROM services s WHERE ${CATALOG_A_PREDICATE}`
  );
  console.log('Q1: Catalog A services');
  console.log('    (specialty_id NOT LIKE \'spec-%\' AND id NOT LIKE \'%-%-%-%-%\')');
  console.log('    count =', q1.rows[0].catalog_a_count);
  hr();

  // ── Q2: Catalog B row count ──────────────────────────────────────────────
  const q2 = await pool.query(
    `SELECT COUNT(*)::int AS catalog_b_count FROM services s WHERE ${CATALOG_B_PREDICATE}`
  );
  console.log('Q2: Catalog B services');
  console.log('    (specialty_id LIKE \'spec-%\')');
  console.log('    count =', q2.rows[0].catalog_b_count);
  hr();

  // ── Q2b: Uncategorized services (sanity check — these don't fit either bucket) ──
  const q2b = await pool.query(
    `SELECT COUNT(*)::int AS total,
            (SELECT COUNT(*)::int FROM services s WHERE ${CATALOG_A_PREDICATE}) AS in_a,
            (SELECT COUNT(*)::int FROM services s WHERE ${CATALOG_B_PREDICATE}) AS in_b
     FROM services`
  );
  const total = q2b.rows[0].total;
  const inA = q2b.rows[0].in_a;
  const inB = q2b.rows[0].in_b;
  const uncategorized = total - inA - inB;
  console.log('Q2b: Coverage check');
  console.log('    total services =', total);
  console.log('    Catalog A      =', inA);
  console.log('    Catalog B      =', inB);
  console.log('    uncategorized  =', uncategorized,
    uncategorized > 0
      ? '<-- rows that are neither A nor B; sample below'
      : '<-- every row classified');
  if (uncategorized > 0) {
    const q2bSample = await pool.query(
      `SELECT id, specialty_id, name FROM services s
       WHERE NOT (${CATALOG_A_PREDICATE}) AND NOT (${CATALOG_B_PREDICATE})
       ORDER BY specialty_id, name LIMIT 10`
    );
    for (const r of q2bSample.rows) {
      console.log(`    [uncat] id=${r.id}  specialty=${r.specialty_id}  name=${r.name}`);
    }
  }
  hr();

  // ── Q3: orders referencing Catalog A vs Catalog B service_id ─────────────
  const q3 = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE s.id IS NOT NULL AND ${CATALOG_A_PREDICATE})::int AS orders_in_a,
      COUNT(*) FILTER (WHERE s.id IS NOT NULL AND ${CATALOG_B_PREDICATE})::int AS orders_in_b,
      COUNT(*) FILTER (WHERE o.service_id IS NOT NULL AND s.id IS NULL)::int   AS orders_dangling,
      COUNT(*) FILTER (WHERE o.service_id IS NULL)::int                        AS orders_no_service
    FROM orders o
    LEFT JOIN services s ON s.id = o.service_id
  `);
  console.log('Q3: orders.service_id catalog distribution');
  console.log('    pointing at Catalog A   =', q3.rows[0].orders_in_a);
  console.log('    pointing at Catalog B   =', q3.rows[0].orders_in_b);
  console.log('    pointing at deleted row =', q3.rows[0].orders_dangling, '(service_id set but service row missing)');
  console.log('    no service_id at all    =', q3.rows[0].orders_no_service);
  hr();

  // ── Q4: service_regional_prices distribution (table may not exist) ───────
  let q4Available = false;
  try {
    const probe = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'service_regional_prices' LIMIT 1"
    );
    q4Available = probe.rowCount > 0;
  } catch (_) { q4Available = false; }

  console.log('Q4: service_regional_prices catalog distribution');
  if (!q4Available) {
    console.log('    (table service_regional_prices does not exist — skipped)');
  } else {
    const q4 = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE s.id IS NOT NULL AND ${CATALOG_A_PREDICATE})::int AS prices_in_a,
        COUNT(*) FILTER (WHERE s.id IS NOT NULL AND ${CATALOG_B_PREDICATE})::int AS prices_in_b,
        COUNT(*) FILTER (WHERE srp.service_id IS NOT NULL AND s.id IS NULL)::int AS prices_dangling
      FROM service_regional_prices srp
      LEFT JOIN services s ON s.id = srp.service_id
    `);
    console.log('    pointing at Catalog A   =', q4.rows[0].prices_in_a);
    console.log('    pointing at Catalog B   =', q4.rows[0].prices_in_b);
    console.log('    pointing at deleted row =', q4.rows[0].prices_dangling);
  }
  hr();

  // ── Q5: spec-* rows in specialties table ─────────────────────────────────
  const q5 = await pool.query(`
    SELECT COUNT(*)::int AS specs_total,
           COUNT(*) FILTER (WHERE id LIKE 'spec-%')::int AS specs_spec_prefixed,
           COUNT(*) FILTER (WHERE id NOT LIKE 'spec-%')::int AS specs_lowercase
    FROM specialties
  `);
  console.log('Q5: specialties table — spec-* prefix distribution');
  console.log('    total specialties      =', q5.rows[0].specs_total);
  console.log('    "spec-" prefixed (B)   =', q5.rows[0].specs_spec_prefixed);
  console.log('    other (A-style)        =', q5.rows[0].specs_lowercase);

  const q5sample = await pool.query(`
    SELECT id, name FROM specialties WHERE id LIKE 'spec-%' ORDER BY id LIMIT 20
  `);
  if (q5sample.rows.length > 0) {
    console.log('    spec-* specialties (first 20):');
    for (const r of q5sample.rows) {
      console.log(`      ${r.id.padEnd(28)} ${r.name}`);
    }
  }
  const q5sampleA = await pool.query(`
    SELECT id, name FROM specialties WHERE id NOT LIKE 'spec-%' ORDER BY id LIMIT 20
  `);
  if (q5sampleA.rows.length > 0) {
    console.log('    other (A-style) specialties (first 20):');
    for (const r of q5sampleA.rows) {
      console.log(`      ${r.id.padEnd(28)} ${r.name}`);
    }
  }
  hr();

  // ── Q6: 5 most recent orders, with catalog classification ────────────────
  const q6 = await pool.query(`
    SELECT
      o.id,
      o.created_at,
      o.service_id,
      s.specialty_id,
      s.name AS service_name,
      CASE
        WHEN s.id IS NULL AND o.service_id IS NOT NULL THEN 'DANGLING'
        WHEN s.id IS NULL THEN 'NO_SERVICE'
        WHEN s.specialty_id LIKE 'spec-%' THEN 'B'
        WHEN s.specialty_id NOT LIKE 'spec-%' AND s.id NOT LIKE '%-%-%-%-%' THEN 'A'
        ELSE 'UNCAT'
      END AS catalog
    FROM orders o
    LEFT JOIN services s ON s.id = o.service_id
    ORDER BY o.created_at DESC NULLS LAST
    LIMIT 5
  `);
  console.log('Q6: 5 most recent orders with catalog classification');
  if (q6.rows.length === 0) {
    console.log('    (no orders found)');
  } else {
    for (const r of q6.rows) {
      const created = r.created_at ? new Date(r.created_at).toISOString() : '(no created_at)';
      console.log(`    [${r.catalog.padEnd(10)}] order=${r.id}`);
      console.log(`      created_at = ${created}`);
      console.log(`      service_id = ${r.service_id || '(null)'}`);
      console.log(`      specialty  = ${r.specialty_id || '(n/a)'}`);
      console.log(`      service    = ${r.service_name || '(n/a)'}`);
    }
  }
  hr();

  // ── Catalog B by-specialty breakdown — useful for the "what would be deleted" preview
  const qB = await pool.query(`
    SELECT s.specialty_id, COUNT(*)::int AS row_count
    FROM services s
    WHERE ${CATALOG_B_PREDICATE}
    GROUP BY s.specialty_id
    ORDER BY s.specialty_id
  `);
  console.log('Bonus: Catalog B services grouped by specialty_id');
  if (qB.rows.length === 0) {
    console.log('    (no Catalog B rows found)');
  } else {
    for (const r of qB.rows) {
      console.log(`    ${r.specialty_id.padEnd(28)} ${r.row_count} rows`);
    }
  }
  hr();

  console.log('Audit complete. No writes performed.');
}

main()
  .catch((err) => {
    console.error('Audit failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
