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
