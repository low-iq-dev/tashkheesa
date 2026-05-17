// tests/unit/admin_settings.test.js
//
// Theme 14 Phase 4 piece 2 — unit suite for src/services/admin_settings.js.
//
// Uses the module's test seams (_setQueryAllForTests / _setErrorLoggerForTests
// / _setClockForTests / _resetForTests) so no DB or pg pool is touched. Each
// scenario calls _resetForTests() first to clear cache state and re-install
// the prod implementations before installing scenario-specific mocks.
//
// Coverage:
//   - Defaults match the hardcoded literals at patient_new_case.ejs:339-341
//     (the helper-swap commit must be behaviourally neutral)
//   - Happy path: getThreshold + getThresholds return parsed numeric values
//   - DB error: logged, defaults returned, wizard does NOT throw
//   - Malformed values (non-finite / out-of-range / negative / >1) are
//     logged + skipped; per-key default fills in
//   - Missing rows: per-key default fills in silently (no log)
//   - Cache: second call within TTL does NOT re-query DB
//   - TTL: call past expiry DOES re-query
//   - invalidateCache(): forces re-query on next call
//   - getThreshold(unknown_key) throws (programmer error, not a DB issue)

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🧭 Theme 14 Phase 4 — admin_settings helper contract\n');

const mod = require('../../src/services/admin_settings');
const {
  getThreshold,
  getThresholds,
  invalidateCache,
  DEFAULTS,
  CACHE_TTL_MS,
  _setQueryAllForTests,
  _setErrorLoggerForTests,
  _setClockForTests,
  _resetForTests
} = mod;

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

async function expectThrows(fn, labelPrefix, contains) {
  try {
    await fn();
    t.fail(fileTag + ': ' + labelPrefix, new Error('expected throw, got success'));
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (contains && !msg.includes(contains)) {
      t.fail(fileTag + ': ' + labelPrefix, new Error('threw but missing "' + contains + '" in: ' + msg));
    } else {
      t.pass(fileTag + ': ' + labelPrefix);
    }
  }
}

// Build a scripted queryAll mock that returns the given rows array.
// Records call count via the returned `calls` ref.
function makeQueryAllMock(rowsOrFn) {
  const state = { calls: 0, lastSql: null };
  const fn = async function (sql) {
    state.calls += 1;
    state.lastSql = sql;
    return typeof rowsOrFn === 'function' ? rowsOrFn() : rowsOrFn;
  };
  return { fn: fn, state: state };
}

// Build a scripted error-logger mock that records every call.
function makeLoggerMock() {
  const calls = [];
  return {
    calls: calls,
    fn: async function (err, ctx) { calls.push({ err: err, ctx: ctx }); }
  };
}

// All scenarios share module-level state (_cache, mock seams) so they MUST
// run sequentially in a single async IIFE. The async-IIFE-per-scenario
// pattern used elsewhere in this repo (see side issue #62) races on
// _cache and corrupts later assertions — manifested in initial development
// as the "missing row → default (lock)" assertion flapping and a TypeError
// at admin_settings.js:123 when one scenario nulled _cache mid-flight of
// another.

(async function runAll() {
  // ── 1. Defaults match the hardcoded literals being replaced ──────────
  assert(DEFAULTS.classifier_threshold_locked  === 0.95, 'DEFAULTS.locked  === 0.95 (matches patient_new_case.ejs:339)');
  assert(DEFAULTS.classifier_threshold_auto    === 0.85, 'DEFAULTS.auto    === 0.85 (matches patient_new_case.ejs:340)');
  assert(DEFAULTS.classifier_threshold_minimum === 0.55, 'DEFAULTS.minimum === 0.55 (matches patient_new_case.ejs:341)');
  assert(CACHE_TTL_MS === 60 * 1000, 'CACHE_TTL_MS === 60_000 (Ziad-locked TTL)');

  // ── 2. Happy path — getThreshold + getThresholds return parsed values
  _resetForTests();
  {
    const q = makeQueryAllMock([
      { key: 'classifier_threshold_locked',  value: '0.92' },
      { key: 'classifier_threshold_auto',    value: '0.80' },
      { key: 'classifier_threshold_minimum', value: '0.50' }
    ]);
    _setQueryAllForTests(q.fn);
    const lock = await getThreshold('classifier_threshold_locked');
    const auto = await getThreshold('classifier_threshold_auto');
    const min  = await getThreshold('classifier_threshold_minimum');
    assert(lock === 0.92, 'getThreshold(locked) returns DB value 0.92');
    assert(auto === 0.80, 'getThreshold(auto)   returns DB value 0.80');
    assert(min  === 0.50, 'getThreshold(min)    returns DB value 0.50');
    const all = await getThresholds();
    assert(all.lock === 0.92 && all.auto === 0.80 && all.min === 0.50,
      'getThresholds() returns the {lock, auto, min} shape with DB values');
  }

  // ── 3. DB error — logged, defaults returned, no throw ────────────────
  _resetForTests();
  {
    const dbErr = new Error('connection terminated unexpectedly');
    _setQueryAllForTests(async function () { throw dbErr; });
    const log = makeLoggerMock();
    _setErrorLoggerForTests(log.fn);
    const all = await getThresholds();
    assert(all.lock === DEFAULTS.classifier_threshold_locked, 'DB error → lock falls back to default');
    assert(all.auto === DEFAULTS.classifier_threshold_auto,   'DB error → auto falls back to default');
    assert(all.min  === DEFAULTS.classifier_threshold_minimum,'DB error → min  falls back to default');
    assert(log.calls.length === 1, 'DB error logged exactly once');
    assert(log.calls[0].err === dbErr, 'logger received the original Error');
    assert(log.calls[0].ctx && log.calls[0].ctx.category === 'admin_settings',
      'logger context has category="admin_settings"');
  }

  // ── 4. Malformed values are logged + skipped; defaults fill in ───────
  _resetForTests();
  {
    _setQueryAllForTests((makeQueryAllMock([
      { key: 'classifier_threshold_locked',  value: 'not-a-number' },  // NaN
      { key: 'classifier_threshold_auto',    value: '1.5' },            // out of range
      { key: 'classifier_threshold_minimum', value: '0.45' }            // valid
    ])).fn);
    const log = makeLoggerMock();
    _setErrorLoggerForTests(log.fn);
    const all = await getThresholds();
    assert(all.lock === DEFAULTS.classifier_threshold_locked, 'malformed (NaN) → fall back to default');
    assert(all.auto === DEFAULTS.classifier_threshold_auto,   'malformed (>1) → fall back to default');
    assert(all.min  === 0.45,                                  'valid row coexists with malformed rows');
    assert(log.calls.length === 2, 'two malformed rows → two log entries');
  }

  // ── 5. Negative value also rejected ──────────────────────────────────
  _resetForTests();
  {
    _setQueryAllForTests((makeQueryAllMock([
      { key: 'classifier_threshold_locked', value: '-0.1' }
    ])).fn);
    const log = makeLoggerMock();
    _setErrorLoggerForTests(log.fn);
    const lock = await getThreshold('classifier_threshold_locked');
    assert(lock === DEFAULTS.classifier_threshold_locked, 'negative value → fall back to default');
    assert(log.calls.length === 1, 'negative value triggers one log entry');
  }

  // ── 6. Missing rows fall back silently (no log) ──────────────────────
  _resetForTests();
  {
    _setQueryAllForTests((makeQueryAllMock([])).fn);          // zero rows
    const log = makeLoggerMock();
    _setErrorLoggerForTests(log.fn);
    const all = await getThresholds();
    assert(all.lock === DEFAULTS.classifier_threshold_locked, 'missing row → default (lock)');
    assert(all.auto === DEFAULTS.classifier_threshold_auto,   'missing row → default (auto)');
    assert(all.min  === DEFAULTS.classifier_threshold_minimum,'missing row → default (min)');
    assert(log.calls.length === 0, 'missing rows do NOT log — silent fallback');
  }

  // ── 7. Cache — second call within TTL does NOT re-query ──────────────
  _resetForTests();
  {
    const q = makeQueryAllMock([{ key: 'classifier_threshold_locked', value: '0.91' }]);
    _setQueryAllForTests(q.fn);
    let now = 1000;
    _setClockForTests(function () { return now; });
    await getThresholds();   // first call — DB hit
    await getThresholds();   // second call — should be cache hit
    await getThreshold('classifier_threshold_auto');  // also cache hit
    assert(q.state.calls === 1, 'TTL-window cache: only 1 DB query for 3 reads');
  }

  // ── 8. TTL — call past expiry DOES re-query ──────────────────────────
  _resetForTests();
  {
    const q = makeQueryAllMock([{ key: 'classifier_threshold_locked', value: '0.91' }]);
    _setQueryAllForTests(q.fn);
    let now = 1000;
    _setClockForTests(function () { return now; });
    await getThresholds();                  // t=1000 — DB hit #1
    now = 1000 + CACHE_TTL_MS + 1;          // jump 60.001s
    await getThresholds();                  // expired — DB hit #2
    assert(q.state.calls === 2, 'past-TTL call re-queries DB (1 + 1 = 2 hits)');
  }

  // ── 9. invalidateCache() forces re-query on next call ────────────────
  _resetForTests();
  {
    const q = makeQueryAllMock([{ key: 'classifier_threshold_locked', value: '0.91' }]);
    _setQueryAllForTests(q.fn);
    await getThresholds();   // DB hit #1
    await getThresholds();   // cache hit
    invalidateCache();
    await getThresholds();   // DB hit #2 (cache cleared)
    assert(q.state.calls === 2, 'invalidateCache() forces re-query on next call');
  }

  // ── 10. getThreshold(unknown_key) throws ─────────────────────────────
  _resetForTests();
  await expectThrows(
    function () { return getThreshold('not_a_real_key'); },
    'getThreshold rejects unknown keys',
    'unknown key'
  );

  // ── Cleanup so subsequent test files boot with prod impls ────────────
  _resetForTests();
})().catch(function (err) {
  t.fail(fileTag + ': runAll crashed', err);
});
