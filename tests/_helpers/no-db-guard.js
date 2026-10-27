// tests/_helpers/no-db-guard.js
//
// 2026-10-27 — preloaded (NODE_OPTIONS --require) into every test process when
// tests/run.js has decided the run has no usable database.
//
// Blanking DATABASE_URL is not enough on its own: 23 node:test files open their
// own pool with `process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa'`,
// so an empty URL falls through to a hard-coded local database. On a machine
// that has one, a "no database" run wrote fixtures into it (and the old runner's
// process.exit() skipped their cleanup); on CI, which has none, the same tests
// failed for a different reason. Either way the result depended on the machine.
//
// So in a no-database run every pg connection is refused, immediately and with
// the reason, and those tests fail the same way everywhere.

'use strict';

const reason = process.env.TEST_RUNNER_NO_DB;

if (reason) {
  let pg = null;
  try { pg = require('pg'); } catch (_) { /* no pg installed: nothing to guard */ }
  if (pg && pg.Client) {
    pg.Client.prototype.connect = function refuseConnect(callback) {
      const err = new Error('no-database test run — connections are refused (' + reason + ')');
      err.code = 'TEST_RUNNER_NO_DB';
      if (typeof callback === 'function') { process.nextTick(callback, err); return undefined; }
      return Promise.reject(err);
    };
  }
}
