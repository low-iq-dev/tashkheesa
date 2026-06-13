// tests/unit/ai_health.test.js
//
// Behaviour suite for src/services/ai_health.js (recordAiHealth + getAiHealth).
// The flag lives in admin_settings(key='ai_billing_status'). Key behaviours:
//   - a BILLING failure trips the flag and logs ONE loud warning (not per-call)
//   - a non-billing failure (429/timeout/500) is ignored — flag untouched
//   - recovery (a later success) clears the flag and logs once
//   - a success while already healthy writes nothing (no write amplification)
// Dependencies are injected via _setDepsForTests so no live DB/SDK is touched.

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🩺 AI health — recordAiHealth flag transitions\n');

const ai = require('../../src/services/ai_health');

const BILLING_ERR = { status: 400, message: 'Your credit balance is too low to access the Anthropic API.' };
const RATELIMIT_ERR = { status: 429, message: 'rate_limit_error' };

// Build an injected harness: queryOne returns a controllable flag row; execute
// records writes; loggers count calls.
function harness(initialFlag) {
  const state = {
    row: initialFlag ? { value: JSON.stringify(initialFlag) } : null,
    writes: [],
    fatal: 0,
    major: 0
  };
  ai._setDepsForTests({
    queryOne: async function () { return state.row; },
    execute: async function (sql, params) {
      // _writeFlag passes [key, valueJson, updatedAt] — the value is params[1].
      const val = JSON.parse(params[1]);
      state.writes.push(val);
      state.row = { value: params[1] }; // reflect the write for subsequent reads
      return { rowCount: 1 };
    },
    logFatal: function () { state.fatal++; },
    logMajor: function () { state.major++; }
  });
  return state;
}

async function run() {
  // 1. first billing failure → trips flag + ONE fatal log
  let s = harness({ ok: true });
  await ai.recordAiHealth(false, BILLING_ERR, { context: 'classify_job' });
  check('first billing failure trips the flag (ok:false written)', () => {
    assert.strictEqual(s.writes.length, 1);
    assert.strictEqual(s.writes[0].ok, false);
    assert.ok(s.writes[0].lastFailAt, 'lastFailAt set');
  });
  check('first billing failure logs exactly one fatal warning', () => {
    assert.strictEqual(s.fatal, 1);
  });

  // 2. second billing failure while already tripped → no repeat warning
  s = harness({ ok: false, lastFailAt: '2026-06-13T00:00:00Z' });
  await ai.recordAiHealth(false, BILLING_ERR, {});
  check('repeat billing failure does NOT re-log the warning', () => {
    assert.strictEqual(s.fatal, 0);
  });

  // 3. non-billing failure → flag untouched, nothing written/logged
  s = harness({ ok: true });
  await ai.recordAiHealth(false, RATELIMIT_ERR, {});
  check('a 429 rate-limit does NOT trip the billing flag', () => {
    assert.strictEqual(s.writes.length, 0);
    assert.strictEqual(s.fatal, 0);
  });

  // 4. recovery: success after a tripped flag → clears + logs once
  s = harness({ ok: false, lastFailAt: '2026-06-13T00:00:00Z' });
  await ai.recordAiHealth(true);
  check('success after outage clears the flag (ok:true written)', () => {
    assert.strictEqual(s.writes.length, 1);
    assert.strictEqual(s.writes[0].ok, true);
  });
  check('recovery logs once (major)', () => {
    assert.strictEqual(s.major, 1);
  });

  // 5. success while already healthy → no write (no amplification)
  s = harness({ ok: true });
  await ai.recordAiHealth(true);
  check('success while already healthy writes nothing', () => {
    assert.strictEqual(s.writes.length, 0);
  });

  // 6. never throws on bad input
  s = harness({ ok: true });
  check('recordAiHealth(false, null) does not throw', () => {
    return ai.recordAiHealth(false, null);
  });

  ai._resetDepsForTests();
}

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { r.then(() => t.pass(name)).catch((e) => t.fail(name, e)); }
    else t.pass(name);
  } catch (e) { t.fail(name, e); }
}

run().catch((e) => t.fail('ai_health suite', e));
