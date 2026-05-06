// tests/core/migration-runner-self-sufficient.test.js
//
// Theme 1 — cross-cutting test from THEME_01_SCHEMA_DRIFT_FIX_PLAN.md §6.
//
// Goal: prove the migration runner alone (`src/db.js#migrate`) produces
// a complete schema — every column, table, and index that the
// application reads or writes — without needing the deleted parallel
// boot path (src/migrate_mobile_api.js).
//
// Why it's skipped: a faithful implementation needs an isolated
// throwaway Postgres (testcontainers, pg-mem, or a per-test database).
// None of those are wired into this project today, and adding them is
// out of scope for Theme 1.
//
// What "running it for real" would do:
//   1. Spin up a clean Postgres (no schema_migrations rows).
//   2. Set DATABASE_URL to that instance.
//   3. Call migrate() once.
//   4. Snapshot information_schema.columns / pg_class / pg_indexes.
//   5. Diff against an expected fixture committed in tests/fixtures/.
//   6. Assert the snapshot is a strict superset of every column the
//      mobile API + portal reads (sampled by grepping FROM orders,
//      INSERT INTO orders, etc.).
//
// Until that's wired, the lighter-weight tests in this directory cover
// the same surface from different angles:
//   * no-mobile-api-boot-script.test.js  — the parallel script is gone.
//   * orders-active-view.test.js         — the VIEW migration applies.
//   * orders-table-readers-allowlist.test.js — every read uses the VIEW
//                                              or filters explicitly.

'use strict';

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🏗️  migration runner is self-sufficient (Theme 1, cross-cutting)\n');

t.skip(
  'fresh-DB migration completeness',
  'requires testcontainers/pg-mem (out of scope for Theme 1); covered indirectly by no-mobile-api-boot-script + orders-active-view + orders-table-readers-allowlist'
);
