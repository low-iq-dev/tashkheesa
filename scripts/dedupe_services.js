#!/usr/bin/env node
// scripts/dedupe_services.js
// Removes duplicate rows from the services table caused by
// src/seed_specialties.js using randomUUID() + ON CONFLICT DO NOTHING
// (with no conflict target) on every boot prior to the fix.
//
// Usage:
//   Dry-run (default — no writes):
//     DATABASE_URL=<prod-url> PG_SSL=true node scripts/dedupe_services.js --dry-run
//   Live (deletes loser rows in a single transaction):
//     DATABASE_URL=<prod-url> PG_SSL=true node scripts/dedupe_services.js --live
//
// Winner-selection rule for each (specialty_id, name) duplicate group:
//   1. Row with the most references in orders.service_id.
//   2. If tied, lexicographically smallest id.
//
// (The original spec also mentioned "lowest created_at" as the primary key,
// but the services table has no created_at column — confirmed in the audit.)
//
// Pre-audit confirmed Q4 = 0: zero orders reference duplicate-group service IDs.
// The script still computes order_refs per id for safety — if any references
// exist, the most-referenced row wins. Otherwise lex-smallest id wins.
// No orders.service_id rewrites are performed; only DELETE FROM services.

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

  // Pull every duplicate group with each id's order_refs in one query.
  // Result rows: { specialty_id, name, id, order_refs } sorted so the winner
  // for each group is the FIRST row in the group (most refs DESC, then id ASC).
  const sql = `
    WITH dup_groups AS (
      SELECT specialty_id, name
      FROM services
      GROUP BY specialty_id, name
      HAVING COUNT(*) > 1
    )
    SELECT
      s.specialty_id,
      s.name,
      s.id,
      COALESCE(o.refs, 0)::int AS order_refs
    FROM services s
    JOIN dup_groups d
      ON d.specialty_id = s.specialty_id AND d.name = s.name
    LEFT JOIN (
      SELECT service_id, COUNT(*)::int AS refs
      FROM orders
      WHERE service_id IS NOT NULL
      GROUP BY service_id
    ) o ON o.service_id = s.id
    ORDER BY s.specialty_id, s.name, COALESCE(o.refs, 0) DESC, s.id ASC
  `;
  const { rows } = await pool.query(sql);

  if (rows.length === 0) {
    console.log('No duplicate groups found. Nothing to do.');
    return;
  }

  // Bucket rows by (specialty_id, name); first row per bucket = winner.
  const groups = new Map();
  for (const r of rows) {
    const key = r.specialty_id + '\x00' + r.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const losers = [];
  let totalRefsOnLosers = 0;

  console.log(`Found ${groups.size} duplicate groups across ${rows.length} rows.`);
  hr();
  console.log('Plan per group (winner first, losers below):');
  hr();

  let groupIdx = 0;
  for (const [, members] of groups) {
    groupIdx++;
    const [winner, ...rest] = members;
    console.log(`[${groupIdx}/${groups.size}] ${winner.specialty_id}  /  ${winner.name}`);
    console.log(`    KEEP   id=${winner.id}  refs=${winner.order_refs}`);
    for (const loser of rest) {
      console.log(`    DELETE id=${loser.id}  refs=${loser.order_refs}`);
      losers.push(loser.id);
      totalRefsOnLosers += loser.order_refs;
    }
  }
  hr();

  // Safety check — pre-audit said this should be 0.
  if (totalRefsOnLosers > 0) {
    console.log(`SAFETY ABORT: losers have ${totalRefsOnLosers} order references total.`);
    console.log('The pre-audit reported Q4 = 0. State has changed since the audit.');
    console.log('This script does NOT rewrite orders.service_id — re-run audit and revise plan.');
    process.exitCode = 2;
    return;
  }

  console.log('Summary:');
  console.log('    Mode:                 ', isDryRun ? 'DRY-RUN — no changes made' : 'LIVE — will execute');
  console.log('    Duplicate groups:     ', groups.size);
  console.log('    Loser rows to delete: ', losers.length);
  console.log('    Order rows to re-point:', 0, '(no losers have order references)');
  hr();

  if (isDryRun) {
    console.log('Dry-run complete. Re-run with --live to execute.');
    return;
  }

  // LIVE: single transaction, all-or-nothing
  console.log('Executing DELETE in a single transaction...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-verify under transaction that no orders reference any loser id.
    // (Defensive — covers race where an order is placed against a loser
    // between the SELECT above and the DELETE below.)
    const recheck = await client.query(
      'SELECT COUNT(*)::int AS refs FROM orders WHERE service_id = ANY($1)',
      [losers]
    );
    if (recheck.rows[0].refs > 0) {
      throw new Error(
        `Race detected: ${recheck.rows[0].refs} order(s) now reference loser IDs. Aborting.`
      );
    }

    const del = await client.query(
      'DELETE FROM services WHERE id = ANY($1)',
      [losers]
    );

    if (del.rowCount !== losers.length) {
      throw new Error(
        `DELETE rowCount mismatch: expected ${losers.length}, got ${del.rowCount}. Aborting.`
      );
    }

    await client.query('COMMIT');
    console.log(`Deleted ${del.rowCount} rows.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('TRANSACTION ROLLED BACK:', err.message);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  // Post-check
  const post = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM services) AS total,
      (SELECT COUNT(*)::int FROM (SELECT DISTINCT specialty_id, name FROM services) t) AS distinct_pairs,
      (SELECT COUNT(*)::int FROM (
         SELECT 1 FROM services GROUP BY specialty_id, name HAVING COUNT(*) > 1
       ) t) AS remaining_dup_groups
  `);
  hr();
  console.log('Post-dedupe state:', post.rows[0]);
  if (post.rows[0].remaining_dup_groups === 0) {
    console.log('OK — services table is duplicate-free.');
  } else {
    console.log('WARNING — duplicate groups still present. Investigate before adding UNIQUE constraint.');
  }
}

main()
  .catch((err) => {
    console.error('Dedupe failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
