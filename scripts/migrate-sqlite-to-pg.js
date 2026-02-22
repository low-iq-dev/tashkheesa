#!/usr/bin/env node
// scripts/migrate-sqlite-to-pg.js
// One-shot migration: copy all data from SQLite → PostgreSQL.
//
// Usage:
//   DATABASE_URL=postgres://... SQLITE_PATH=./portal.db node scripts/migrate-sqlite-to-pg.js
//
// Prerequisites:
//   - PostgreSQL database must exist and be accessible via DATABASE_URL
//   - SQLite database file must exist at SQLITE_PATH
//   - Run the app once first (or call migrate()) so PG tables are created
//   - npm install better-sqlite3   (temporary dev dependency for this script)

'use strict';

const path = require('path');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'portal.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  process.exit(1);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('ERROR: better-sqlite3 is required for migration.');
  console.error('Run: npm install better-sqlite3 --save-dev');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tables to migrate (in dependency order)
// ---------------------------------------------------------------------------
const TABLES = [
  'specialties',
  'users',
  'services',
  'service_regional_prices',
  'orders',
  'order_events',
  'order_files',
  'order_additional_files',
  'notifications',
  'cases',
  'case_files',
  'case_context',
  'case_events',
  'case_annotations',
  'doctor_assignments',
  'conversations',
  'messages',
  'prescriptions',
  'medical_records',
  'appointments',
  'appointment_slots',
  'appointment_payments',
  'video_calls',
  'doctor_availability',
  'doctor_earnings',
  'doctor_services',
  'reviews',
  'referral_codes',
  'referral_redemptions',
  'password_reset_tokens',
  'report_exports',
  'admin_settings',
  'error_logs',
  'email_campaigns',
  'campaign_recipients',
  'pre_launch_leads',
  'file_ai_checks',
  'chat_reports'
];

// Columns that store boolean values as INTEGER in SQLite (0/1)
// These need to be converted to proper PostgreSQL booleans
const BOOLEAN_COLUMNS = new Set([
  'is_active', 'is_visible', 'is_anonymous', 'admin_flagged',
  'is_read', 'is_booked', 'is_valid', 'is_hidden',
  'is_shared_with_doctors', 'urgency_flag', 'uploads_locked',
  'additional_files_requested', 'notify_whatsapp', 'pending_approval',
  'onboarding_complete', 'pre_breach_notified', 'sla_reminder_sent',
  'video_consultation_selected', 'sla_24hr_selected', 'is_medical_image',
  'matches_expected', 'sla_compliant', 'reminder_24h_sent',
  'reminder_1h_sent', 'reward_granted', 'email_marketing_opt_out'
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sqliteTableExists(sqliteDb, tableName) {
  const row = sqliteDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName);
  return !!row;
}

function getColumnNames(sqliteDb, tableName) {
  const cols = sqliteDb.prepare(`PRAGMA table_info('${tableName}')`).all();
  return cols.map(c => c.name);
}

function buildInsertSQL(tableName, columns) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const colList = columns.map(c => `"${c}"`).join(', ');
  return `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
}

function convertRow(row, columns) {
  return columns.map(col => {
    const val = row[col];
    if (val === undefined || val === null) return null;
    if (BOOLEAN_COLUMNS.has(col)) {
      return val === 1 || val === '1' || val === true;
    }
    return val;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== SQLite → PostgreSQL Migration ===\n');
  console.log(`SQLite:     ${SQLITE_PATH}`);
  console.log(`PostgreSQL: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}\n`);

  // Open SQLite
  let sqliteDb;
  try {
    sqliteDb = new Database(SQLITE_PATH, { readonly: true });
    console.log('SQLite database opened successfully.\n');
  } catch (e) {
    console.error(`ERROR: Cannot open SQLite database at ${SQLITE_PATH}`);
    console.error(e.message);
    process.exit(1);
  }

  // Open PostgreSQL
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5
  });

  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connection verified.\n');
  } catch (e) {
    console.error('ERROR: Cannot connect to PostgreSQL.');
    console.error(e.message);
    sqliteDb.close();
    process.exit(1);
  }

  const stats = { tables: 0, rows: 0, skipped: 0, errors: 0 };

  for (const tableName of TABLES) {
    // Check if table exists in SQLite
    if (!sqliteTableExists(sqliteDb, tableName)) {
      console.log(`  SKIP  ${tableName} (not in SQLite)`);
      stats.skipped++;
      continue;
    }

    // Check if table exists in PostgreSQL
    const pgCheck = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
      [tableName]
    );
    if (pgCheck.rows.length === 0) {
      console.log(`  SKIP  ${tableName} (not in PostgreSQL — run migrate() first)`);
      stats.skipped++;
      continue;
    }

    // Get columns from SQLite
    const sqliteCols = getColumnNames(sqliteDb, tableName);

    // Get columns from PostgreSQL
    const pgColResult = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'",
      [tableName]
    );
    const pgCols = new Set(pgColResult.rows.map(r => r.column_name));

    // Use intersection of columns (both SQLite and PG must have the column)
    const columns = sqliteCols.filter(c => pgCols.has(c));

    if (columns.length === 0) {
      console.log(`  SKIP  ${tableName} (no matching columns)`);
      stats.skipped++;
      continue;
    }

    // Read all rows from SQLite
    const colList = columns.map(c => `"${c}"`).join(', ');
    let rows;
    try {
      rows = sqliteDb.prepare(`SELECT ${colList} FROM "${tableName}"`).all();
    } catch (e) {
      console.error(`  ERROR reading ${tableName} from SQLite: ${e.message}`);
      stats.errors++;
      continue;
    }

    if (rows.length === 0) {
      console.log(`  EMPTY ${tableName} (0 rows)`);
      continue;
    }

    // Insert in batches using transactions
    const BATCH_SIZE = 100;
    const insertSQL = buildInsertSQL(tableName, columns);
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of batch) {
          const values = convertRow(row, columns);
          try {
            await client.query(insertSQL, values);
            inserted++;
          } catch (e) {
            // Skip individual row errors (e.g. duplicate keys)
            if (!e.message.includes('duplicate key')) {
              console.error(`    Row error in ${tableName}: ${e.message}`);
            }
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`    Batch error in ${tableName}: ${e.message}`);
        stats.errors++;
      } finally {
        client.release();
      }
    }

    console.log(`  OK    ${tableName}: ${inserted}/${rows.length} rows`);
    stats.tables++;
    stats.rows += inserted;
  }

  // Close connections
  sqliteDb.close();
  await pool.end();

  console.log('\n=== Migration Complete ===');
  console.log(`  Tables migrated: ${stats.tables}`);
  console.log(`  Total rows:      ${stats.rows}`);
  console.log(`  Tables skipped:  ${stats.skipped}`);
  console.log(`  Errors:          ${stats.errors}`);

  if (stats.errors > 0) {
    console.log('\nSome errors occurred. Check output above for details.');
    process.exit(1);
  }

  console.log('\nMigration completed successfully!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
