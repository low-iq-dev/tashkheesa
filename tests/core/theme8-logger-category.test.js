// tests/core/theme8-logger-category.test.js
//
// Theme 8 Phase 1 regression guard — `logErrorToDb` must populate the
// `category` column added by migration 035.
//
// Pre-fix, src/logger.js:136-140 issued a 10-column INSERT that omitted
// `category`. Every caller routing through `logErrorToDb()` therefore
// wrote category=NULL regardless of what they passed in `context.category`
// (the field was just stuffed into the `context` JSON blob, not the
// column). Migration 035's partial index `idx_error_logs_category` was
// unused for ~99% of rows and the /ops/errors filter-by-category yielded
// no results.
//
// Phase 1 of the Theme 8 fix plan pulls `context.category` into its own
// INSERT parameter so the column is populated and the JSON context no
// longer carries a redundant key.
//
// This test injects a fake pg module via the require cache, calls
// `logErrorToDb` with various inputs, and asserts on the captured SQL
// + params. No real DB, no server boot.
//
// Assertions:
//   1. SQL literal includes the `category` column name.
//   2. SQL literal has 11 placeholders ($1..$11), not 10.
//   3. `context.category = 'foo'` → param-4 (category) === 'foo'.
//   4. No `category` key passed in context → param-4 === null.
//   5. Synthetic Error (no `message` field) writes a row without crashing
//      and still carries category=null gracefully.
//   6. `context.category` is stripped from the JSON `context` blob (it
//      lives in its own column now; storing it twice is wasted bytes
//      and a source of drift).

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📝 Theme 8 Phase 1 — logErrorToDb populates error_logs.category\n');

(async function run() {
  // ── Inject a fake `./pg` module into the require cache ────────────────
  //
  // logger.js does `require('./pg')` lazily inside `logErrorToDb`. By
  // pre-populating the cache with a stub before the first call, we
  // capture every INSERT issued without hitting Postgres.
  //
  // Path resolution: logger.js lives at src/logger.js, so its
  // require('./pg') resolves to src/pg.js.
  const PG_PATH = require.resolve('../../src/pg.js');
  const LOGGER_PATH = require.resolve('../../src/logger.js');

  const captured = [];
  const fakePg = {
    // logger.js calls queryOne first (table-exists guard). Return a truthy
    // row so the INSERT path is exercised.
    queryOne: async function (_sql, _params) {
      return { tablename: 'error_logs' };
    },
    execute: async function (sql, params) {
      captured.push({ sql: String(sql), params: params || [] });
      return { rowCount: 1 };
    },
    // Methods we don't use, but kept for shape compatibility.
    queryAll: async function () { return []; },
    withTransaction: async function (fn) { return fn({}); },
    pool: null
  };

  // Stash any existing modules so we can restore for downstream tests.
  const savedPg = require.cache[PG_PATH];
  const savedLogger = require.cache[LOGGER_PATH];

  // Force a fresh logger require so its lazy `require('./pg')` picks up
  // the stub (the cache lookup happens inside the function, so this
  // technically isn't required — but resetting is safer if a previous
  // test in the suite already required logger AND pg).
  delete require.cache[LOGGER_PATH];
  require.cache[PG_PATH] = {
    id: PG_PATH,
    filename: PG_PATH,
    loaded: true,
    exports: fakePg
  };

  const logger = require('../../src/logger.js');

  function assert(cond, label, detail) {
    if (cond) t.pass(fileTag + ': ' + label);
    else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
  }

  function lastInsert() {
    // Filter to actual INSERTs (the table-exists guard goes through
    // queryOne, not execute, so captured[] only contains INSERTs — but
    // belt-and-braces in case logger.js evolves).
    const inserts = captured.filter(function (c) {
      return c.sql && c.sql.indexOf('INSERT INTO error_logs') !== -1;
    });
    return inserts.length ? inserts[inserts.length - 1] : null;
  }

  try {
    // ── 1 + 2. SQL shape: category column present, 11 placeholders ──────
    captured.length = 0;
    await logger.logErrorToDb(new Error('shape-test'), { category: 'shape_test' });
    const shapeRow = lastInsert();
    assert(!!shapeRow, 'INSERT INTO error_logs was issued at all',
      'captured=' + JSON.stringify(captured.map(function (c) { return (c.sql || '').slice(0, 60); })));
    if (shapeRow) {
      assert(/\bcategory\b/.test(shapeRow.sql),
        'SQL literal includes the `category` column name',
        'sql=' + shapeRow.sql);
      // Count placeholders by counting `$N` tokens. Should be 11.
      const placeholders = (shapeRow.sql.match(/\$\d+/g) || []).sort(function (a, b) {
        return Number(a.slice(1)) - Number(b.slice(1));
      });
      const maxIdx = placeholders.length
        ? Number(placeholders[placeholders.length - 1].slice(1))
        : 0;
      assert(maxIdx === 11,
        'SQL has 11 placeholders ($1..$11), not 10',
        'highest placeholder = $' + maxIdx + ' (full set: ' + placeholders.join(',') + ')');
      assert(shapeRow.params.length === 11,
        'params array has 11 entries (matches placeholder count)',
        'params.length = ' + shapeRow.params.length);
    }

    // ── 3. context.category='foo' → row has category='foo' ──────────────
    //
    // Column order from the INSERT statement:
    //   (id, error_id, level, category, message, stack, context,
    //    request_id, user_id, url, method)
    // → params[3] === category.
    captured.length = 0;
    await logger.logErrorToDb(new Error('cat-foo'), { category: 'foo' });
    const fooRow = lastInsert();
    assert(fooRow && fooRow.params[3] === 'foo',
      "context.category='foo' writes category='foo' (params[3])",
      'params[3] = ' + (fooRow ? JSON.stringify(fooRow.params[3]) : 'no row'));

    // ── 4. No category in context → category=null ───────────────────────
    captured.length = 0;
    await logger.logErrorToDb(new Error('no-cat'), {});
    const noCatRow = lastInsert();
    assert(noCatRow && noCatRow.params[3] === null,
      'omitted category writes NULL (defensive default)',
      'params[3] = ' + (noCatRow ? JSON.stringify(noCatRow.params[3]) : 'no row'));

    // ── 5. Synthetic non-Error first argument doesn't crash ─────────────
    //
    // logger.js builds the message via `err && err.message`, falling
    // through to `String(err || 'Unknown error')`. Passing a plain string
    // exercises the fallback path. We want to confirm the row still
    // writes (with category=null) and the function returns an errorId.
    captured.length = 0;
    const stringErrId = await logger.logErrorToDb('plain string thrown', {});
    const stringRow = lastInsert();
    assert(typeof stringErrId === 'string' && stringErrId.length > 0,
      'non-Error first arg still returns an errorId',
      'returned=' + JSON.stringify(stringErrId));
    assert(stringRow && stringRow.params[3] === null,
      'non-Error first arg writes a row with category=NULL',
      'params[3] = ' + (stringRow ? JSON.stringify(stringRow.params[3]) : 'no row'));
    // params[4] is the `message` column — should be the stringified arg.
    assert(stringRow && stringRow.params[4] === 'plain string thrown',
      'non-Error first arg writes the string into the message column',
      'params[4] = ' + (stringRow ? JSON.stringify(stringRow.params[4]) : 'no row'));

    // ── 6. context.category is NOT duplicated in the JSON context blob ──
    //
    // After Phase 1, category lives in its own column. Keeping it in the
    // JSON blob would (a) waste bytes, (b) drift if a caller updates one
    // and not the other, (c) muddy /ops/error-detail context view.
    //
    // params[6] is the `context` column (stringified JSON).
    captured.length = 0;
    await logger.logErrorToDb(new Error('strip-test'), {
      category: 'strip_check',
      orderId: 'ord_123',
      ticket: 'T-99'
    });
    const stripRow = lastInsert();
    if (stripRow) {
      let ctxBlob = null;
      try { ctxBlob = JSON.parse(stripRow.params[6] || '{}'); }
      catch (e) { ctxBlob = null; }
      assert(ctxBlob && !('category' in ctxBlob),
        'context.category is stripped from the JSON context blob',
        'blob = ' + stripRow.params[6]);
      // Other context fields must survive (regression guard against
      // over-eager skipKeys).
      assert(ctxBlob && ctxBlob.orderId === 'ord_123',
        'unrelated context fields (orderId) survive the strip',
        'blob = ' + stripRow.params[6]);
      assert(ctxBlob && ctxBlob.ticket === 'T-99',
        'unrelated context fields (ticket) survive the strip',
        'blob = ' + stripRow.params[6]);
    } else {
      t.fail(fileTag + ': strip-test row issued', new Error('no INSERT captured'));
    }

  } catch (err) {
    t.fail(fileTag + ': suite top-level threw', err);
  } finally {
    // ── Restore the require cache so downstream tests get the real pg ──
    if (savedPg) require.cache[PG_PATH] = savedPg;
    else         delete require.cache[PG_PATH];
    if (savedLogger) require.cache[LOGGER_PATH] = savedLogger;
    else             delete require.cache[LOGGER_PATH];
  }
})();
