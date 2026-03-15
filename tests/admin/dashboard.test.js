// LEGACY TEST — was written for SQLite. Skipped until rewritten for PostgreSQL.
// See tests/pg/ for new PG-compatible tests.
if (typeof global._testRunner !== 'undefined') {
  global._testRunner.skip(require('path').basename(__filename, '.test.js'), 'SQLite legacy — rewrite pending');
}
