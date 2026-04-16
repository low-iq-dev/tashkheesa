#!/usr/bin/env node
// scripts/audit_services.js
// Read-only audit of the services table to size up the duplicate-row problem
// caused by src/seed_specialties.js using randomUUID() + ON CONFLICT DO NOTHING
// (with no conflict target) on every boot.
//
// Usage:
//   DATABASE_URL=<prod-url> PG_SSL=true node scripts/audit_services.js
//
// Performs no writes. Safe to run against production.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  console.error('Run with: DATABASE_URL=<prod-url> PG_SSL=true node scripts/audit_services.js');
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
  // Show what we're connected to (host only — no creds)
  const dbInfo = await pool.query(
    "SELECT current_database() AS db, inet_server_addr()::text AS host, current_user AS usr"
  );
  hr();
  console.log('Connected to:', dbInfo.rows[0]);
  hr();

  // Detect whether services has a created_at column — Step 2 dedupe needs to know
  const colsRes = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'services' ORDER BY ordinal_position"
  );
  const cols = colsRes.rows.map(r => r.column_name);
  console.log('services columns:', cols.join(', '));
  console.log('has created_at?', cols.includes('created_at'));
  hr();

  // Q1 — total services
  const q1 = await pool.query('SELECT COUNT(*)::int AS total FROM services');
  console.log('Q1: total services rows =', q1.rows[0].total);
  hr();

  // Q2 — distinct (specialty_id, name) pairs
  const q2 = await pool.query(
    'SELECT COUNT(*)::int AS distinct_pairs FROM (SELECT DISTINCT specialty_id, name FROM services) t'
  );
  console.log('Q2: distinct (specialty_id, name) pairs =', q2.rows[0].distinct_pairs);
  console.log('    expected (per seed_specialties.js) ≈ 46 services across 16 specialties');
  hr();

  // Q3 — top 20 worst-offending duplicate groups
  const q3 = await pool.query(`
    SELECT specialty_id, name, COUNT(*)::int AS copies, array_agg(id) AS ids
    FROM services
    GROUP BY specialty_id, name
    HAVING COUNT(*) > 1
    ORDER BY copies DESC, specialty_id, name
    LIMIT 20
  `);
  console.log('Q3: top 20 duplicate groups (specialty_id, name, copies)');
  if (q3.rows.length === 0) {
    console.log('    (no duplicate groups found)');
  } else {
    for (const r of q3.rows) {
      console.log(`    ${r.copies.toString().padStart(4)}  ${r.specialty_id.padEnd(28)}  ${r.name}`);
      console.log(`          ids[0..2]=${r.ids.slice(0, 3).join(', ')}${r.ids.length > 3 ? ` ... (+${r.ids.length - 3} more)` : ''}`);
    }
  }
  hr();

  // Q3b — total duplicate groups (not just top 20) and total loser-rows that would be deleted
  const q3b = await pool.query(`
    SELECT
      COUNT(*)::int AS dup_groups,
      COALESCE(SUM(copies - 1), 0)::int AS losers_to_delete
    FROM (
      SELECT COUNT(*) AS copies
      FROM services
      GROUP BY specialty_id, name
      HAVING COUNT(*) > 1
    ) t
  `);
  console.log('Q3b: dedupe-impact summary');
  console.log('    duplicate groups total =', q3b.rows[0].dup_groups);
  console.log('    rows that would be deleted (losers) =', q3b.rows[0].losers_to_delete);
  hr();

  // Q4 — orders pointing at a service_id that has duplicates
  const q4 = await pool.query(`
    SELECT COUNT(*)::int AS orders_in_dup_groups
    FROM orders o
    WHERE o.service_id IN (
      SELECT id FROM services s
      WHERE EXISTS (
        SELECT 1 FROM services s2
        WHERE s2.specialty_id = s.specialty_id
          AND s2.name = s.name
          AND s2.id != s.id
      )
    )
  `);
  console.log('Q4: orders rows referencing a service_id inside a duplicate group =',
    q4.rows[0].orders_in_dup_groups);
  hr();

  // Q5 — per-loser order references (only meaningful if Q4 > 0)
  // For each duplicate group, count orders.service_id references per id.
  // This previews how disruptive Step 2's "re-point orders to winner" will be.
  const q5 = await pool.query(`
    WITH dup_groups AS (
      SELECT specialty_id, name
      FROM services
      GROUP BY specialty_id, name
      HAVING COUNT(*) > 1
    ),
    dup_services AS (
      SELECT s.id, s.specialty_id, s.name
      FROM services s
      JOIN dup_groups d ON d.specialty_id = s.specialty_id AND d.name = s.name
    )
    SELECT ds.specialty_id, ds.name, ds.id AS service_id, COUNT(o.id)::int AS order_refs
    FROM dup_services ds
    LEFT JOIN orders o ON o.service_id = ds.id
    GROUP BY ds.specialty_id, ds.name, ds.id
    HAVING COUNT(o.id) > 0
    ORDER BY order_refs DESC
    LIMIT 20
  `);
  console.log('Q5: top 20 referenced service IDs inside duplicate groups');
  if (q5.rows.length === 0) {
    console.log('    (no duplicate-group services have order references — orders only point at "winners")');
  } else {
    for (const r of q5.rows) {
      console.log(`    refs=${r.order_refs.toString().padStart(5)}  ${r.specialty_id.padEnd(28)}  ${r.name}`);
      console.log(`          service_id=${r.service_id}`);
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
