// tests/unit/step3-defaults.test.js
//
// Regression guard for the Step-3 specialty/service default computation
// (src/helpers/step3_defaults.js) — the logic that decides what the hidden
// specialty_id / service_id inputs are pre-filled with, which in turn decides
// whether the "Continue with <recommended>" accept button is enabled.
//
// Covers BOTH wizard paths so they can't break each other again:
//   ACCEPT  — locked/auto/recommend tiers MUST pre-fill the AI pick so the
//             Continue button enables and the accept path advances. (The bug:
//             only `locked` pre-filled, leaving auto/recommend Continue dead.)
//   OVERRIDE/manual — manual / no-rec / cleared-selection MUST fall back to the
//             draft selection (empty until the patient picks from the grid), so
//             accepting can't silently submit a stale AI pick on those paths.

'use strict';

const assert = require('assert');
const { step3Defaults } = require('../../src/helpers/step3_defaults');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

console.log('\n🧭 Step-3 specialty/service default computation (accept + override paths)\n');

var REC_SPEC = 'spec-cardiology';
var REC_SVC = 'card_echo';

// ── ACCEPT path: every accept tier pre-fills the AI pick → Continue enables ──
['locked', 'auto', 'recommend'].forEach(function (tier) {
  check('accept tier "' + tier + '" pre-fills the recommended specialty + service', function () {
    var d = step3Defaults(tier, REC_SPEC, REC_SVC, '', '');
    assert.strictEqual(d.specialty, REC_SPEC);
    assert.strictEqual(d.service, REC_SVC);
    // Continue is enabled iff both are set (updateContinue contract).
    assert.ok(d.specialty && d.service, 'both set → Continue enabled');
  });
});

// This is the exact regression: gating the pre-fill to `locked` left auto/
// recommend with empty inputs → disabled Continue. Guard against reverting.
check('auto/recommend are NOT treated like a grid tier (would re-break accept)', function () {
  assert.ok(step3Defaults('auto', REC_SPEC, REC_SVC, '', '').service, 'auto must pre-fill service');
  assert.ok(step3Defaults('recommend', REC_SPEC, REC_SVC, '', '').service, 'recommend must pre-fill service');
});

// ── OVERRIDE / manual / no-rec: fall back to the draft selection ──
check('manual tier falls back to the patient draft selection (grid flow)', function () {
  var d = step3Defaults('manual', REC_SPEC, REC_SVC, 'spec-gastro', 'gastro_svc');
  assert.strictEqual(d.specialty, 'spec-gastro');
  assert.strictEqual(d.service, 'gastro_svc');
});

check('manual tier with no draft selection → empty (Continue disabled until pick)', function () {
  var d = step3Defaults('manual', REC_SPEC, REC_SVC, '', '');
  assert.strictEqual(d.specialty, '');
  assert.strictEqual(d.service, '');
  assert.ok(!(d.specialty && d.service), 'empty → Continue disabled');
});

check('no-recommendation tier (null) → draft selection only', function () {
  var d = step3Defaults(null, null, null, 'spec-x', 'svc-x');
  assert.strictEqual(d.specialty, 'spec-x');
  assert.strictEqual(d.service, 'svc-x');
});

check('cleared selection after override → empty (Continue disabled until re-pick)', function () {
  // The override-confirm handler clears the inputs; a re-render with an empty
  // draft selection on a non-accept state must yield empty defaults.
  var d = step3Defaults('manual', null, null, '', '');
  assert.strictEqual(d.specialty, '');
  assert.strictEqual(d.service, '');
});

check('accept tier but recommendation missing service → service empty (no false enable)', function () {
  var d = step3Defaults('recommend', REC_SPEC, null, '', '');
  assert.strictEqual(d.specialty, REC_SPEC);
  assert.strictEqual(d.service, '');
  assert.ok(!(d.specialty && d.service), 'missing rec service → Continue stays disabled');
});
